import assert from "node:assert/strict";
import test from "node:test";
import { parseMetaAdviceResponse, parseMetaExtractionResponse, sendMetaEnvelope, sendToMeta } from "../metaClient.mjs";
import { safeMetaDiagnostic } from "../metaDiagnostics.mjs";
import { createAppServer } from "../server.mjs";
import { MAX_BODY_BYTES } from "../validateUpload.mjs";

/**
 * Offline compatibility tests (Phase B2.7). Every upstream response is a
 * fictional mocked envelope; no network or live Meta call is made. These
 * tests verify Bucketa's internal parser/transport behaviour only — they
 * do not prove what Meta's live API returns.
 */

const REQUEST = {
  url: "https://api.meta.ai/v1/responses",
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer test-dummy-key" },
  body: { model: "muse-spark-1.3", input: [] },
};

function categoryOf(fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => null,
      (err) => safeMetaDiagnostic(err),
    );
}

const adviceJson = JSON.stringify({ answer: "x", explanation: "y", suggestedActionIds: [], limitations: [] });

test("existing output_text and output[].content shapes still parse", () => {
  assert.equal(parseMetaAdviceResponse({ output_text: adviceJson }).answer, "x");
  const viaOutput = parseMetaAdviceResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: adviceJson }] }],
  });
  assert.equal(viaOutput.answer, "x");
  // Untyped text parts (earlier mocked shape) remain supported.
  const untyped = parseMetaAdviceResponse({ output: [{ content: [{ text: adviceJson }] }] });
  assert.equal(untyped.answer, "x");
  // Scanner extraction shapes are preserved too.
  assert.deepEqual(parseMetaExtractionResponse({ output_text: '{"entries":[]}' }), { entries: [] });
  assert.deepEqual(
    parseMetaExtractionResponse({ choices: [{ message: { content: '{"entries":[]}' } }] }),
    { entries: [] },
  );
});

test("explicit output_text is preferred over unrelated earlier text parts", () => {
  const parsed = parseMetaAdviceResponse({
    output: [
      {
        type: "message",
        content: [
          { type: "reasoning_text", text: "scratch notes that are not the answer" },
          { type: "output_text", text: adviceJson },
        ],
      },
    ],
  });
  assert.equal(parsed.answer, "x");
});

test("explicit refusal and incomplete envelopes fail safely without leaking text", async () => {
  const refusal = {
    output: [{ type: "message", content: [{ type: "refusal", refusal: "SECRET-REFUSAL-TEXT" }] }],
  };
  const diag = await categoryOf(async () => parseMetaAdviceResponse(refusal));
  assert.equal(diag.category, "invalid_envelope");
  assert.ok(!JSON.stringify(diag).includes("SECRET"));

  const incomplete = { status: "incomplete", output: [{ content: [{ type: "output_text", text: adviceJson }] }] };
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse(incomplete))).category, "invalid_envelope");

  const failed = { status: "failed", output_text: adviceJson };
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse(failed))).category, "invalid_envelope");
});

test("empty, scalar, and unsupported envelopes fail safely; truncated JSON is invalid_json", async () => {
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse({}))).category, "invalid_envelope");
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse({ output_text: "" }))).category, "invalid_envelope");
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse({ output: [] }))).category, "invalid_envelope");
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse({ output_text: "[1,2]" }))).category, "invalid_envelope");
  assert.equal(
    (await categoryOf(async () => parseMetaAdviceResponse({ output_text: '{"answer":"x",' }))).category,
    "invalid_json",
  );
  const errEnvelope = { error: { message: "SECRET provider detail" } };
  const diag = await categoryOf(async () => parseMetaAdviceResponse(errEnvelope));
  assert.equal(diag.category, "invalid_envelope");
  assert.ok(!JSON.stringify(diag).includes("SECRET"));
});

test("response cap is enforced in UTF-8 bytes, not string length", async () => {
  // "₱" is 3 UTF-8 bytes but 1 JavaScript string unit: 40 of them are
  // 40 string units yet 120 bytes, over a 100-byte cap.
  const pesoBody = JSON.stringify({ output_text: "₱".repeat(40) });
  assert.ok(pesoBody.length < 120);
  const diag = await categoryOf(() =>
    sendMetaEnvelope(REQUEST, async () => ({ status: 200, text: async () => pesoBody }), { maxResponseBytes: 100 }),
  );
  assert.equal(diag.category, "invalid_envelope");

  // The same character count in ASCII stays under the cap and parses.
  const asciiBody = JSON.stringify({ output_text: JSON.stringify({ entries: [] }) });
  const parsed = await sendToMeta(
    REQUEST,
    async () => ({ status: 200, text: async () => asciiBody }),
    { maxResponseBytes: 100 },
  );
  assert.deepEqual(parsed, { entries: [] });
});

test("sendMetaEnvelope still performs exactly one fetch (no retry)", async () => {
  let calls = 0;
  const diag = await categoryOf(() =>
    sendMetaEnvelope(REQUEST, async () => {
      calls += 1;
      return { status: 500, text: async () => "SECRET upstream" };
    }),
  );
  assert.equal(calls, 1);
  assert.equal(diag.category, "upstream_http");
  assert.ok(!JSON.stringify(diag).includes("SECRET"));
});

async function withServer(deps, run) {
  const server = createAppServer(
    { host: "127.0.0.1", port: 0, modelApiKeyConfigured: false, liveMetaEnabled: false, liveTestTokenConfigured: false },
    deps,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const summary = {
  profileName: "Fictional",
  profileKind: "business",
  currencies: [
    {
      currency: "PHP", incomeMinor: 100000, expenseMinor: 40000, netCashFlowMinor: 60000,
      transactionCount: 5, posRevenueMinor: 0, posSaleCount: 0,
      topExpenseCategories: [], monthExpenseChangePct: null,
    },
  ],
  insightKinds: ["cash-flow"],
  duplicateGroupCount: 0,
  lowStockCount: 0,
  limitations: [],
};

test("Bucky advice rejects bodies over 16,384 bytes with the safe oversized error", async () => {
  await withServer({}, async (base) => {
    const big = JSON.stringify({ question: "q", mode: "fallback", summary, pad: "x" });
    const body = JSON.stringify({ question: "x".repeat(17_000), mode: "fallback", summary });
    assert.ok(Buffer.byteLength(body) > 16_384);
    void big;
    const res = await fetch(`${base}/api/bucky/advise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error, "request_too_large");
    assert.ok(!JSON.stringify(json).includes("xxxx"));
  });
});

test("scanner route keeps its larger streaming allowance (not the Bucky cap)", async () => {
  // A body well above the Bucky cap but below MAX_BODY_BYTES must reach
  // scanner validation (and fail there as an invalid request/image),
  // rather than being rejected as request_too_large by the reader.
  assert.ok(20_000 < MAX_BODY_BYTES);
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "x".repeat(20_000), mediaType: "image/png" }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.notEqual(json.error, "request_too_large");
  });
});
