import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeterministicAdvice,
  buildVerifiedEvidence,
  findUngroundedNumbers,
  formatMinor,
  validateAdviceRequest,
  validateModelAdvice,
} from "../buckyAdvice.mjs";
import { buildMetaAdviceRequest, META_MODEL_ID, parseMetaAdviceResponse } from "../metaClient.mjs";
import { createAppServer } from "../server.mjs";

function summary(over = {}) {
  return {
    profileName: "Sari Store",
    profileKind: "business",
    currencies: [
      {
        currency: "PHP",
        incomeMinor: 100000,
        expenseMinor: 40000,
        netCashFlowMinor: 60000,
        transactionCount: 5,
        posRevenueMinor: 30000,
        posSaleCount: 2,
        topExpenseCategories: [{ category: "Supplies", totalMinor: 25000 }],
        monthExpenseChangePct: 50,
      },
    ],
    insightKinds: ["cash-flow", "pos", "month-change"],
    duplicateGroupCount: 1,
    lowStockCount: 2,
    limitations: ["Net cash flow is recorded income minus recorded expenses. It is not profit and not a bank balance."],
    ...over,
  };
}

function payload(over = {}) {
  return { question: "How is my cash flow?", mode: "fallback", summary: summary(), ...over };
}

test("validateAdviceRequest accepts the aggregated summary shape and normalises it", () => {
  const v = validateAdviceRequest(payload({ question: "  How   is my cash flow? " }));
  assert.equal(v.question, "How is my cash flow?");
  assert.equal(v.summary.currencies[0].currency, "PHP");
});

test("validateAdviceRequest rejects raw-record smuggling and unknown keys", () => {
  assert.throws(() => validateAdviceRequest(payload({ transactions: [] })), /could not be understood/);
  assert.throws(
    () => validateAdviceRequest(payload({ summary: summary({ transactions: [{ description: "raw" }] }) })),
    /could not be understood/,
  );
  const badCurrency = summary();
  badCurrency.currencies[0] = { ...badCurrency.currencies[0], description: "raw description" };
  assert.throws(() => validateAdviceRequest(payload({ summary: badCurrency })), /could not be understood/);
});

test("validateAdviceRequest rejects bad amounts, currencies, modes, and overlong questions", () => {
  assert.throws(() => validateAdviceRequest(payload({ mode: "auto" })), /could not be understood/);
  assert.throws(() => validateAdviceRequest(payload({ question: "x".repeat(501) })), /could not be understood/);
  const floatAmount = summary();
  floatAmount.currencies[0] = { ...floatAmount.currencies[0], incomeMinor: 1.5 };
  assert.throws(() => validateAdviceRequest(payload({ summary: floatAmount })), /could not be understood/);
  const badCode = summary();
  badCode.currencies[0] = { ...badCode.currencies[0], currency: "php!" };
  assert.throws(() => validateAdviceRequest(payload({ summary: badCode })), /could not be understood/);
});

test("formatMinor respects zero-decimal currencies", () => {
  assert.equal(formatMinor(500, "JPY"), "JPY 500");
  assert.equal(formatMinor(25000, "PHP"), "PHP 250.00");
  assert.equal(formatMinor(-150, "USD"), "-USD 1.50");
});

test("deterministic fallback separates POS revenue from income and never calls it profit", () => {
  const advice = buildDeterministicAdvice({ question: "How much did my business earn?", summary: summary() });
  assert.match(advice.answer, /POS revenue/);
  assert.match(advice.answer, /not profit/);
  assert.ok(advice.suggestedActions.every((a) => a.route.startsWith("/")));
  const noPos = buildDeterministicAdvice({
    question: "How much POS revenue?",
    summary: summary({ currencies: [{ ...summary().currencies[0], posRevenueMinor: 0, posSaleCount: 0 }] }),
  });
  assert.match(noPos.answer, /No completed POS sales/);
});

test("deterministic fallback is honest when there is no data", () => {
  const empty = summary({
    currencies: [{ currency: "PHP", incomeMinor: 0, expenseMinor: 0, netCashFlowMinor: 0, transactionCount: 0, posRevenueMinor: 0, posSaleCount: 0, topExpenseCategories: [], monthExpenseChangePct: null }],
    duplicateGroupCount: 0,
    lowStockCount: 0,
  });
  const advice = buildDeterministicAdvice({ question: "Overview?", summary: empty });
  assert.match(advice.answer, /don't have any saved/);
  assert.deepEqual(advice.evidence, []);
});

test("verified evidence is computed from the summary, per currency", () => {
  const evidence = buildVerifiedEvidence(summary());
  assert.ok(evidence.some((e) => e.value === "PHP 1000.00"));
  assert.ok(evidence.some((e) => /POS revenue/.test(e.label) && e.value === "PHP 300.00"));
});

test("grounding check flags invented numbers but allows summary figures", () => {
  assert.deepEqual(findUngroundedNumbers("Income was PHP 1000.00 and rose 50%.", summary()), []);
  const bad = findUngroundedNumbers("You spent PHP 9999.99 on ads and sales rose 87%.", summary());
  assert.ok(bad.includes("9999.99"));
  assert.ok(bad.includes("87%"));
});

test("validateModelAdvice accepts grounded allowlisted output", () => {
  const ok = validateModelAdvice(
    {
      answer: "Expenses rose 50% this month, driven by Supplies at PHP 250.00.",
      explanation: "Net cash flow remains PHP 600.00, which is not profit.",
      evidence: [{ label: "Expenses", value: "PHP 400.00" }],
      suggestedActionIds: ["review-categories"],
      limitations: ["Based only on recorded summaries."],
    },
    summary(),
  );
  assert.deepEqual(ok.suggestedActions, [{ id: "review-categories", label: "Review expense categories", route: "/transactions" }]);
});

test("validateModelAdvice rejects unknown actions, oversized text, and invented numbers", () => {
  const base = {
    answer: "All good.",
    explanation: "Nothing to explain.",
    evidence: [],
    suggestedActionIds: [],
    limitations: [],
  };
  assert.throws(() => validateModelAdvice({ ...base, suggestedActionIds: ["delete-records"] }, summary()), /could not be reached/);
  assert.throws(() => validateModelAdvice({ ...base, answer: "x".repeat(1201) }, summary()), /could not be reached/);
  assert.throws(
    () => validateModelAdvice({ ...base, answer: "You earned PHP 12345.67 in profit." }, summary()),
    /could not be reached/,
  );
  assert.throws(() => validateModelAdvice({ ...base, runQuery: "DROP" }, summary()), /could not be reached/);
});

test("buildMetaAdviceRequest uses the configured model, strict schema, and no image", () => {
  const req = buildMetaAdviceRequest({ question: "Hi?", summary: summary(), apiKey: "test-key" });
  assert.equal(req.body.model, META_MODEL_ID);
  assert.equal(req.body.text.format.type, "json_schema");
  assert.equal(req.body.text.format.strict, true);
  assert.ok(!JSON.stringify(req.body).includes("input_image"));
  assert.equal(req.headers.Authorization, "Bearer test-key");
});

test("parseMetaAdviceResponse parses Responses text and fails safely on junk", () => {
  const parsed = parseMetaAdviceResponse({ output_text: JSON.stringify({ answer: "x" }) });
  assert.equal(parsed.answer, "x");
  assert.throws(() => parseMetaAdviceResponse({ output_text: "not json" }), /could not be reached/);
  assert.throws(() => parseMetaAdviceResponse({}), /could not be reached/);
});

// --- Endpoint tests (fake fetch only; no network, no live calls) ---

async function withServer(config, deps, run) {
  const server = createAppServer(config, deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const mockConfig = {
  host: "127.0.0.1",
  port: 0,
  modelApiKeyConfigured: false,
  liveMetaEnabled: false,
  liveTestTokenConfigured: false,
};

async function postAdvise(base, body, headers = {}) {
  const res = await fetch(`${base}/api/bucky/advise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("POST /api/bucky/advise returns labelled deterministic fallback by default", async () => {
  await withServer(mockConfig, {}, async (base) => {
    const { status, json } = await postAdvise(base, payload());
    assert.equal(status, 200);
    assert.equal(json.source, "deterministic-fallback");
    assert.equal(json.model, null);
    assert.ok(json.evidence.some((e) => e.value === "PHP 1000.00"));
    assert.ok(json.suggestedActions.every((a) => !/delete|drop|exec/i.test(a.id)));
  });
});

test("POST /api/bucky/advise rejects invalid payloads and oversized bodies", async () => {
  await withServer(mockConfig, {}, async (base) => {
    const bad = await postAdvise(base, { question: "hi", summary: { nope: true } });
    assert.equal(bad.status, 400);
    const huge = await postAdvise(base, { question: "x".repeat(20000), summary: summary() });
    assert.equal(huge.status, 413);
  });
});

test("live advise without gates is an explicit error, never a silent fallback", async () => {
  await withServer(mockConfig, {}, async (base) => {
    const { status, json } = await postAdvise(base, payload({ mode: "live" }));
    assert.equal(status, 403);
    assert.equal(json.error, "live_disabled");
  });
});

test("live advise with a fake Meta response returns validated meta-live advice", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  try {
    const liveConfig = { ...mockConfig, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true };
    const fakeFetch = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: JSON.stringify({
            answer: "Expenses rose 50% this month, with Supplies the largest category at PHP 250.00.",
            explanation: "POS revenue is PHP 300.00, reported separately from income and not profit.",
            evidence: [{ label: "model-made", value: "ignored" }],
            suggestedActionIds: ["review-categories", "view-pos"],
            limitations: ["Based on recorded summaries only."],
          }),
        }),
    });
    await withServer(liveConfig, { fetchImpl: fakeFetch }, async (base) => {
      const { status, json } = await postAdvise(base, payload({ mode: "live" }), { "x-bucketa-live-test": "test-token-not-real" });
      assert.equal(status, 200);
      assert.equal(json.source, "meta-live");
      assert.equal(json.model, META_MODEL_ID);
      // Evidence is server-computed, never the model's invented evidence.
      assert.ok(!json.evidence.some((e) => e.label === "model-made"));
      assert.ok(json.evidence.some((e) => e.value === "PHP 1000.00"));
    });
  } finally {
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});

test("live advise falls back (labelled) when the model invents numbers", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  try {
    const liveConfig = { ...mockConfig, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true };
    const fakeFetch = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: JSON.stringify({
            answer: "You made PHP 77777.77 profit from ads.",
            explanation: "Trust me.",
            evidence: [],
            suggestedActionIds: [],
            limitations: [],
          }),
        }),
    });
    await withServer(liveConfig, { fetchImpl: fakeFetch }, async (base) => {
      const { status, json } = await postAdvise(base, payload({ mode: "live" }), { "x-bucketa-live-test": "test-token-not-real" });
      assert.equal(status, 200);
      assert.equal(json.source, "deterministic-fallback");
      assert.ok(json.limitations.some((l) => /failed validation/.test(l)));
    });
  } finally {
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});
