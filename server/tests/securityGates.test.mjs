import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.mjs";

/**
 * Security-gate tests. The injected fetchImpl throws if reached and
 * counts calls, proving unauthorized/invalid requests are rejected
 * BEFORE any paid upstream call. No live Meta requests are made.
 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

const summary = {
  profileName: "Test Biz", profileKind: "business",
  currencies: [{ currency: "PHP", incomeMinor: 100000, expenseMinor: 40000, netCashFlowMinor: 60000, transactionCount: 5, posRevenueMinor: 30000, posSaleCount: 2, topExpenseCategories: [{ category: "Supplies", totalMinor: 25000 }], monthExpenseChangePct: 50 }],
  insightKinds: ["cash-flow"], duplicateGroupCount: 0, lowStockCount: 0,
  limitations: ["Net cash flow is recorded income minus recorded expenses."],
};

async function withGuardedServer(run) {
  let metaCalls = 0;
  const server = createAppServer(
    { host: "127.0.0.1", port: 0, modelApiKeyConfigured: false, liveMetaEnabled: false },
    { fetchImpl: async () => { metaCalls += 1; throw new Error("Meta must not be called"); } },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, () => metaCalls); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("paid endpoints reject live mode when server gates are off, with zero upstream calls", async () => {
  await withGuardedServer(async (base, metaCalls) => {
    const advise = await post(base, "/api/bucky/advise", { question: "How are sales?", mode: "live", summary });
    assert.equal(advise.status, 403);
    assert.equal(advise.json.error, "live_disabled");

    const interpret = await post(base, "/api/bucky/interpret", { text: "Roger got his salary", mode: "live", context: { profileName: "Test Biz", profileKind: "business", currency: "PHP", bucketNames: [], employeeNames: [] } });
    assert.equal(interpret.status, 403);

    const extract = await post(base, "/api/extract", { imageBase64: PNG_B64, mediaType: "image/png", mode: "live", expectedCurrency: "PHP" });
    assert.equal(extract.status, 403);

    const product = await post(base, "/api/products/analyze", { imageBase64: PNG_B64, mediaType: "image/png", mode: "live" });
    assert.equal(product.status, 403);

    const creative = await post(base, "/api/creative/edit", { imageBase64: PNG_B64, mediaType: "image/png", prompt: "Make it darker" });
    assert.equal(creative.status, 501);
    assert.equal(creative.json.error, "image_editing_unverified");

    assert.equal(metaCalls(), 0);
  });
});

test("browser cannot unlock live mode or select a model/endpoint via body fields", async () => {
  await withGuardedServer(async (base, metaCalls) => {
    // Extra attacker-controlled keys are rejected by strict validation.
    const advise = await post(base, "/api/bucky/advise", { question: "hi", mode: "live", summary, model: "attacker-model", url: "https://example.invalid/" });
    assert.equal(advise.status, 400);
    // No browser-supplied field or header can enable live mode while the server gate is off.
    const forged = await post(base, "/api/bucky/advise", { question: "hi", mode: "live", summary }, { Origin: "https://evil.example" });
    assert.equal(forged.status, 403);
    assert.equal(metaCalls(), 0);
  });
});

test("live scanner failure returns an error with no fabricated entries", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  let calls = 0;
  const server = createAppServer(
    { host: "127.0.0.1", port: 0, modelApiKeyConfigured: true, liveMetaEnabled: true },
    { fetchImpl: async () => { calls += 1; return { status: 500, text: async () => JSON.stringify({ error: "upstream detail must not leak" }) }; } },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const live = await post(base, "/api/extract", { imageBase64: PNG_B64, mediaType: "image/png", mode: "live", expectedCurrency: "USD" }, { Origin: "http://localhost:5173" });
    assert.equal(live.status, 502);
    assert.equal(live.json.error, "meta_unavailable");
    assert.equal("entries" in live.json, false);
    const evil = await post(base, "/api/extract", { imageBase64: PNG_B64, mediaType: "image/png", mode: "live", expectedCurrency: "USD" }, { Origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error, "live_unauthorized");
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MODEL_API_KEY;
  }
});

test("error responses never contain upstream bodies, credentials, or stack detail", async () => {
  await withGuardedServer(async (base) => {
    const { json } = await post(base, "/api/bucky/advise", { question: "hi", mode: "live", summary });
    const text = JSON.stringify(json);
    assert.doesNotMatch(text, /Bearer|MODEL_API_KEY|at\s+\w+\s+\(|stack/i);
    assert.ok(json.error && json.message);
  });
});
