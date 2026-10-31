import assert from "node:assert/strict";
import test from "node:test";
import { parseMetaAdviceResponse, parseMetaExtractionResponse, sendMetaAdvice, sendMetaEnvelope, sendToMeta } from "../metaClient.mjs";
import { validateModelAdvice } from "../buckyAdvice.mjs";
import { MetaDiagnosticError, metaDiagnosticLogLine, safeMetaDiagnostic } from "../metaDiagnostics.mjs";
import { createAppServer } from "../server.mjs";

const REQUEST = {
  url: "https://api.meta.ai/v1/responses",
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer SECRET-KEY-MUST-NOT-LEAK" },
  body: { model: "muse-spark-1.3", input: [] },
};

function httpResponse(status, text = "") {
  return async () => ({ status, text: async () => text });
}

function categoryOf(promiseOrFn) {
  return Promise.resolve()
    .then(typeof promiseOrFn === "function" ? promiseOrFn : () => promiseOrFn)
    .then(
      () => null,
      (err) => safeMetaDiagnostic(err),
    );
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

test("401/403 are auth_failure, 404 endpoint_not_found, 429 rate_limited, 500 upstream_http", async () => {
  for (const [status, category] of [[401, "auth_failure"], [403, "auth_failure"], [404, "endpoint_not_found"], [429, "rate_limited"], [500, "upstream_http"], [502, "upstream_http"]]) {
    const diag = await categoryOf(() => sendMetaEnvelope(REQUEST, httpResponse(status, "upstream body with SECRET")));
    assert.equal(diag.category, category, `status ${status}`);
    assert.equal(diag.upstreamStatus, status);
    assert.equal(typeof diag.elapsedMs, "number");
  }
});

test("network errors and timeouts are distinguished without leaking internals", async () => {
  const network = await categoryOf(() =>
    sendMetaEnvelope(REQUEST, async () => {
      throw new TypeError("fetch failed: SECRET-KEY-MUST-NOT-LEAK at api.meta.ai");
    }),
  );
  assert.equal(network.category, "network_error");
  assert.equal(network.upstreamStatus, null);

  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted SECRET")));
    });
  const timed = await categoryOf(() => sendMetaEnvelope(REQUEST, hanging, { timeoutMs: 25 }));
  assert.equal(timed.category, "timeout");
});

test("diagnostic errors keep the public message and never carry secrets or stacks", async () => {
  const err = await sendMetaEnvelope(REQUEST, httpResponse(403, "SECRET body")).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof MetaDiagnosticError);
  assert.equal(err.code, "meta_unavailable");
  assert.equal(err.status, 502);
  assert.match(err.message, /could not be reached/);
  const line = metaDiagnosticLogLine("bucky-advise/live", safeMetaDiagnostic(err));
  assert.equal(line, `meta-diagnostic scope=bucky-advise/live category=auth_failure upstreamStatus=403 elapsedMs=${err.elapsedMs}`);
  assert.ok(!line.includes("SECRET"));
  assert.ok(!JSON.stringify(safeMetaDiagnostic(err)).includes("SECRET"));
});

test("invalid JSON, invalid envelope, and oversized bodies are distinct categories", async () => {
  assert.equal((await categoryOf(() => sendMetaEnvelope(REQUEST, httpResponse(200, "not json")))).category, "invalid_json");
  assert.equal((await categoryOf(() => sendMetaEnvelope(REQUEST, httpResponse(200, "{}"), { maxResponseBytes: 1 }))).category, "invalid_envelope");
  assert.equal((await categoryOf(async () => parseMetaExtractionResponse({}))).category, "invalid_envelope");
  assert.equal((await categoryOf(async () => parseMetaExtractionResponse({ output_text: "{oops" }))).category, "invalid_json");
  assert.equal((await categoryOf(async () => parseMetaAdviceResponse({ output_text: "[1,2]" }))).category, "invalid_envelope");
});

test("schema-validation and grounding-validation failures have their own categories", async () => {
  const base = { answer: "All good.", explanation: "Fine.", evidence: [], suggestedActionIds: [], limitations: [] };
  assert.equal(
    (await categoryOf(async () => validateModelAdvice({ ...base, suggestedActionIds: ["delete-records"] }, summary))).category,
    "schema_validation",
  );
  assert.equal(
    (await categoryOf(async () => validateModelAdvice({ ...base, answer: "You earned PHP 99999.99 profit." }, summary))).category,
    "grounding_validation",
  );
  // Valid scanner parsing still works (existing behaviour preserved).
  const parsed = await sendToMeta(REQUEST, httpResponse(200, JSON.stringify({ output_text: JSON.stringify({ entries: [] }) })));
  assert.deepEqual(parsed, { entries: [] });
  const advice = await sendMetaAdvice(
    REQUEST,
    httpResponse(200, JSON.stringify({ output_text: JSON.stringify({ answer: "x" }) })),
  );
  assert.deepEqual(advice, { answer: "x" });
});

test("non-diagnostic errors collapse to unknown with no leaked details", () => {
  const diag = safeMetaDiagnostic(new Error("SECRET nested failure"));
  assert.deepEqual(diag, { category: "unknown", upstreamStatus: null, elapsedMs: null, subReason: null });
  assert.ok(!metaDiagnosticLogLine("x", diag).includes("SECRET"));
});

test("live advise endpoint returns a safe diagnostic category on upstream failure", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  const server = createAppServer(
    { host: "127.0.0.1", port: 0, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true },
    { fetchImpl: httpResponse(401, "SECRET upstream body") },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/bucky/advise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": "test-token-not-real" },
      body: JSON.stringify({ question: "How is my cash flow?", mode: "live", summary }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.source, "deterministic-fallback");
    assert.deepEqual(json.diagnostic, { category: "auth_failure", upstreamStatus: 401, subReason: null });
    assert.ok(!JSON.stringify(json).includes("SECRET"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});
