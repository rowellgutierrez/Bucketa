import assert from "node:assert/strict";
import test from "node:test";
import { validateExtraction } from "../validateExtraction.mjs";

function entry(overrides = {}) {
  return {
    description: "Rice (test)",
    type: "expense",
    amountText: "250.00",
    currencyDetected: "PHP",
    dateText: "2026-10-27",
    categorySuggestion: "Groceries",
    confidence: 0.95,
    uncertainFields: [],
    ...overrides,
  };
}

test("clean entry passes with integer minor units and no review flag", () => {
  const result = validateExtraction({ entries: [entry()] }, "PHP");
  assert.equal(result.entries[0].amountMinor, 25000);
  assert.equal(result.entries[0].needsReview, false);
  assert.equal(result.totals.expenseMinor, 25000);
});

test("missing amount is marked for review, never invented", () => {
  const result = validateExtraction(
    { entries: [entry({ amountText: null, uncertainFields: ["amountText"] })] },
    "PHP",
  );
  assert.equal(result.entries[0].amountMinor, null);
  assert.equal(result.entries[0].needsReview, true);
  assert.ok(result.entries[0].reviewReasons.includes("amountText"));
  assert.equal(result.totals.skippedEntries, 1);
});

test("missing date and description are flagged for review", () => {
  const result = validateExtraction(
    { entries: [entry({ dateText: null, description: null })] },
    "PHP",
  );
  assert.equal(result.entries[0].needsReview, true);
  assert.ok(result.entries[0].reviewReasons.includes("dateText"));
  assert.ok(result.entries[0].reviewReasons.includes("description"));
});

test("conflicting detected currency is flagged and expected currency wins", () => {
  const result = validateExtraction(
    { entries: [entry({ currencyDetected: "USD" })] },
    "PHP",
  );
  assert.equal(result.entries[0].currencyConflict, true);
  assert.equal(result.entries[0].currency, "PHP");
  assert.equal(result.entries[0].needsReview, true);
});

test("low confidence is flagged for review", () => {
  const result = validateExtraction({ entries: [entry({ confidence: 0.4 })] }, "PHP");
  assert.equal(result.entries[0].needsReview, true);
});

test("a model-supplied total is ignored; totals come from code", () => {
  const result = validateExtraction(
    { entries: [entry(), entry({ amountText: "180.00" })], total: 999999 },
    "PHP",
  );
  assert.equal(result.totals.expenseMinor, 43000);
  assert.equal("total" in result, false);
});

test("zero-decimal currencies convert without fraction", () => {
  const result = validateExtraction(
    { entries: [entry({ amountText: "123456", currencyDetected: "KRW" })] },
    "KRW",
  );
  assert.equal(result.entries[0].amountMinor, 123456);
});

test("invalid bucket currency is rejected safely", () => {
  assert.throws(() => validateExtraction({ entries: [] }, "php"), /not a valid ISO/);
});
