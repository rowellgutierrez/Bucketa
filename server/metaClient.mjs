import { buildExtractionPrompt, EXTRACTION_JSON_SCHEMA } from "./extractSchema.mjs";
import { BUCKY_ADVICE_JSON_SCHEMA, buildBuckyAdvicePrompt } from "./buckyAdvice.mjs";
import { metaDiagnosticError } from "./metaDiagnostics.mjs";

/**
 * Meta Model API client (M1B).
 * Live sending exists but is reachable only through the gates in
 * liveGate.mjs. Nothing here logs requests, responses, or keys.
 */
export const META_API_BASE_URL = "https://api.meta.ai/v1";
export const META_MODEL_ID = "muse-spark-1.3";
export const LIVE_META_IMPLEMENTED = true;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_000_000;

export class LiveMetaDisabledError extends Error {
  constructor() {
    super("Live Meta API calls are disabled.");
    this.code = "live_meta_disabled";
  }
}

/** Build the exact Responses API request for one image. Pure function. */
export function buildMetaRequest({ imageBase64, mediaType, expectedCurrency, recordType, apiKey }) {
  return {
    url: `${META_API_BASE_URL}/responses`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
    },
    body: {
      model: META_MODEL_ID,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: buildExtractionPrompt(expectedCurrency, recordType) },
            {
              type: "input_image",
              image_url: `data:${mediaType};base64,${imageBase64}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "bucketa_extraction",
          strict: true,
          schema: EXTRACTION_JSON_SCHEMA,
        },
      },
    },
  };
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Extract the model's text from a response envelope.
 *
 * Preference order, without inventing provider-specific shapes:
 * 1. An explicitly identified output-text part (type "output_text").
 * 2. The top-level output_text convenience field.
 * 3. Any other text-bearing content part (existing mocked shapes).
 * 4. The Chat Completions-style choices fallback (existing behaviour).
 *
 * Explicit refusal or incomplete markers, when present in the generic
 * fields already inspected here, yield no text so callers fail safely
 * with invalid_envelope instead of parsing non-answer content.
 */
function extractTextFromResponse(json) {
  if (!json || typeof json !== "object") return null;
  if (json.status === "incomplete" || json.status === "failed") return null;

  if (Array.isArray(json.output)) {
    // A refusal anywhere in the output means there is no usable answer.
    for (const item of json.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && part.type === "refusal") return null;
      }
    }
    // Prefer explicitly identified answer text over unrelated parts.
    for (const item of json.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && part.type === "output_text" && isNonEmptyText(part.text)) return part.text;
      }
    }
  }

  if (isNonEmptyText(json.output_text)) return json.output_text;

  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && isNonEmptyText(part.text)) return part.text;
      }
    }
  }
  const message = json.choices?.[0]?.message;
  if (message && typeof message.refusal === "string" && message.refusal) return null;
  const choice = message?.content;
  if (typeof choice === "string" && choice) return choice;
  if (Array.isArray(choice)) {
    for (const part of choice) {
      if (part && isNonEmptyText(part.text)) return part.text;
    }
  }
  return null;
}

/**
 * Parse a Meta API response envelope into raw extraction output
 * ({ entries: [...] }). Supports the documented Responses shape, the
 * SDK's output_text convenience field, and Chat Completions as fallback.
 * Live envelope details are not yet verified against a real response;
 * any unrecognised or malformed shape fails safely.
 */
export function parseMetaExtractionResponse(json) {
  const text = extractTextFromResponse(json);
  if (!text) throw metaDiagnosticError("invalid_envelope");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw metaDiagnosticError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw metaDiagnosticError("invalid_envelope");
  }
  return parsed;
}

/**
 * Send one built request and return the raw parsed envelope. No retries.
 * Timeout via AbortController. Response size is capped; upstream error
 * bodies are never forwarded or logged (they could contain echoed input).
 */
export async function sendMetaEnvelope(request, fetchImpl = fetch, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch {
      // Only the category is kept — the underlying error may contain
      // request details and is never propagated or logged.
      throw metaDiagnosticError(timedOut ? "timeout" : "network_error", { elapsedMs: elapsed() });
    }

    if (!response || typeof response.status !== "number") {
      throw metaDiagnosticError("invalid_envelope", { elapsedMs: elapsed() });
    }
    if (response.status === 401 || response.status === 403) {
      throw metaDiagnosticError("auth_failure", { upstreamStatus: response.status, elapsedMs: elapsed() });
    }
    if (response.status === 404) {
      throw metaDiagnosticError("endpoint_not_found", { upstreamStatus: 404, elapsedMs: elapsed() });
    }
    if (response.status === 429) {
      throw metaDiagnosticError("rate_limited", { upstreamStatus: 429, elapsedMs: elapsed() });
    }
    if (response.status < 200 || response.status >= 300) {
      throw metaDiagnosticError("upstream_http", { upstreamStatus: response.status, elapsedMs: elapsed() });
    }

    // The timeout stays armed until the body is fully read, so a slow
    // body cannot outlive the request timeout.
    let text;
    try {
      text = await response.text();
    } catch {
      throw metaDiagnosticError(timedOut ? "timeout" : "invalid_envelope", {
        upstreamStatus: response.status,
        elapsedMs: elapsed(),
      });
    }
    // Enforce the cap on actual UTF-8 bytes, not JavaScript string
    // length: multi-byte characters must not bypass the byte budget.
    // The oversized body itself is never logged or forwarded.
    if (typeof text !== "string" || new TextEncoder().encode(text).length > maxResponseBytes) {
      throw metaDiagnosticError("invalid_envelope", { upstreamStatus: response.status, elapsedMs: elapsed() });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw metaDiagnosticError("invalid_json", { upstreamStatus: response.status, elapsedMs: elapsed() });
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Send one extraction request (existing scanner behaviour, unchanged). */
export async function sendToMeta(request, fetchImpl = fetch, options = {}) {
  const json = await sendMetaEnvelope(request, fetchImpl, options);
  return parseMetaExtractionResponse(json);
}

/**
 * Build the Bucky advice request: text-only Responses API call with the
 * same configured model and strict json_schema mechanism as extraction.
 * Live compatibility of text reasoning on this model is NOT verified —
 * it is only ever sent through the live gates in server.mjs.
 */
export function buildMetaAdviceRequest({ question, summary, apiKey }) {
  return {
    url: `${META_API_BASE_URL}/responses`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
    },
    body: {
      model: META_MODEL_ID,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: buildBuckyAdvicePrompt({ question, summary }) },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "bucketa_bucky_advice",
          strict: true,
          schema: BUCKY_ADVICE_JSON_SCHEMA,
        },
      },
    },
  };
}

/** Parse a Bucky advice envelope into the raw (still untrusted) object. */
export function parseMetaAdviceResponse(json) {
  const text = extractTextFromResponse(json);
  if (!text) throw metaDiagnosticError("invalid_envelope");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw metaDiagnosticError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw metaDiagnosticError("invalid_envelope");
  }
  return parsed;
}

/** Send one Bucky advice request and return the raw advice object. */
export async function sendMetaAdvice(request, fetchImpl = fetch, options = {}) {
  const json = await sendMetaEnvelope(request, fetchImpl, options);
  return parseMetaAdviceResponse(json);
}
