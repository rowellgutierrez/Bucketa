import { errors } from "./errors.mjs";

/** Decoded image size cap: 5 MB (Meta's own inline limit is 50 MB). */
export const MAX_IMAGE_BYTES = 5_000_000;

/**
 * HTTP request-body cap, enforced while streaming, before any base64
 * decoding. Base64 inflates data by about 4/3, so 7.5 MB of body can
 * carry at most about 5.6 MB decoded — still bounded before decoding,
 * and the decoded check below enforces the exact 5 MB limit.
 */
export const MAX_BODY_BYTES = 7_500_000;

const SIGNATURES = [
  { mediaType: "image/jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mediaType: "image/png",
    matches: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mediaType: "image/gif",
    matches: (b) => b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8",
  },
  {
    mediaType: "image/webp",
    matches: (b) =>
      b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    mediaType: "image/x-icon",
    matches: (b) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  },
];

function normalizeDeclared(mediaType) {
  if (mediaType === "image/jpg") return "image/jpeg";
  return mediaType;
}

/**
 * Validate a decoded image buffer against its declared media type by
 * sniffing the actual magic bytes. Returns the canonical media type.
 * Throws a safe PublicError on any mismatch.
 */
export function validateImageBuffer(buffer, declaredMediaType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw errors.unsupportedImage();
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw errors.imageTooLarge();
  }
  const sniffed = SIGNATURES.find((s) => s.matches(buffer));
  if (!sniffed) {
    throw errors.unsupportedImage();
  }
  const declared = normalizeDeclared(String(declaredMediaType ?? "").toLowerCase());
  if (declared !== sniffed.mediaType) {
    throw errors.unsupportedImage();
  }
  return { mediaType: sniffed.mediaType, sizeBytes: buffer.length };
}

/** Strictly decode a base64 string. Returns null when malformed. */
export function decodeBase64Image(imageBase64) {
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return null;
  try {
    return Buffer.from(imageBase64, "base64");
  } catch {
    return null;
  }
}
