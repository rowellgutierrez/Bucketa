import type { Product } from "../data/types";
import { findBarcodeConflict, normalizeBarcode } from "../data/validation.ts";

/**
 * Bucketa Smart Scan barcodes (P0).
 *
 * Values are stored on Product.barcode and are unique within one business
 * (profileId), enforced with findBarcodeConflict exactly like SKUs. A
 * product may instead carry an existing EAN/UPC/Code 128 value; lookup is
 * always scoped to the active business so another business's identical
 * code can never resolve here. Generated values are internal store codes
 * rendered as Code 128 — they are not GS1-registered barcodes.
 */

export const INTERNAL_BARCODE_PREFIX = "BKT-";

const SUFFIX_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SUFFIX_LENGTH = 10;

function randomSuffix(): string {
  let suffix = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(SUFFIX_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
    return suffix;
  }
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    suffix += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  }
  return suffix;
}

export function isInternalBarcode(barcode: string | null | undefined): boolean {
  return normalizeBarcode(barcode).startsWith(INTERNAL_BARCODE_PREFIX);
}

/**
 * Generate a unique internal Code 128 value for one business. `nextSuffix`
 * is injectable for deterministic tests; production uses crypto randomness.
 * Throws only after repeated collisions, which callers surface as a retry.
 */
export function generateInternalBarcode(
  products: Product[],
  profileId: string,
  nextSuffix: () => string = randomSuffix,
): string {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `${INTERNAL_BARCODE_PREFIX}${nextSuffix().trim().toUpperCase()}`;
    if (!findBarcodeConflict(products, profileId, candidate)) return candidate;
  }
  throw new Error("Could not generate a unique barcode. Please try again.");
}

/**
 * Find the active product for a scanned/typed code within one business.
 * Archived products never resolve, so a scan can never sell them; other
 * businesses' products are invisible even with an identical code.
 */
export function findProductByBarcode(
  products: Product[],
  profileId: string,
  rawCode: string,
): Product | null {
  const wanted = normalizeBarcode(rawCode);
  if (!wanted) return null;
  return (
    products.find(
      (p) =>
        p.profileId === profileId &&
        p.status !== "archived" &&
        normalizeBarcode(p.barcode) === wanted,
    ) ?? null
  );
}

/** Camera detection is latched until the caller explicitly resets last to null. */
export function shouldAcceptScan(last: {code:string;at:number}|null, code:string, _now:number): boolean {
 return !!normalizeBarcode(code) && last === null;
}
