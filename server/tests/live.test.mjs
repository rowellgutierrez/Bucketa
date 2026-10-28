import assert from "node:assert/strict";
import test from "node:test";
import { parseMetaExtractionResponse, sendToMeta } from "../metaClient.mjs";
import { assertLiveAllowed, createLiveLimiter } from "../liveGate.mjs";

const REQUEST = {
  url: "https://api.meta.ai/v1/responses",
  method: "POST",
  headers: { Authorization: "Bearer test-dummy-key" },
  body: { model: "muse-spark-1.3" },
};

function jsonResponse(status, value) {
  return { status, text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
}

test("parses Responses output_text and Chat Completions shapes", () => {
  const entries = { entries: [{ description: "Test", amountText: "1.00" }] };
  assert.deepEqual(parseMetaExtractionResponse({ output_text: JSON.stringify(entries) }), entries);
  assert.deepEqual(
    parseMetaExtractionResponse({ choices: [{ message: { content: JSON.stringify(entries) } }] }),
    entries,
  );
});

test("malformed or total-only model output fails safely", () => {
  assert.throws(() => parseMetaExtractionResponse({ output_text: "not json" }), /could not be reached/);
  assert.throws(() => parseMetaExtractionResponse({ output_text: '{"total": 5}' }), /could not be reached/);
  assert.throws(() => parseMetaExtractionResponse({}), /could not be reached/);
});

test("sendToMeta maps upstream failures safely with no retry", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return jsonResponse(500, { error: "upstream detail must not leak" });
  };
  await assert.rejects(() => sendToMeta(REQUEST, failing), /could not be reached/);
  assert.equal(calls, 1);

  const networkDown = async () => {
    throw new Error("socket detail must not leak");
  };
  await assert.rejects(() => sendToMeta(REQUEST, networkDown), /could not be reached/);
});

test("sendToMeta rejects oversized responses", async () => {
  const huge = async () => jsonResponse(200, "x".repeat(2000));
  await assert.rejects(
    () => sendToMeta(REQUEST, huge, { maxResponseBytes: 100 }),
    /could not be reached/,
  );
});

test("live gates require flag, key, and per-request token together", () => {
  const good = {
    liveMetaEnabled: true,
    modelApiKey: "test-dummy-key",
    liveTestToken: "local-test-token",
    requestToken: "local-test-token",
  };
  assert.doesNotThrow(() => assertLiveAllowed(good));
  assert.throws(() => assertLiveAllowed({ ...good, liveMetaEnabled: false }), /not enabled/);
  assert.throws(() => assertLiveAllowed({ ...good, modelApiKey: "" }), /not enabled/);
  assert.throws(() => assertLiveAllowed({ ...good, requestToken: undefined }), /not authorized/);
  assert.throws(() => assertLiveAllowed({ ...good, requestToken: "wrong" }), /not authorized/);
  assert.throws(() => assertLiveAllowed({ ...good, liveTestToken: "" }), /not authorized/);
});

test("limiter allows exactly 3 attempts per session", () => {
  const limiter = createLiveLimiter();
  limiter.consume();
  limiter.consume();
  limiter.consume();
  assert.equal(limiter.used, 3);
  assert.equal(limiter.remaining, 0);
  assert.throws(() => limiter.consume(), /limit/);
});
