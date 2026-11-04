import { sendMetaEnvelope } from "./metaClient.mjs";
import { metaDiagnosticError } from "./metaDiagnostics.mjs";

/**
 * Bucky Creative Studio — Muse Image 1.0 editing (Responses API).
 *
 * Request contract supplied by the operator from the official Meta
 * Image Playground "Get Code" output (2026-11-03):
 *   POST https://api.meta.ai/v1/responses
 *   Authorization: Bearer $MODEL_API_KEY   (server-side only)
 *   model: "muse-image-1.0", stream: false
 *   input: one user message with input_text + input_image
 *          (image_url as a base64 data URL)
 *   tools: [{ type: "image_generation", output_format: "png" }]
 *
 * Verification note: the developer reported a successful real live
 * generation on 2026-11-03. A different account/key still needs its
 * own Muse Image access. The parser below accepts the Responses
 * image_generation_call result and an output_image content part, then
 * strictly validates that the bytes are a real PNG before anything
 * reaches the UI. Anything else fails safely — never faked.
 *
 * Live sending exists ONLY behind the gates in server.mjs
 * (assertLiveAllowed; no session request cap). This module is never
 * called from the browser and never retries.
 */

export const META_IMAGE_MODEL = "muse-image-1.0";
export const META_IMAGE_ENDPOINT_PATH = "/responses";
// Developer-reported successful live generation with a real Meta AI
// request (2026-11-03). Other accounts still need their own key with
// Muse Image access; failures fail safely and are never faked.
export const IMAGE_EDITING_VERIFIED = true;
export const CREATIVE_MAX_PROMPT_CHARS = 1000;
export const CREATIVE_MAX_TURNS = 20;
export const MAX_GENERATED_IMAGE_BYTES = 10_000_000;

export function creativeImageStatus({ liveMetaEnabled = false, modelApiKeyConfigured = false } = {}) {
  const configured = Boolean(liveMetaEnabled && modelApiKeyConfigured);
  return {
    available: configured,
    verified: IMAGE_EDITING_VERIFIED,
    model: META_IMAGE_MODEL,
    endpoint: META_IMAGE_ENDPOINT_PATH,
    reason: configured
      ? "Live Muse Image editing is configured on the server. A real live generation was reported successful by the developer; Generate sends one request per tap with no automatic retries."
      : "Live Muse Image editing is not configured on this server (set ENABLE_LIVE_META=1 and a server-side MODEL_API_KEY). No image is sent to Meta and nothing is charged.",
  };
}

/**
 * Pure request-shape validation for one conversational edit.
 * `history` carries prior prompts only, capped so payloads stay bounded.
 * Throws an Error with a safe code on any problem.
 */
export function validateCreativeEditRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_request");
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt || prompt.length > CREATIVE_MAX_PROMPT_CHARS) {
    throw new Error("invalid_prompt");
  }
  if (typeof payload.imageBase64 !== "string" || payload.imageBase64.length === 0) {
    throw new Error("invalid_image");
  }
  if (typeof payload.mediaType !== "string" || !payload.mediaType.startsWith("image/")) {
    throw new Error("invalid_image");
  }
  const history = Array.isArray(payload.history)
    ? payload.history
        .filter((t) => t && typeof t.prompt === "string" && t.prompt.trim())
        .slice(-CREATIVE_MAX_TURNS)
        .map((t) => ({ prompt: t.prompt.trim().slice(0, CREATIVE_MAX_PROMPT_CHARS) }))
    : [];
  return { prompt, history, mode: payload.mode === "live" ? "live" : "disabled" };
}

function editInstruction(prompt, history) {
  const lines = [
    "Edit the provided image according to the user's instruction. Return only the edited image.",
  ];
  if (history.length > 0) {
    lines.push("Earlier edits in this conversation (the provided image is the latest result):");
    for (const turn of history) lines.push(`- ${turn.prompt}`);
  }
  lines.push(`Current instruction: ${prompt}`);
  return lines.join("\n");
}

/** Build the exact Muse Image Responses request. Pure; fixed model/URL. */
export function buildCreativeImageRequest({ imageBase64, mediaType, prompt, history = [], apiKey }) {
  return {
    url: "https://api.meta.ai/v1/responses",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
    },
    body: {
      model: META_IMAGE_MODEL,
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: editInstruction(prompt, history) },
            { type: "input_image", image_url: `data:${mediaType};base64,${imageBase64}` },
          ],
        },
      ],
      tools: [{ type: "image_generation", output_format: "png" }],
    },
  };
}

function pngBytesFromBase64(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const base64 = value.startsWith("data:")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  let buffer;
  try { buffer = Buffer.from(base64, "base64"); } catch { return null; }
  if (buffer.length === 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) return null;
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  return isPng ? base64 : null;
}

/**
 * Parse a Muse Image response envelope into { imageBase64, mediaType }.
 * Accepts an image_generation_call result or an output_image content
 * part; the decoded bytes must be a genuine PNG. Any other shape —
 * including text-only answers — fails safely with invalid_envelope.
 */
export function parseCreativeImageResponse(json) {
  if (!json || typeof json !== "object") throw metaDiagnosticError("invalid_envelope");
  if (json.status === "incomplete" || json.status === "failed") throw metaDiagnosticError("invalid_envelope");
  const candidates = [];
  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "image_generation_call" && typeof item.result === "string") {
        candidates.push(item.result);
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "output_image") {
            if (typeof part.image_url === "string") candidates.push(part.image_url);
            if (typeof part.result === "string") candidates.push(part.result);
            if (typeof part.b64_json === "string") candidates.push(part.b64_json);
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    const png = pngBytesFromBase64(candidate);
    if (png) return { imageBase64: png, mediaType: "image/png" };
  }
  throw metaDiagnosticError("invalid_envelope");
}

/** Send one image-edit request. No retries; generous but bounded timeout/size for a PNG payload. */
export async function sendCreativeImage(request, fetchImpl = fetch, options = {}) {
  const json = await sendMetaEnvelope(request, fetchImpl, {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxResponseBytes: options.maxResponseBytes ?? 15_000_000,
  });
  return parseCreativeImageResponse(json);
}
