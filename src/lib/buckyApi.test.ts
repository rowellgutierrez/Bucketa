import assert from "node:assert/strict";
import test from "node:test";
import { BuckyApiError, requestBuckyAdvice, type BuckyModelSummary } from "./buckyApi.ts";

const summary: BuckyModelSummary = {
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
  insightKinds: ["cash-flow"],
  duplicateGroupCount: 0,
  lowStockCount: 0,
  limitations: [],
};

const adviceBody = {
  source: "deterministic-fallback",
  model: null,
  answer: "Calculated answer.",
  explanation: "From recorded summaries.",
  evidence: [{ label: "PHP income", value: "PHP 1000.00" }],
  suggestedActions: [{ id: "view-transactions", label: "View transactions", route: "/transactions" }],
  limitations: [],
};

async function withFetch(impl: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("fallback advice posts only the aggregated summary and returns labelled source", async () => {
  let seenBody = "";
  await withFetch(
    async (_input, init) => {
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify(adviceBody), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    async () => {
      const res = await requestBuckyAdvice("How is my cash flow?", summary);
      assert.equal(res.source, "deterministic-fallback");
      assert.equal(res.model, null);
      const sent = JSON.parse(seenBody);
      assert.equal(sent.mode, "fallback");
      // No raw records or descriptions are ever sent.
      assert.ok(!("transactions" in sent));
      assert.ok(!seenBody.includes("description"));
    },
  );
});

test("live advice without a runtime token fails before any fetch", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      throw new Error("must not be called");
    },
    async () => {
      await assert.rejects(
        () => requestBuckyAdvice("Why?", summary, { mode: "live" }),
        (e: unknown) => e instanceof BuckyApiError && e.code === "live_token_required",
      );
      assert.equal(calls, 0);
    },
  );
});

test("live advice forwards the runtime token only as a header", async () => {
  let seenToken = "";
  await withFetch(
    async (_input, init) => {
      seenToken = new Headers(init?.headers).get("x-bucketa-live-test") ?? "";
      return new Response(
        JSON.stringify({ ...adviceBody, source: "meta-live", model: "muse-spark-1.3" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
    async () => {
      const res = await requestBuckyAdvice("Why?", summary, { mode: "live", liveTestToken: "rt-token" });
      assert.equal(seenToken, "rt-token");
      assert.equal(res.source, "meta-live");
    },
  );
});

test("server errors and malformed responses become safe BuckyApiErrors", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ error: "live_disabled" }), { status: 403 }),
    async () => {
      await assert.rejects(
        () => requestBuckyAdvice("Why?", summary),
        (e: unknown) => e instanceof BuckyApiError && /not enabled/.test(e.message) && !/stack/.test(e.message),
      );
    },
  );
  await withFetch(
    async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    async () => {
      await assert.rejects(
        () => requestBuckyAdvice("Why?", summary),
        (e: unknown) => e instanceof BuckyApiError && e.code === "invalid_response",
      );
    },
  );
  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      await assert.rejects(
        () => requestBuckyAdvice("Why?", summary),
        (e: unknown) => e instanceof BuckyApiError && e.code === "backend_offline",
      );
    },
  );
});
