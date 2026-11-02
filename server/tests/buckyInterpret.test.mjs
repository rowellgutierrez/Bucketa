import assert from "node:assert/strict";
import test from "node:test";
import {
  validateInterpretRequest,
  validateModelInterpretation,
} from "../buckyInterpret.mjs";
import { META_MODEL_ID } from "../metaClient.mjs";
import { createAppServer } from "../server.mjs";

/**
 * Phase D interpret endpoint tests. Fake fetch only — no network and no
 * live calls. The model is never trusted: proposals are schema-validated
 * here and cross-checked again in the browser before any preview.
 */

function context(over = {}) {
  return {
    profileName: "Sari Store",
    profileKind: "business",
    currency: "PHP",
    bucketNames: ["iPhone"],
    employeeNames: ["Roger", "Maria"],
    ...over,
  };
}

function payload(over = {}) {
  return { text: "Roger got his ₱1,000 salary for November 1, 2026", mode: "fallback", context: context(), ...over };
}

test("validateInterpretRequest accepts names-only context and rejects smuggled fields", () => {
  const v = validateInterpretRequest(payload({ text: "  Pay   Roger " }));
  assert.equal(v.text, "Pay Roger");
  assert.deepEqual(v.context.employeeNames, ["Roger", "Maria"]);
  assert.throws(() => validateInterpretRequest(payload({ transactions: [] })), /could not be understood/);
  assert.throws(() => validateInterpretRequest(payload({ context: context({ salaryRateMinor: 5 }) })), /could not be understood/);
  assert.throws(() => validateInterpretRequest(payload({ context: context({ currency: "php!" }) })), /could not be understood/);
  assert.throws(() => validateInterpretRequest(payload({ mode: "auto" })), /could not be understood/);
  assert.throws(() => validateInterpretRequest(payload({ text: "x".repeat(501) })), /could not be understood/);
});

test("validateModelInterpretation normalises a well-formed proposal", () => {
  const p = validateModelInterpretation({
    kind: "salary-payment",
    amountMinor: 100000,
    date: "2026-11-01",
    description: null,
    category: null,
    bucketName: null,
    employeeName: "roger",
    paymentType: "salary",
  }, context());
  assert.equal(p.kind, "salary-payment");
  // Name resolved to the canonical spelling from the real list.
  assert.equal(p.employeeName, "Roger");
  assert.equal(p.paymentType, "salary");
});

test("validateModelInterpretation rejects fabricated people, goals, and types", () => {
  const base = {
    kind: "salary-payment",
    amountMinor: 100000,
    date: "2026-11-01",
    description: null,
    category: null,
    bucketName: null,
    employeeName: "Nobody",
    paymentType: "salary",
  };
  assert.throws(() => validateModelInterpretation(base, context()));
  assert.throws(() => validateModelInterpretation({ ...base, employeeName: "Roger", paymentType: "gift" }, context()));
  assert.throws(() => validateModelInterpretation({ ...base, employeeName: "Roger", amountMinor: 1.5 }, context()));
  assert.throws(() => validateModelInterpretation({ ...base, employeeName: "Roger", date: "2026-02-30" }, context()));
  assert.throws(() => validateModelInterpretation({ ...base, employeeName: "Roger", extra: 1 }, context()));
  const goal = { ...base, kind: "savings-contribution", employeeName: null, paymentType: null, bucketName: "House" };
  assert.throws(() => validateModelInterpretation(goal, context()));
  assert.deepEqual(
    validateModelInterpretation({ ...goal, kind: "none", bucketName: null }, context()),
    { kind: "none" },
  );
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

async function postInterpret(base, body, headers = {}) {
  const res = await fetch(`${base}/api/bucky/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("fallback mode never calls the model and returns no proposal", async () => {
  let called = 0;
  const fakeFetch = async () => { called += 1; throw new Error("must not be called"); };
  await withServer(mockConfig, { fetchImpl: fakeFetch }, async (base) => {
    const { status, json } = await postInterpret(base, payload());
    assert.equal(status, 200);
    assert.equal(json.source, "deterministic");
    assert.equal(json.proposal, null);
    assert.equal(called, 0);
  });
});

test("live interpret without gates is an explicit error, never a silent downgrade", async () => {
  await withServer(mockConfig, {}, async (base) => {
    const { status, json } = await postInterpret(base, payload({ mode: "live" }));
    assert.equal(status, 403);
    assert.equal(json.error, "live_disabled");
  });
});

test("live interpret returns a validated proposal from a fake model response", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  try {
    const liveConfig = { ...mockConfig, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true };
    const fakeFetch = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: JSON.stringify({
            kind: "salary-payment",
            amountMinor: 100000,
            date: "2026-11-01",
            description: null,
            category: null,
            bucketName: null,
            employeeName: "Roger",
            paymentType: "salary",
          }),
        }),
    });
    await withServer(liveConfig, { fetchImpl: fakeFetch }, async (base) => {
      const { status, json } = await postInterpret(base, payload({ mode: "live" }), { "x-bucketa-live-test": "test-token-not-real" });
      assert.equal(status, 200);
      assert.equal(json.source, "meta-live");
      assert.equal(json.model, META_MODEL_ID);
      assert.equal(json.proposal.employeeName, "Roger");
      assert.equal(json.proposal.amountMinor, 100000);
    });
  } finally {
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});

test("live interpret degrades to no-proposal when the model invents an employee", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  try {
    const liveConfig = { ...mockConfig, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true };
    const fakeFetch = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          output_text: JSON.stringify({
            kind: "salary-payment",
            amountMinor: 100000,
            date: "2026-11-01",
            description: null,
            category: null,
            bucketName: null,
            employeeName: "Ghost",
            paymentType: "salary",
          }),
        }),
    });
    await withServer(liveConfig, { fetchImpl: fakeFetch }, async (base) => {
      const { status, json } = await postInterpret(base, payload({ mode: "live" }), { "x-bucketa-live-test": "test-token-not-real" });
      assert.equal(status, 200);
      assert.equal(json.source, "deterministic");
      assert.equal(json.proposal, null);
      assert.ok(json.diagnostic);
    });
  } finally {
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});
