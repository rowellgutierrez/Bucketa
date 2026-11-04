import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createAppServer } from "../server.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const DUMMY_KEY = "LLM_test_dummy_do_not_log";

let server;
let baseUrl;

before(async () => {
  process.env.MODEL_API_KEY = DUMMY_KEY;
  const { getConfig } = await import("../config.mjs");
  server = createAppServer({ ...getConfig(), host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MODEL_API_KEY;
});

test("health reports live status without exposing the key or any quota", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // ENABLE_LIVE_META is not "1" in this test process, so live stays disabled even with a key present.
  assert.equal(body.liveMeta, "disabled");
  assert.equal(body.modelApiKeyConfigured, true);
  assert.equal("liveRequestsLimit" in body, false);
  assert.equal("liveRequestsUsed" in body, false);
  assert.equal(JSON.stringify(body).includes(DUMMY_KEY), false);
});

test("extract rejects missing or mock mode with no fictional entries", async () => {
  for (const mode of [undefined, "mock", "invalid"]) {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: PNG_BYTES.toString("base64"),
        mediaType: "image/png",
        expectedCurrency: "PHP",
        recordType: "expenses",
        ...(mode === undefined ? {} : { mode }),
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_request");
    assert.equal("entries" in body, false);
    assert.equal(JSON.stringify(body).includes(DUMMY_KEY), false);
  }
});

test("extract rejects mismatched image bytes with a safe error", async () => {
  const res = await fetch(`${baseUrl}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: Buffer.from("not an image").toString("base64"),
      mediaType: "image/png",
      expectedCurrency: "PHP",
      mode: "live",
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "unsupported_image");
  assert.equal(JSON.stringify(body).includes(DUMMY_KEY), false);
});

test("unknown routes return a safe 404", async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
});
