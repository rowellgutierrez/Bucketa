import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.mjs";
import {
  buildCreativeImageRequest,
  creativeImageStatus,
  parseCreativeImageResponse,
  sendCreativeImage,
  validateCreativeEditRequest,
  IMAGE_EDITING_VERIFIED,
  META_IMAGE_MODEL,
} from "../creativeImage.mjs";

// 1x1 transparent PNG (also the mocked generated result).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

const disabledConfig = { host: "127.0.0.1", port: 0, modelApiKeyConfigured: false, liveMetaEnabled: false, liveTestTokenConfigured: false };
const liveConfig = { host: "127.0.0.1", port: 0, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true };

async function withServer(config, fetchImpl, fn) {
  const server = createAppServer(config, { fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function jsonResponse(status, value) {
  return { status, text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
}

test("status reports disabled by default and the fixed Muse Image model", () => {
  const off = creativeImageStatus();
  assert.equal(off.available, false);
  assert.equal(off.verified, false);
  assert.equal(IMAGE_EDITING_VERIFIED, false);
  assert.equal(off.model, "muse-image-1.0");
  const on = creativeImageStatus({ liveMetaEnabled: true, modelApiKeyConfigured: true, liveTestTokenConfigured: true });
  assert.equal(on.available, true);
  assert.match(on.reason, /unverified/i); // account access still unverified
});

test("request builder uses the Playground Responses structure exactly", () => {
  const req = buildCreativeImageRequest({
    imageBase64: PNG_B64, mediaType: "image/png",
    prompt: "Make it darker", history: [{ prompt: "First edit" }],
    apiKey: "server-only-key",
  });
  assert.equal(req.url, "https://api.meta.ai/v1/responses");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.Authorization, "Bearer server-only-key");
  assert.equal(req.body.model, META_IMAGE_MODEL);
  assert.equal(req.body.stream, false);
  assert.deepEqual(req.body.tools, [{ type: "image_generation", output_format: "png" }]);
  const [message] = req.body.input;
  assert.equal(message.role, "user");
  assert.equal(message.content[0].type, "input_text");
  assert.match(message.content[0].text, /First edit/);
  assert.match(message.content[0].text, /Current instruction: Make it darker/);
  assert.deepEqual(message.content[1], { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}` });
});

test("response parser accepts a genuine PNG result and rejects everything else", () => {
  const parsed = parseCreativeImageResponse({ status: "completed", output: [{ type: "image_generation_call", result: PNG_B64 }] });
  assert.deepEqual(parsed, { imageBase64: PNG_B64, mediaType: "image/png" });
  // Text-only answers, bad base64, non-PNG bytes, and failed envelopes never pass.
  assert.throws(() => parseCreativeImageResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }), /could not be reached/);
  assert.throws(() => parseCreativeImageResponse({ output: [{ type: "image_generation_call", result: "not base64!!" }] }), /could not be reached/);
  assert.throws(() => parseCreativeImageResponse({ output: [{ type: "image_generation_call", result: Buffer.from("not a png").toString("base64") }] }), /could not be reached/);
  assert.throws(() => parseCreativeImageResponse({ status: "failed", output: [{ type: "image_generation_call", result: PNG_B64 }] }), /could not be reached/);
});

test("sendCreativeImage makes exactly one attempt on upstream failure", async () => {
  let calls = 0;
  const req = buildCreativeImageRequest({ imageBase64: PNG_B64, mediaType: "image/png", prompt: "x", apiKey: "k" });
  await assert.rejects(
    () => sendCreativeImage(req, async () => { calls += 1; return jsonResponse(500, { error: "upstream detail must not leak" }); }),
    /could not be reached/,
  );
  assert.equal(calls, 1);
});

test("creative edit request validation rejects bad prompts and images", () => {
  assert.throws(() => validateCreativeEditRequest({ prompt: " ", imageBase64: PNG_B64, mediaType: "image/png" }));
  assert.throws(() => validateCreativeEditRequest({ prompt: "x".repeat(1001), imageBase64: PNG_B64, mediaType: "image/png" }));
  assert.throws(() => validateCreativeEditRequest({ prompt: "ok", imageBase64: "", mediaType: "image/png" }));
  const ok = validateCreativeEditRequest({ prompt: " darker ", imageBase64: PNG_B64, mediaType: "image/png", mode: "live", history: [{ prompt: "first" }, { prompt: "" }, null] });
  assert.equal(ok.prompt, "darker");
  assert.equal(ok.mode, "live");
  assert.deepEqual(ok.history, [{ prompt: "first" }]);
  assert.equal(validateCreativeEditRequest({ prompt: "x", imageBase64: PNG_B64, mediaType: "image/png" }).mode, "disabled");
});

test("GET /api/creative/status is free and reports disabled by default", async () => {
  await withServer(disabledConfig, async () => { throw new Error("no upstream"); }, async (base) => {
    const res = await fetch(`${base}/api/creative/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
    assert.equal(body.model, "muse-image-1.0");
  });
});

test("non-live edit is refused 501 before any Meta call", async () => {
  let calls = 0;
  await withServer(liveConfig, async () => { calls += 1; throw new Error("must not be called"); }, async (base) => {
    const res = await fetch(`${base}/api/creative/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: PNG_B64, mediaType: "image/png", prompt: "Make it darker" }),
    });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error, "image_editing_unverified");
    assert.equal(calls, 0);
  });
});

test("live edit without the token is rejected 403 before any Meta call", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  let calls = 0;
  await withServer(liveConfig, async () => { calls += 1; throw new Error("must not be called"); }, async (base) => {
    const res = await fetch(`${base}/api/creative/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: PNG_B64, mediaType: "image/png", prompt: "Make it darker", mode: "live" }),
    });
    assert.equal(res.status, 403);
    assert.equal(calls, 0);
  });
});

test("mocked live edit returns the validated PNG and sends one upstream request", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(200, { status: "completed", output: [{ type: "image_generation_call", result: PNG_B64 }] });
  };
  await withServer(liveConfig, fetchImpl, async (base) => {
    const res = await fetch(`${base}/api/creative/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": "test-token-not-real" },
      body: JSON.stringify({ imageBase64: PNG_B64, mediaType: "image/png", prompt: "Make the background darker", mode: "live", history: [{ prompt: "Improve lighting" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, "muse-image-1.0");
    assert.equal(body.imageDataUrl, `data:image/png;base64,${PNG_B64}`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, "muse-image-1.0");
    assert.equal(seen[0].body.tools[0].type, "image_generation");
    // No credential or upstream detail leaks into the browser response.
    assert.doesNotMatch(JSON.stringify(body), /test-key-not-real|Authorization/);
  });
});

test("mocked live follow-up sends the latest generated image as the next input", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return jsonResponse(200, { status: "completed", output: [{ type: "image_generation_call", result: PNG_B64 }] });
  };
  await withServer(liveConfig, fetchImpl, async (base) => {
    // The client sends the previous result (here the same PNG fixture)
    // as imageBase64 for the follow-up; the server must forward exactly
    // that image with the new instruction and prior prompt context.
    const res = await fetch(`${base}/api/creative/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": "test-token-not-real" },
      body: JSON.stringify({ imageBase64: PNG_B64, mediaType: "image/png", prompt: "Add warm lighting", mode: "live", history: [{ prompt: "Improve lighting" }] }),
    });
    assert.equal(res.status, 200);
    const content = seen[0].input[0].content;
    assert.equal(content[1].image_url, `data:image/png;base64,${PNG_B64}`);
    assert.match(content[0].text, /Improve lighting/);
    assert.match(content[0].text, /Current instruction: Add warm lighting/);
  });
});

test("live edit rejects unsupported images with 400 before any Meta call", async () => {
  let calls = 0;
  await withServer(liveConfig, async () => { calls += 1; throw new Error("must not be called"); }, async (base) => {
    const res = await fetch(`${base}/api/creative/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": "test-token-not-real" },
      body: JSON.stringify({ imageBase64: Buffer.from("not an image").toString("base64"), mediaType: "image/png", prompt: "Make it darker", mode: "live" }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls, 0);
  });
});
