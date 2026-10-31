import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getConfig, getLiveTestToken, getModelApiKey, loadRootEnv } from "./config.mjs";
import { errors, PublicError } from "./errors.mjs";
import { assertLiveAllowed, createLiveLimiter } from "./liveGate.mjs";
import { buildMetaAdviceRequest, buildMetaRequest, META_MODEL_ID, sendMetaAdvice, sendToMeta } from "./metaClient.mjs";
import { MetaDiagnosticError, metaDiagnosticLogLine, safeMetaDiagnostic } from "./metaDiagnostics.mjs";
import {
  BUCKY_ADVICE_MAX_BODY_BYTES,
  buildDeterministicAdvice,
  buildVerifiedEvidence,
  validateAdviceRequest,
  validateModelAdvice,
} from "./buckyAdvice.mjs";
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

/**
 * Read the request body with a hard size cap enforced while streaming.
 * Callers pass their route's own limit so small JSON endpoints never
 * buffer scanner-sized bodies.
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering immediately, but keep draining the stream so
        // the client can finish sending and still receive the safe 413
        // response (destroying the socket here would prevent that).
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(errors.requestTooLarge());
      else resolve(Buffer.concat(chunks));
    });
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
    return result.entries.length;
  }

  const raw = extractWithMock(expectedCurrency);
  const result = validateExtraction(raw, expectedCurrency);
  sendJson(res, 200, { mode: "mock", recordType, ...result });
  return result.entries.length;
}

/**
 * POST /api/bucky/advise — Bucky Agent 1.0.
 * Default: deterministic fallback computed in code from the strictly
 * validated aggregated summary (always labelled source:
 * "deterministic-fallback"). Live Meta reasoning only when mode:"live"
 * AND all live gates pass AND the session limiter allows it; model
 * output is validated (allowlisted actions, grounded numbers) and any
 * failure falls back deterministically with a warning — never silently.
 * Evidence in every response is computed server-side, never model-made.
 */
async function handleBuckyAdvise(req, res, { config, liveLimiter, fetchImpl }) {
  if (!req.headers["content-type"]?.includes("application/json")) {
    throw errors.invalidRequest();
  }
  // Bucky's 16 KB cap is enforced by the streaming reader itself, so an
  // oversized advice request is rejected without being fully buffered.
  const bodyBuffer = await readBody(req, BUCKY_ADVICE_MAX_BODY_BYTES);
  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    throw errors.invalidRequest();
  }
  const validated = validateAdviceRequest(payload);
  const fallback = buildDeterministicAdvice(validated);
  const evidence = buildVerifiedEvidence(validated.summary);

  if (validated.mode !== "live") {
    sendJson(res, 200, { source: "deterministic-fallback", model: null, ...fallback, evidence });
    return;
  }

  // Live path: same gates and single-attempt limiter as the scanner.
  // Gate failures are errors (never a silent downgrade of a live request).
  assertLiveAllowed({
    liveMetaEnabled: config.liveMetaEnabled,
    modelApiKey: getModelApiKey(),
    liveTestToken: getLiveTestToken(),
    requestToken: req.headers["x-bucketa-live-test"],
  });
  liveLimiter.consume();
  try {
    const request = buildMetaAdviceRequest({
      question: validated.question,
      summary: validated.summary,
      apiKey: getModelApiKey(),
    });
    const raw = await sendMetaAdvice(request, fetchImpl);
    const advice = validateModelAdvice(raw, validated.summary);
    sendJson(res, 200, {
      source: "meta-live",
      model: META_MODEL_ID,
      answer: advice.answer,
      explanation: advice.explanation,
      evidence,
      suggestedActions: advice.suggestedActions,
      limitations: advice.limitations,
    });
  } catch (err) {
    // Upstream or validation failure: deterministic fallback, labelled,
    // with a warning. Model output is never partially trusted. Only the
    // safe diagnostic category/status is logged and returned — never
    // bodies, headers, credentials, or stack traces.
    const diagnostic = safeMetaDiagnostic(err);
    console.log(metaDiagnosticLogLine("bucky-advise/live", diagnostic));
    sendJson(res, 200, {
      source: "deterministic-fallback",
      model: null,
      ...fallback,
      evidence,
      diagnostic: {
        category: diagnostic.category,
        upstreamStatus: diagnostic.upstreamStatus,
        subReason: diagnostic.subReason ?? null,
      },
      limitations: [
        ...fallback.limitations,
        "The live Meta response was unavailable or failed validation, so this calculated answer was used instead.",
      ],
    });
  }
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
          buckyAdvise: {
            endpoint: "/api/bucky/advise",
            defaultSource: "deterministic-fallback",
            liveModel: META_MODEL_ID,
            liveCompatibilityVerified: false,
          },
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/bucky/advise") {
        await handleBuckyAdvise(req, res, { config, liveLimiter, fetchImpl });
        status = 200;
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/extract") {
        entryCount = await handleExtract(req, res, { config, liveLimiter, fetchImpl });
        status = 200;
        return;
      }
      throw errors.notFound();
    } catch (err) {
      if (err instanceof MetaDiagnosticError) {
        // Safe diagnostic only: category, upstream status, elapsed time.
        console.log(metaDiagnosticLogLine("meta/live", safeMetaDiagnostic(err)));
      }
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
