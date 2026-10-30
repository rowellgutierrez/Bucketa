/**
 * Typed client for the Bucketa scanner backend.
 *
 * The browser only ever talks to the same-origin `/api` routes (proxied
 * to the local Node server in development). The Meta API key stays
 * server-side only. A live-test token is never hard-coded, persisted, or
 * logged here; it is only forwarded when a caller supplies one at runtime
 * for an explicitly requested live extraction.
 */

export interface ScannerHealth {
  ok: true;
  mode: "mock";
  defaultMode: "mock";
  modelApiKeyConfigured: boolean;
  liveMeta: "enabled-gated" | "disabled";
  liveRequestsUsed: number;
  liveRequestsLimit: number;
}

export type ScannerRecordType =
  | "expenses"
  | "sales"
  | "salaries"
  | "financial records";

export interface ExtractRequest {
  imageBase64: string;
  mediaType: string;
  expectedCurrency: string;
  recordType: ScannerRecordType;
}

export type ScannerExtractionMode = "mock" | "live";

export interface ScannerExtractionOptions {
  mode?: ScannerExtractionMode;
  /**
   * Runtime-supplied local live-test token. This must never be hard-coded,
   * persisted, or logged by callers; it is forwarded only for one live call.
   */
  liveTestToken?: string;
}

/** Live UI is available only in Vite development with a gated backend. */
export function isLiveScannerAvailable(
  isDevelopment: boolean,
  health: ScannerHealth | null,
): boolean {
  return isDevelopment && health?.liveMeta === "enabled-gated";
}

export interface ExtractedEntry {
  description: string | null;
  type: "income" | "expense" | null;
  amountText: string | null;
  amountMinor: number | null;
  quantityText: string | null;
  unitPriceText: string | null;
  unitPriceMinor: number | null;
  expectedAmountMinor: number | null;
  arithmeticMismatch: boolean;
  currency: string;
  currencyDetected: string | null;
  currencyConflict: boolean;
  dateText: string | null;
  categorySuggestion: string | null;
  confidence: number;
  uncertainFields: string[];
  needsReview: boolean;
  reviewReasons: string[];
}

export interface ExtractionTotals {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  countedEntries: number;
  skippedEntries: number;
}

export interface ExtractResponse {
  mode: "mock" | "live";
  recordType: ScannerRecordType;
  currency: string;
  /**
   * Written document-level grand total, transcribed separately from the
   * entries. Optional for compatibility with older/mock responses that
   * do not provide one; null means no readable total was reported.
   */
  documentTotalText?: string | null;
  documentTotalMinor?: number | null;
  entries: ExtractedEntry[];
  totals: ExtractionTotals;
  needsReviewCount: number;
  liveRequestsUsed?: number;
}

/** Safe, user-facing scanner error. Never carries server internals. */
export class ScannerApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ScannerApiError";
    this.code = code;
    this.status = status;
  }
}

const OFFLINE_MESSAGE =
  "The scanner backend could not be reached. Start the local Bucketa server, then try again.";
const GENERIC_MESSAGE = "The scanner request could not be completed. Please try again.";

/** Fixed messages per known server error code; raw bodies are never shown. */
const ERROR_MESSAGES: Record<string, string> = {
  unsupported_image: "The uploaded file is not a supported image.",
  image_too_large: "The uploaded image is too large.",
  request_too_large: "The request is too large.",
  invalid_request: "The request could not be understood.",
  invalid_currency: "The bucket currency is not a valid ISO 4217 code.",
  extraction_unavailable: "Extraction is unavailable right now.",
  live_disabled: "Live Meta testing is not enabled on this server.",
  live_unauthorized: "Live Meta testing was not authorized for this request.",
  live_limit_reached:
    "The live test request limit for this server session has been reached.",
  meta_unavailable:
    "The Meta Model API could not be reached or returned an unusable response.",
  not_found: "The scanner service was not found.",
  internal_error: "Something went wrong on the server.",
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toScannerError(status: number, payload: unknown): ScannerApiError {
  const code =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : "";
  const message = ERROR_MESSAGES[code] ?? GENERIC_MESSAGE;
  return new ScannerApiError(code || "scanner_error", message, status);
}

async function requestJson(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(path, { ...init, signal: controller.signal });
  } catch {
    throw new ScannerApiError("backend_offline", OFFLINE_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
  const payload = await readJson(response);
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    throw new ScannerApiError("backend_offline", OFFLINE_MESSAGE, response.status);
  }
  if (!response.ok) throw toScannerError(response.status, payload);
  return { status: response.status, payload };
}

function isHealth(payload: unknown): payload is ScannerHealth {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return (
    health.ok === true &&
    health.mode === "mock" &&
    typeof health.modelApiKeyConfigured === "boolean" &&
    (health.liveMeta === "enabled-gated" || health.liveMeta === "disabled") &&
    typeof health.liveRequestsUsed === "number" &&
    typeof health.liveRequestsLimit === "number"
  );
}

/** Fetch scanner backend health. Throws ScannerApiError when offline. */
export async function fetchScannerHealth(): Promise<ScannerHealth> {
  const { payload } = await requestJson("/api/health", { method: "GET" }, 10_000);
  if (!isHealth(payload)) {
    throw new ScannerApiError("invalid_response", GENERIC_MESSAGE);
  }
  return payload;
}

function isExtractResponse(payload: unknown): payload is ExtractResponse {
  if (!payload || typeof payload !== "object") return false;
  const result = payload as Record<string, unknown>;
  return (
    (result.mode === "mock" || result.mode === "live") &&
    typeof result.currency === "string" &&
    Array.isArray(result.entries) &&
    typeof result.needsReviewCount === "number" &&
    result.totals !== null &&
    typeof result.totals === "object"
  );
}

/** Mirrors the server cap in server/validateUpload.mjs; server still enforces it. */
export const MAX_SCANNER_IMAGE_BYTES = 5_000_000;

export const SCANNER_ACCEPTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export interface PreparedScannerImage {
  imageBase64: string;
  mediaType: string;
  blob: Blob;
  sizeBytes: number;
  originalSizeBytes: number;
  wasResized: boolean;
}

function normalizeMediaType(type: string): string {
  return type === "image/jpg" ? "image/jpeg" : type.toLowerCase();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function downscaleImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("unreadable image"));
      img.src = url;
    });
    const maxDimension = 1920;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.65, 0.5]) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob && blob.size <= MAX_SCANNER_IMAGE_BYTES) return blob;
    }
    throw new ScannerApiError(
      "image_too_large",
      "The uploaded image is too large, even after resizing. Please use a smaller or closer photo.",
    );
  } catch (error) {
    if (error instanceof ScannerApiError) throw error;
    throw new ScannerApiError(
      "unsupported_image",
      "The uploaded file is not a supported image.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Validate and prepare one image for extraction. Supported types are
 * checked before upload, and oversized images are downscaled in the
 * browser so the server cap is respected without weakening it. The
 * server re-validates type and size from the actual bytes.
 */
export async function prepareScannerImage(file: File): Promise<PreparedScannerImage> {
  const mediaType = normalizeMediaType(file.type);
  if (!(SCANNER_ACCEPTED_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
    throw new ScannerApiError(
      "unsupported_image",
      "Please choose a JPEG, PNG, WebP, or GIF image.",
    );
  }
  if (file.size === 0) {
    throw new ScannerApiError("unsupported_image", "The uploaded file is not a supported image.");
  }
  let blob: Blob = file;
  let wasResized = false;
  if (file.size > MAX_SCANNER_IMAGE_BYTES) {
    blob = await downscaleImage(file);
    wasResized = true;
  }
  if (blob.size > MAX_SCANNER_IMAGE_BYTES) {
    throw new ScannerApiError(
      "image_too_large",
      "The uploaded image is too large. Please use a smaller or closer photo.",
    );
  }
  return {
    imageBase64: await blobToBase64(blob),
    mediaType: normalizeMediaType(blob.type || mediaType),
    blob,
    sizeBytes: blob.size,
    originalSizeBytes: file.size,
    wasResized,
  };
}

/**
 * Request extraction for one image. Mock mode is the default for every
 * existing caller. Live mode is sent only when explicitly requested, and a
 * live request without a runtime-supplied non-empty token fails before any
 * network call rather than silently falling back to mock.
 */
export async function requestExtraction(
  request: ExtractRequest,
  options: ScannerExtractionOptions = {},
): Promise<ExtractResponse> {
  const mode = options.mode ?? "mock";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (mode === "live") {
    const liveTestToken = options.liveTestToken;
    if (!liveTestToken || liveTestToken.trim().length === 0) {
      throw new ScannerApiError(
        "live_token_required",
        "Enter the live test token provided by the local server operator before requesting a live scan.",
      );
    }
    headers["x-bucketa-live-test"] = liveTestToken;
  } else if (mode !== "mock") {
    throw new ScannerApiError(
      "invalid_request",
      "Choose mock or live extraction before scanning.",
    );
  }
  const { payload } = await requestJson(
    "/api/extract",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, mode }),
    },
    35_000,
  );
  if (!isExtractResponse(payload)) {
    throw new ScannerApiError("invalid_response", GENERIC_MESSAGE);
  }
  return payload;
}
