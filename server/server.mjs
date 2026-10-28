import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getConfig, getLiveTestToken, getModelApiKey, loadRootEnv } from "./config.mjs";
import { errors, PublicError } from "./errors.mjs";
import { assertLiveAllowed, createLiveLimiter } from "./liveGate.mjs";
import { buildMetaRequest, sendToMeta } from "./metaClient.mjs";
import { extractWithMock } from "./mockExtractor.mjs";
import { isValidCurrencyCode } from "./money.mjs";
import { validateExtraction } from "./validateExtraction.mjs";
import {
  decodeBase64Image,
  MAX_BODY_BYTES,
  validateImageBuffer,
} from "./validateUpload.mjs";

const RECORD_TYPES = ["expenses", "sales", "salaries", "financial records"];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** Read the request body with a hard size cap enforced while streaming. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(errors.requestTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(errors.invalidRequest()));
  });
}

async function handleExtract(req, res, { config, liveLimiter, fetchImpl }) {
  if (!req.headers["content-type"]?.includes("application/json")) {
    throw errors.invalidRequest();
  }
  const bodyBuffer = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    throw errors.invalidRequest();
  }

  const expectedCurrency =
    typeof payload.expectedCurrency === "string"
      ? payload.expectedCurrency.toUpperCase()
      : "PHP";
  if (!isValidCurrencyCode(expectedCurrency)) throw errors.invalidCurrency();

  const recordType = RECORD_TYPES.includes(payload.recordType)
    ? payload.recordType
    : "financial records";

  const imageBuffer = decodeBase64Image(payload.imageBase64);
  if (!imageBuffer) throw errors.unsupportedImage();
  // Image lives only in this buffer for the duration of the request.
  const { mediaType } = validateImageBuffer(imageBuffer, payload.mediaType);

  if (payload.mode === "live") {
    // Gated live path (M1B): all three authorizations are required,
    // then the per-session limiter counts this single attempt.
    assertLiveAllowed({
      liveMetaEnabled: config.liveMetaEnabled,
      modelApiKey: getModelApiKey(),
      liveTestToken: getLiveTestToken(),
      requestToken: req.headers["x-bucketa-live-test"],
    });
    liveLimiter.consume();
    const request = buildMetaRequest({
      imageBase64: payload.imageBase64,
      mediaType,
      expectedCurrency,
      recordType,
      apiKey: getModelApiKey(),
    });
    const raw = await sendToMeta(request, fetchImpl);
    const result = validateExtraction(raw, expectedCurrency);
    sendJson(res, 200, {
      mode: "live",
      recordType,
      liveRequestsUsed: liveLimiter.used,
      ...result,
    });
    return;
  }

  const raw = extractWithMock(expectedCurrency);
  const result = validateExtraction(raw, expectedCurrency);
  sendJson(res, 200, { mode: "mock", recordType, ...result });
}

export function createAppServer(config = getConfig(), deps = {}) {
  const liveLimiter = deps.liveLimiter ?? createLiveLimiter();
  const fetchImpl = deps.fetchImpl ?? fetch;
  return createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    let entryCount = 0;
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        status = 200;
        sendJson(res, status, {
          ok: true,
          mode: "mock",
          defaultMode: "mock",
          modelApiKeyConfigured: config.modelApiKeyConfigured,
          liveMeta:
            config.liveMetaEnabled && config.modelApiKeyConfigured && config.liveTestTokenConfigured
              ? "enabled-gated"
              : "disabled",
          liveRequestsUsed: liveLimiter.used,
          liveRequestsLimit: 3,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/extract") {
        await handleExtract(req, res, { config, liveLimiter, fetchImpl });
        status = 200;
        return;
      }
      throw errors.notFound();
    } catch (err) {
      if (err instanceof PublicError) {
        status = err.status;
        sendJson(res, status, { error: err.code, message: err.message });
      } else {
        status = 500;
        sendJson(res, 500, {
          error: "internal_error",
          message: "Something went wrong on the server.",
        });
      }
    } finally {
      // Logs never contain images, request bodies, model output, or secrets.
      console.log(
        `${req.method} ${req.url} -> ${status} (${Date.now() - started}ms, entries=${entryCount})`,
      );
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadRootEnv();
  const config = getConfig();
  const server = createAppServer(config);
  server.listen(config.port, config.host, () => {
    console.log(
      `Bucketa server listening on http://${config.host}:${config.port} (defaultMode=mock, liveMetaEnabled=${config.liveMetaEnabled}, modelApiKeyConfigured=${config.modelApiKeyConfigured})`,
    );
  });
}
