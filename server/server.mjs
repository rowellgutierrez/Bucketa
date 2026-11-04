import { mockProductAnalysis } from "./productAnalysis.mjs";
import { buildMetaProductRequest, sendMetaProduct } from "./metaClient.mjs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getConfig, getModelApiKey, loadRootEnv } from "./config.mjs";
import { errors, PublicError } from "./errors.mjs";
import { assertLiveAllowed } from "./liveGate.mjs";
import { buildMetaAdviceRequest, buildMetaInterpretRequest, buildMetaRequest, META_MODEL_ID, sendMetaAdvice, sendMetaInterpret, sendToMeta } from "./metaClient.mjs";
import { MetaDiagnosticError, metaDiagnosticLogLine, safeMetaDiagnostic } from "./metaDiagnostics.mjs";
import {
  BUCKY_ADVICE_MAX_BODY_BYTES,
  buildDeterministicAdvice,
  buildVerifiedEvidence,
  validateAdviceRequest,
  validateModelAdvice,
} from "./buckyAdvice.mjs";
import {
  BUCKY_INTERPRET_MAX_BODY_BYTES,
  validateInterpretRequest,
  validateModelInterpretation,
} from "./buckyInterpret.mjs";
import { buildCreativeImageRequest, creativeImageStatus, META_IMAGE_MODEL, sendCreativeImage, validateCreativeEditRequest } from "./creativeImage.mjs";
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

async function handleExtract(req, res, { config, fetchImpl }) {
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

  // Live Meta AI only. Missing, invalid, or "mock" modes are rejected:
  // production never returns fictional extraction entries. Mocked Meta
  // responses exist solely inside automated tests.
  if (payload.mode !== "live") throw errors.invalidRequest();

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

  // Gated live path: ENABLE_LIVE_META + server key + loopback origin.
  // No application-imposed session cap; one upstream attempt only.
  assertLiveAllowed({ liveMetaEnabled: config.liveMetaEnabled, modelApiKey: getModelApiKey(), origin: req.headers.origin, host: req.headers.host });
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
    ...result,
  });
  return result.entries.length;
}

/**
 * POST /api/bucky/advise â€” Bucky Agent 1.0.
 * Default: deterministic fallback computed in code from the strictly
 * validated aggregated summary (always labelled source:
 * "deterministic-fallback"). Live Meta reasoning only when mode:"live"
 * AND all live gates pass; model
 * output is validated (allowlisted actions, grounded numbers) and any
 * failure falls back deterministically with a warning â€” never silently.
 * Evidence in every response is computed server-side, never model-made.
 */
async function handleBuckyAdvise(req, res, { config, fetchImpl }) {
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

  if (validated.mode !== "live" || validated.summary.queryContext) {
    sendJson(res, 200, { source: "deterministic-fallback", model: null, ...fallback, evidence });
    return;
  }

  // Live path: same gates as the scanner, one upstream attempt, no
  // application-imposed session cap. Gate failures are errors (never a
  // silent downgrade of a live request).
  assertLiveAllowed({ liveMetaEnabled: config.liveMetaEnabled, modelApiKey: getModelApiKey(), origin: req.headers.origin, host: req.headers.host });
  try {
    const request = buildMetaAdviceRequest({
      question: validated.question,
      summary: validated.summary,
      history: validated.history,
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
    // safe diagnostic category/status is logged and returned â€” never
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

/**
 * POST /api/bucky/interpret â€” Phase D model-assisted interpretation.
 * The browser's deterministic interpreter is the default and the fallback.
 * Fallback mode never calls the model: it answers { source:
 * "deterministic", proposal: null } and the client uses its local parser.
 * Live mode requires the same live gate as the scanner and advisor (ENABLE_LIVE_META + server MODEL_API_KEY + loopback origin), and returns only a strictly
 * validated structured proposal. The browser cross-checks that proposal
 * against the user's own words and real records before showing the usual
 * preview; nothing here writes data, and any live failure degrades to
 * "no proposal" with a safe diagnostic â€” never to a trusted guess.
 */
async function handleBuckyInterpret(req, res, { config, fetchImpl }) {
  if (!req.headers["content-type"]?.includes("application/json")) {
    throw errors.invalidRequest();
  }
  const bodyBuffer = await readBody(req, BUCKY_INTERPRET_MAX_BODY_BYTES);
  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    throw errors.invalidRequest();
  }
  const validated = validateInterpretRequest(payload);

  if (validated.mode !== "live") {
    sendJson(res, 200, { source: "deterministic", model: null, proposal: null });
    return;
  }

  // Live path: identical gates as /api/bucky/advise, no session cap. Gate
  // failures are errors (never a silent downgrade of a live request).
  assertLiveAllowed({ liveMetaEnabled: config.liveMetaEnabled, modelApiKey: getModelApiKey(), origin: req.headers.origin, host: req.headers.host });
  try {
    const request = buildMetaInterpretRequest({
      text: validated.text,
      context: validated.context,
      apiKey: getModelApiKey(),
    });
    const raw = await sendMetaInterpret(request, fetchImpl);
    const proposal = validateModelInterpretation(raw, validated.context);
    sendJson(res, 200, {
      source: proposal.kind === "none" ? "deterministic" : "meta-live",
      model: proposal.kind === "none" ? null : META_MODEL_ID,
      proposal: proposal.kind === "none" ? null : proposal,
    });
  } catch (err) {
    // Upstream or validation failure: no proposal. The deterministic
    // interpreter remains in charge; nothing partial is trusted.
    const diagnostic = safeMetaDiagnostic(err);
    console.log(metaDiagnosticLogLine("bucky-interpret/live", diagnostic));
    sendJson(res, 200, {
      source: "deterministic",
      model: null,
      proposal: null,
      diagnostic: {
        category: diagnostic.category,
        upstreamStatus: diagnostic.upstreamStatus,
        subReason: diagnostic.subReason ?? null,
      },
    });
  }
}

/**
 * Bucky Creative Studio image editing.
 * GET /api/creative/status â€” free, local status; never calls Meta.
 * POST /api/creative/edit â€” validates image + prompt, then refuses
 * BEFORE any Meta call while image editing is unverified for this
 * account (see creativeImage.mjs). No paid request, retry, or fake
 * image is possible from this route today. When account access is
 * separately verified, sending must go through assertLiveAllowed,
 * one image per user-initiated request, with no session request cap.
 */
/**
 * Bucky Creative Studio image editing (Muse Image 1.0, Responses API).
 * GET /api/creative/status â€” free, local status; never calls Meta.
 * POST /api/creative/edit â€” validates image + prompt first. Non-live
 * requests are refused (501) before any Meta call: there is no mock
 * generation, because a fake image must never be presented as AI.
 * Live requests require mode:"live" AND the live gate
 * (ENABLE_LIVE_META + server MODEL_API_KEY + loopback origin),
 * then the single upstream attempt. No retries
 * and no application-imposed session request cap.
 * The upstream envelope is parsed server-side; only the validated PNG
 * data URL reaches the browser â€” never raw upstream bodies.
 */
async function handleCreativeEdit(req, res, { config, fetchImpl }) {
  if (!req.headers["content-type"]?.includes("application/json")) {
    throw errors.invalidRequest();
  }
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw errors.invalidRequest();
  }
  let validated;
  try {
    validated = validateCreativeEditRequest(payload);
  } catch {
    throw errors.invalidRequest();
  }
  const imageBuffer = decodeBase64Image(payload.imageBase64);
  if (!imageBuffer) throw errors.unsupportedImage();
  const { mediaType } = validateImageBuffer(imageBuffer, payload.mediaType);

  if (validated.mode !== "live") {
    throw errors.imageEditingUnverified();
  }
  assertLiveAllowed({ liveMetaEnabled: config.liveMetaEnabled, modelApiKey: getModelApiKey(), origin: req.headers.origin, host: req.headers.host });
  const request = buildCreativeImageRequest({
    imageBase64: payload.imageBase64,
    mediaType,
    prompt: validated.prompt,
    history: validated.history,
    apiKey: getModelApiKey(),
  });
  const image = await sendCreativeImage(request, fetchImpl);
  sendJson(res, 200, {
    model: META_IMAGE_MODEL,
    imageDataUrl: `data:${image.mediaType};base64,${image.imageBase64}`,
  });
}

async function handleProductAnalysis(req, res, {config, fetchImpl}) {
 if(!req.headers['content-type']?.includes('application/json')) throw errors.invalidRequest();
 let payload;
 try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch(error) { if(error instanceof PublicError) throw error; throw errors.invalidRequest(); }
 if(!payload || typeof payload !== 'object' || !['mock','live'].includes(payload.mode)) throw errors.invalidRequest();
 const bytes = decodeBase64Image(payload.imageBase64);
 if(!bytes) throw errors.unsupportedImage();
 const {mediaType} = validateImageBuffer(bytes,payload.mediaType);
 if(payload.mode === 'mock') { sendJson(res,200,{mode:'mock',model:null,draft:mockProductAnalysis()}); return; }
 assertLiveAllowed({ liveMetaEnabled: config.liveMetaEnabled, modelApiKey: getModelApiKey(), origin: req.headers.origin, host: req.headers.host });
 const draft = await sendMetaProduct(buildMetaProductRequest({imageBase64:payload.imageBase64,mediaType,apiKey:getModelApiKey()}),fetchImpl);
 sendJson(res,200,{mode:'live',model:META_MODEL_ID,draft});
}

export function createAppServer(config = getConfig(), deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    let entryCount = 0;
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        status = 200;
        const liveConfigured = Boolean(config.liveMetaEnabled && config.modelApiKeyConfigured);
        sendJson(res, status, {
          ok: true,
          modelApiKeyConfigured: config.modelApiKeyConfigured,
          liveMeta: liveConfigured ? "enabled" : "disabled",
          buckyAdvise: {
            endpoint: "/api/bucky/advise",
            defaultSource: liveConfigured ? "meta-live" : "deterministic-fallback",
            liveModel: META_MODEL_ID,
            // Scoped to this Bucky advice endpoint only (not the scanner
            // or app-wide): a real live Bucky Financial Intelligence
            // conversation with muse-spark-1.3 was manually verified by
            // the developer and returned a meta-live response.
            liveCompatibilityVerified: true,
          },
          creativeImage: creativeImageStatus({ liveMetaEnabled: config.liveMetaEnabled, modelApiKeyConfigured: config.modelApiKeyConfigured }),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/creative/status") {
        status = 200;
        sendJson(res, status, creativeImageStatus({ liveMetaEnabled: config.liveMetaEnabled, modelApiKeyConfigured: config.modelApiKeyConfigured }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/creative/edit") {
        await handleCreativeEdit(req, res, { config, fetchImpl });
        status = 200;
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/bucky/advise") {
        await handleBuckyAdvise(req, res, { config, fetchImpl });
        status = 200;
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/bucky/interpret") {
        await handleBuckyInterpret(req, res, { config, fetchImpl });
        status = 200;
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/products/analyze") {
        await handleProductAnalysis(req, res, {config, fetchImpl}); status = 200; return;
      }
      if (req.method === "POST" && url.pathname === "/api/extract") {
        entryCount = await handleExtract(req, res, { config, fetchImpl });
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
      `Bucketa server listening on http://${config.host}:${config.port} (liveMetaEnabled=${config.liveMetaEnabled}, modelApiKeyConfigured=${config.modelApiKeyConfigured})`,
    );
  });
}
