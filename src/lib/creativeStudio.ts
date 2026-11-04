/**
 * Bucky Creative Studio — conversational AI image editor (client logic).
 *
 * Real AI editing is provided ONLY by the server endpoint
 * POST /api/creative/edit. That endpoint currently reports Meta image
 * editing as unverified for this account (see server/creativeImage.mjs),
 * so Generate surfaces that honest status — no CSS filter, canvas
 * trick, or mock image is ever presented as an AI result.
 *
 * LABEL_SIZES is kept here because BarcodeLabel imports it; the former
 * poster/menu/catalog template helpers were removed with that UI.
 */

export interface StudioSize { id: string; label: string; width: number; height: number }

export const LABEL_SIZES: StudioSize[] = [
  { id: "label-s", label: "Small 40×30 mm", width: 40, height: 30 },
  { id: "label-m", label: "Medium 50×30 mm", width: 50, height: 30 },
  { id: "label-l", label: "Large 60×40 mm", width: 60, height: 40 },
  { id: "label-shelf", label: "Shelf 80×50 mm", width: 80, height: 50 },
];

/** Matches the server-side image cap (server/validateUpload.mjs). */
export const MAX_STUDIO_IMAGE_BYTES = 5_000_000;
export const STUDIO_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_STUDIO_PROMPT_CHARS = 1000;

export function validateStudioImage(file: { type: string; size: number } | null | undefined): string | null {
  if (!file) return "Choose an image first.";
  if (!(STUDIO_IMAGE_TYPES as readonly string[]).includes(file.type)) return "Use a JPG, PNG, WebP, or GIF image.";
  if (file.size <= 0) return "That image appears to be empty.";
  if (file.size > MAX_STUDIO_IMAGE_BYTES) return "That image is too large (5 MB maximum).";
  return null;
}

export interface StudioTurn {
  id: string;
  prompt: string;
  /** Data URL of the genuine AI result, or null when no image was produced. */
  resultDataUrl: string | null;
  verifiedModel?: string;
  status: "done" | "unavailable" | "error";
  message?: string;
}

/**
 * The image the next edit must start from: the latest genuine AI result,
 * otherwise the preserved original. Follow-up prompts therefore refine
 * the previous result instead of restarting from the upload.
 */
export function nextEditSource(turns: readonly StudioTurn[], originalDataUrl: string): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const result = turns[i].resultDataUrl;
    if (turns[i].status === "done" && result) return result;
  }
  return originalDataUrl;
}

/** Split a data URL into the payload the server expects. */
export function dataUrlParts(dataUrl: string): { imageBase64: string; mediaType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1], imageBase64: match[2] };
}

export interface CreativeEditPayload {
  imageBase64: string;
  mediaType: string;
  prompt: string;
  history: { prompt: string }[];
}

export function buildCreativeEditPayload(sourceDataUrl: string, prompt: string, turns: readonly StudioTurn[]): CreativeEditPayload | null {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > MAX_STUDIO_PROMPT_CHARS) return null;
  const parts = dataUrlParts(sourceDataUrl);
  if (!parts) return null;
  return {
    ...parts,
    prompt: trimmed,
    history: turns.slice(-20).map((t) => ({ prompt: t.prompt })),
  };
}

export interface CreativeStatus {
  available: boolean;
  verified: boolean;
  model?: string;
  reason: string;
}

/**
 * One user-initiated live generation. Live access is configured on
 * the server only (ENABLE_LIVE_META=1 + MODEL_API_KEY + loopback
 * origin); the browser sends no token. Never retries automatically.
 * A placeholder is never returned as a generated image.
 */
export async function requestCreativeEdit(payload: CreativeEditPayload | { operation: "generate"; prompt: string }, fetchImpl: typeof fetch = fetch): Promise<{ dataUrl: string; verifiedModel?: string }> {
  let response: Response;
  try {
    response = await fetchImpl("/api/creative/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, mode: "live" }),
    });
  } catch {
    throw new Error("Creative Studio did not receive a response. Check your connection before trying again.");
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (response.status === 501 || record.error === "image_editing_unverified") {
    throw new Error(typeof record.message === "string" ? record.message : "AI image editing is not verified for this Meta account yet. No image was generated and nothing was charged.");
  }
  if (!response.ok) {
    throw new Error(typeof record.message === "string" ? record.message : "The image request could not be completed.");
  }
  if (typeof record.imageDataUrl !== "string" || !record.imageDataUrl.startsWith("data:image/")) {
    throw new Error("The server returned no usable image, so nothing was shown as a result.");
  }
  const model = record.verifiedModel;
  return typeof model === "string" && /^[a-zA-Z0-9._:/-]{1,100}$/.test(model)
    ? { dataUrl: record.imageDataUrl, verifiedModel: model }
    : { dataUrl: record.imageDataUrl };
}

export async function fetchCreativeStatus(fetchImpl: typeof fetch = fetch): Promise<CreativeStatus> {
  try {
    const response = await fetchImpl("/api/creative/status");
    if (!response.ok) throw new Error("status");
    const body = (await response.json()) as Partial<CreativeStatus>;
    return {
      available: body.available === true,
      verified: body.verified === true,
      model: typeof body.model === "string" ? body.model : undefined,
      reason: typeof body.reason === "string" ? body.reason : "AI image editing status is unknown.",
    };
  } catch {
    return { available: false, verified: false, reason: "The Creative Studio server is not reachable, so AI image editing is unavailable. No image was generated and nothing was charged." };
  }
}
