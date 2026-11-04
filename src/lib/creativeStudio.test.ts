import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCreativeEditPayload,
  dataUrlParts,
  LABEL_SIZES,
  MAX_STUDIO_IMAGE_BYTES,
  nextEditSource,
  requestCreativeEdit,
  validateStudioImage,
  type StudioTurn,
} from "./creativeStudio.ts";

const turn = (id: string, resultDataUrl: string | null, status: StudioTurn["status"] = "done"): StudioTurn => ({ id, prompt: `p-${id}`, resultDataUrl, status });

test("live generation needs no user token and never sends one", async () => {
  const payload = buildCreativeEditPayload("data:image/png;base64,QUJD", "Make it darker", [])!;
  let seenHeaders: unknown = null;
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ imageDataUrl: png }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const result = await requestCreativeEdit(payload, fakeFetch);
  assert.equal(result.dataUrl, png);
  assert.equal(JSON.stringify(seenHeaders).includes("live-test"), false);
  assert.equal(JSON.stringify(seenHeaders).toLowerCase().includes("token"), false);
});

test("label sizes remain available for barcode labels", () => {
  assert.equal(LABEL_SIZES.length, 4);
  assert.equal(LABEL_SIZES[0].width, 40);
});

test("studio image validation enforces type and the 5 MB cap", () => {
  assert.match(validateStudioImage(null) ?? "", /Choose an image/);
  assert.match(validateStudioImage({ type: "image/bmp", size: 10 }) ?? "", /JPG, PNG, WebP, or GIF/);
  assert.match(validateStudioImage({ type: "image/png", size: MAX_STUDIO_IMAGE_BYTES + 1 }) ?? "", /too large/);
  assert.equal(validateStudioImage({ type: "image/jpeg", size: 1024 }), null);
});

test("follow-up edits start from the latest genuine result, else the original", () => {
  const original = "data:image/png;base64,ORIGINAL";
  assert.equal(nextEditSource([], original), original);
  assert.equal(nextEditSource([turn("1", "data:image/png;base64,A")], original), "data:image/png;base64,A");
  // An unavailable/error turn never becomes the next source image.
  assert.equal(
    nextEditSource([turn("1", "data:image/png;base64,A"), turn("2", null, "unavailable")], original),
    "data:image/png;base64,A",
  );
});

test("edit payload carries the source image, prompt, and bounded history only", () => {
  const payload = buildCreativeEditPayload("data:image/jpeg;base64,QUJD", "  Make it darker  ", [turn("1", null, "unavailable")]);
  assert.deepEqual(payload, {
    imageBase64: "QUJD",
    mediaType: "image/jpeg",
    prompt: "Make it darker",
    history: [{ prompt: "p-1" }],
  });
  assert.equal(buildCreativeEditPayload("not-a-data-url", "x", []), null);
  assert.equal(buildCreativeEditPayload("data:image/jpeg;base64,QUJD", "   ", []), null);
  assert.deepEqual(dataUrlParts("data:image/png;base64,AA=="), { mediaType: "image/png", imageBase64: "AA==" });
});
