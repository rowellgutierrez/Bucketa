import { buildExtractionPrompt, EXTRACTION_JSON_SCHEMA } from "./extractSchema.mjs";
import { errors } from "./errors.mjs";

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

function extractTextFromResponse(json) {
  if (!json || typeof json !== "object") return null;
  if (typeof json.output_text === "string") return json.output_text;
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && typeof part.text === "string") return part.text;
      }
    }
  }
  const choice = json.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) {
    for (const part of choice) {
      if (part && typeof part.text === "string") return part.text;
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
  if (!text) throw errors.metaUnavailable();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw errors.metaUnavailable();
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw errors.metaUnavailable();
  }
  return parsed;
}

/**
 * Send one built request. No retries. Timeout via AbortController.
 * Response size is capped; upstream error bodies are never forwarded
 * or logged (they could contain echoed input).
 */
export async function sendToMeta(request, fetchImpl = fetch, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch {
    throw errors.metaUnavailable();
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.status !== "number") throw errors.metaUnavailable();
  if (response.status === 401 || response.status === 403) {
    throw errors.metaUnavailable();
  }
  if (response.status === 429) throw errors.metaUnavailable();
  if (response.status < 200 || response.status >= 300) throw errors.metaUnavailable();

  let text;
  try {
    text = await response.text();
  } catch {
    throw errors.metaUnavailable();
  }
  if (typeof text !== "string" || text.length > maxResponseBytes) {
    throw errors.metaUnavailable();
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw errors.metaUnavailable();
  }
  return parseMetaExtractionResponse(json);
}
