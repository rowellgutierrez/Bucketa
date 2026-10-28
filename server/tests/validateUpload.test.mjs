import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase64Image,
  MAX_IMAGE_BYTES,
  validateImageBuffer,
} from "../validateUpload.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test("accepts a real PNG signature declared as PNG", () => {
  const result = validateImageBuffer(PNG_BYTES, "image/png");
  assert.equal(result.mediaType, "image/png");
});

test("accepts a JPEG declared as image/jpg", () => {
  const result = validateImageBuffer(JPEG_BYTES, "image/jpg");
  assert.equal(result.mediaType, "image/jpeg");
});

test("rejects JPEG bytes declared as PNG", () => {
  assert.throws(() => validateImageBuffer(JPEG_BYTES, "image/png"), /not a supported image/);
});

test("rejects non-image bytes", () => {
  assert.throws(
    () => validateImageBuffer(Buffer.from("plain text, not an image"), "image/png"),
    /not a supported image/,
  );
});

test("rejects an empty buffer", () => {
  assert.throws(() => validateImageBuffer(Buffer.alloc(0), "image/png"), /not a supported image/);
});

test("rejects an image over the 5 MB decoded cap", () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG_BYTES.copy(big);
  assert.throws(() => validateImageBuffer(big, "image/png"), /too large/);
});

test("decodes valid base64 and rejects malformed input", () => {
  const decoded = decodeBase64Image(PNG_BYTES.toString("base64"));
  assert.ok(decoded.equals(PNG_BYTES));
  assert.equal(decodeBase64Image("not base64!!"), null);
  assert.equal(decodeBase64Image(""), null);
  assert.equal(decodeBase64Image(42), null);
});
