import assert from "node:assert/strict";
import test from "node:test";
import { BUCKY_ADVICE_JSON_SCHEMA, validateModelAdvice } from "../buckyAdvice.mjs";
import { safeMetaDiagnostic, SCHEMA_DIAGNOSTIC_SUBREASONS } from "../metaDiagnostics.mjs";
import { createAppServer } from "../server.mjs";

const summary = {
  profileName: "Fictional Sari Store",
  profileKind: "business",
  currencies: [
    {
      currency: "PHP", incomeMinor: 250000, expenseMinor: 115000, netCashFlowMinor: 135000,
      transactionCount: 5, posRevenueMinor: 0, posSaleCount: 0,
      topExpenseCategories: [{ category: "Supplies", totalMinor: 70000 }],
      monthExpenseChangePct: null,
    },
  ],
  insightKinds: ["cash-flow"],
  duplicateGroupCount: 0,
  lowStockCount: 0,
  limitations: [],
};

function validAdvice(over = {}) {
  return {
    answer: "Net cash flow is PHP 1350.00 from income PHP 2500.00 minus expenses PHP 1150.00. This is not profit.",
    explanation: "Calculated from recorded transactions in PHP only.",
    suggestedActionIds: ["view-transactions"],
    limitations: ["Based on recorded summaries only."],
    ...over,
  };
}

function subReasonOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    const diag = safeMetaDiagnostic(err);
    assert.equal(diag.category, "schema_validation", JSON.stringify(diag));
    return diag.subReason;
  }
}

test("every schema sub-reason is a fixed enum member and maps to its rule", () => {
  for (const r of [
    "missing_required_keys", "unexpected_keys", "invalid_answer", "invalid_evidence",
    "invalid_actions", "invalid_limitations", "invalid_field_type", "invalid_field_length",
    "unknown_schema_failure",
  ]) {
    assert.ok(SCHEMA_DIAGNOSTIC_SUBREASONS.includes(r));
  }

  const noLimitations = validAdvice();
  delete noLimitations.limitations;
  assert.equal(subReasonOf(() => validateModelAdvice(noLimitations, summary)), "missing_required_keys");

  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ runQuery: "DROP TABLE" }), summary)), "unexpected_keys");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ answer: "" }), summary)), "invalid_answer");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ answer: 42 }), summary)), "invalid_answer");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ evidence: [{ label: "x" }] }), summary)), "invalid_evidence");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ evidence: "lots" }), summary)), "invalid_evidence");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ suggestedActionIds: ["delete-records"] }), summary)), "invalid_actions");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ suggestedActionIds: "view-pos" }), summary)), "invalid_actions");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ limitations: "none" }), summary)), "invalid_limitations");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ limitations: [42] }), summary)), "invalid_limitations");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ explanation: 42 }), summary)), "invalid_field_type");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ explanation: "   " }), summary)), "invalid_field_type");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ answer: "x".repeat(1201) }), summary)), "invalid_field_length");
  assert.equal(subReasonOf(() => validateModelAdvice(validAdvice({ explanation: "x".repeat(1201) }), summary)), "invalid_field_length");
  assert.equal(subReasonOf(() => validateModelAdvice(null, summary)), "unknown_schema_failure");
  assert.equal(subReasonOf(() => validateModelAdvice([1, 2], summary)), "unknown_schema_failure");
});

test("sub-reason diagnostics never carry the rejected content", () => {
  const secret = "SECRET-REJECTED-CONTENT";
  try {
    validateModelAdvice(validAdvice({ answer: secret.repeat(100) }), summary);
    assert.fail("should throw");
  } catch (err) {
    const diag = safeMetaDiagnostic(err);
    assert.equal(diag.subReason, "invalid_field_length");
    assert.ok(!JSON.stringify(diag).includes(secret));
    assert.ok(!err.message.includes(secret));
  }
});

test("evidence is optional for the model because server evidence is authoritative", () => {
  // No evidence field at all: valid.
  const ok = validateModelAdvice(validAdvice(), summary);
  assert.equal(ok.suggestedActions[0].id, "view-transactions");
  // Well-formed evidence is still accepted (and discarded by the caller).
  const withEvidence = validateModelAdvice(
    validAdvice({ evidence: [{ label: "Income", value: "PHP 2500.00" }] }),
    summary,
  );
  assert.ok(!("evidence" in withEvidence));
});

test("model schema and validator agree on required keys and limits", () => {
  assert.deepEqual(BUCKY_ADVICE_JSON_SCHEMA.required, ["answer", "explanation", "suggestedActionIds", "limitations"]);
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.additionalProperties, false);
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.properties.answer.maxLength, 1200);
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.properties.explanation.maxLength, 1200);
  // Evidence is not requested from the model at all: the server computes
  // and attaches authoritative evidence itself.
  assert.ok(!("evidence" in BUCKY_ADVICE_JSON_SCHEMA.properties));
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.properties.suggestedActionIds.maxItems, 4);
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.properties.limitations.maxItems, 6);
  assert.equal(BUCKY_ADVICE_JSON_SCHEMA.properties.limitations.items.maxLength, 300);
  // A response at the schema's own limits passes the validator.
  const atLimits = validateModelAdvice(
    validAdvice({ limitations: ["y".repeat(300)] }),
    summary,
  );
  assert.equal(atLimits.limitations[0].length, 300);
});

test("raw-length limits are enforced before cleaning, and whitespace-only strings fail", () => {
  // Padded strings that would trim down to the limit are still rejected:
  // the schema counts raw characters, and so does the validator now.
  assert.equal(
    subReasonOf(() => validateModelAdvice(validAdvice({ limitations: [`  ${"y".repeat(300)}  `] }), summary)),
    "invalid_limitations",
  );
  assert.equal(
    subReasonOf(() => validateModelAdvice(validAdvice({ evidence: [{ label: ` ${"L".repeat(80)}`, value: "v" }] }), summary)),
    "invalid_evidence",
  );
  assert.equal(
    subReasonOf(() => validateModelAdvice(validAdvice({ limitations: ["   "] }), summary)),
    "invalid_limitations",
  );
  assert.equal(
    subReasonOf(() => validateModelAdvice(validAdvice({ evidence: [{ label: " ", value: "v" }] }), summary)),
    "invalid_evidence",
  );
  // At-limit raw strings still pass, including legacy evidence tolerance.
  const ok = validateModelAdvice(
    validAdvice({ evidence: [{ label: "L".repeat(80), value: "V".repeat(80) }], limitations: ["z".repeat(300)] }),
    summary,
  );
  assert.equal(ok.limitations[0].length, 300);
});

test("invented numbers in limitations are rejected by grounding, grounded ones pass", () => {
  try {
    validateModelAdvice(
      validAdvice({ limitations: ["This excludes PHP 99999.99 in unrecorded sales."] }),
      summary,
    );
    assert.fail("should throw");
  } catch (err) {
    const diag = safeMetaDiagnostic(err);
    assert.equal(diag.category, "grounding_validation");
    assert.equal(diag.subReason, null);
    assert.ok(!JSON.stringify(diag).includes("99999"));
  }
  assert.throws(
    () => validateModelAdvice(validAdvice({ limitations: ["Refunds rose 87% last quarter."] }), summary),
    /could not be reached/,
  );
  // Grounded figures and figure-free limitations remain acceptable.
  const ok = validateModelAdvice(
    validAdvice({
      limitations: ["Net cash flow of PHP 1350.00 is not profit.", "Based on recorded summaries only."],
    }),
    summary,
  );
  assert.equal(ok.limitations.length, 2);
  // Invented decimals still cannot pass by rounding to an allowed integer.
  assert.throws(
    () => validateModelAdvice(validAdvice({ limitations: ["Hidden fees were PHP 134999.99."] }), summary),
    /could not be reached/,
  );
});

test("grounding remains a separate category, not a schema sub-reason", () => {
  try {
    validateModelAdvice(validAdvice({ answer: "You earned PHP 88888.88 in profit." }), summary);
    assert.fail("should throw");
  } catch (err) {
    const diag = safeMetaDiagnostic(err);
    assert.equal(diag.category, "grounding_validation");
    assert.equal(diag.subReason, null);
  }
});

test("live endpoint reports the schema sub-reason in its safe diagnostic", async () => {
  process.env.MODEL_API_KEY = "test-key-not-real";
  process.env.LIVE_TEST_TOKEN = "test-token-not-real";
  const fakeFetch = async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({
        output_text: JSON.stringify({
          answer: "Cash flow is fine.",
          explanation: "No limitations field was returned.",
          suggestedActionIds: ["view-transactions"],
          // limitations deliberately missing -> missing_required_keys
        }),
      }),
  });
  const server = createAppServer(
    { host: "127.0.0.1", port: 0, modelApiKeyConfigured: true, liveMetaEnabled: true, liveTestTokenConfigured: true },
    { fetchImpl: fakeFetch },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/bucky/advise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bucketa-live-test": "test-token-not-real" },
      body: JSON.stringify({ question: "How is my cash flow?", mode: "live", summary }),
    });
    const json = await res.json();
    assert.equal(json.source, "deterministic-fallback");
    assert.deepEqual(json.diagnostic, {
      category: "schema_validation",
      upstreamStatus: null,
      subReason: "missing_required_keys",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MODEL_API_KEY;
    delete process.env.LIVE_TEST_TOKEN;
  }
});
