import assert from "node:assert/strict";
import test from "node:test";
import { validateExtraction } from "../validateExtraction.mjs";

function entry(overrides = {}) {
  return {
    description: "Rice (test)",
    type: "expense",
    amountText: "250.00",
    quantityText: null,
    unitPriceText: null,
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

test("identical entries in one batch are flagged as possible duplicates, never removed", () => {
  const result = validateExtraction({ entries: [entry(), entry()] }, "PHP");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].possibleDuplicate, true);
  assert.equal(result.entries[1].possibleDuplicate, true);
  assert.equal(result.entries[0].needsReview, true);
  assert.ok(result.entries[0].reviewReasons.includes("possibleDuplicate"));
  const distinct = validateExtraction(
    { entries: [entry(), entry({ amountText: "180.00" })] },
    "PHP",
  );
  assert.equal(distinct.entries[0].possibleDuplicate, false);
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

test("missing document total stays null and does not affect extraction", () => {
  const result = validateExtraction({ entries: [entry()] }, "PHP");
  assert.equal(result.documentTotalText, null);
  assert.equal(result.documentTotalMinor, null);
  assert.equal(result.totals.expenseMinor, 25000);
});

test("a valid written document total is parsed separately from entry totals", () => {
  const result = validateExtraction(
    {
      entries: [
        entry({ description: "Cheesedog", type: "income", amountText: "140.00" }),
        entry({ description: "Burger", type: "income", amountText: "195.00" }),
        entry({ description: "Fries", type: "income", amountText: "100.00" }),
      ],
      documentTotalText: "525.00",
    },
    "PHP",
  );
  assert.equal(result.documentTotalText, "525.00");
  assert.equal(result.documentTotalMinor, 52500);
  // The written total is never added to, or substituted for, entry totals.
  assert.equal(result.totals.incomeMinor, 43500);
  assert.equal(result.totals.countedEntries, 3);
});

test("invalid or unreadable document totals become null without failing", () => {
  for (const documentTotalText of ["five hundred", "₱525", "525.999", "", 525]) {
    const result = validateExtraction(
      { entries: [entry()], documentTotalText },
      "PHP",
    );
    assert.equal(result.documentTotalMinor, null, String(documentTotalText));
    assert.equal(result.entries[0].amountMinor, 25000);
    assert.equal(result.totals.expenseMinor, 25000);
  }
});

test("zero-decimal currencies convert without fraction", () => {
  const result = validateExtraction(
    { entries: [entry({ amountText: "123456", currencyDetected: "KRW" })] },
    "KRW",
  );
  assert.equal(result.entries[0].amountMinor, 123456);
});

test("quantity x unit price mismatch is flagged and the extracted amount is kept", () => {
  const result = validateExtraction(
    {
      entries: [
        entry({
          description: "Burger",
          type: "income",
          amountText: "120.00",
          quantityText: "2",
          unitPriceText: "65.00",
        }),
      ],
    },
    "PHP",
  );
  assert.equal(result.entries[0].amountMinor, 12000);
  assert.equal(result.entries[0].expectedAmountMinor, 13000);
  assert.equal(result.entries[0].arithmeticMismatch, true);
  assert.equal(result.entries[0].needsReview, true);
  assert.ok(result.entries[0].reviewReasons.includes("amountMismatch"));
});

test("matching quantity x unit price passes without a mismatch", () => {
  const result = validateExtraction(
    {
      entries: [
        entry({
          description: "Hotdog",
          type: "income",
          amountText: "75.00",
          quantityText: "3",
          unitPriceText: "25.00",
        }),
      ],
    },
    "PHP",
  );
  assert.equal(result.entries[0].expectedAmountMinor, 7500);
  assert.equal(result.entries[0].arithmeticMismatch, false);
  assert.equal(result.entries[0].needsReview, false);
});

test("quantity and unit price without a written total never invent an amount", () => {
  const result = validateExtraction(
    {
      entries: [
        entry({
          description: "Burger",
          type: "income",
          amountText: null,
          quantityText: "2",
          unitPriceText: "65.00",
        }),
      ],
    },
    "PHP",
  );
  assert.equal(result.entries[0].amountMinor, null);
  assert.equal(result.entries[0].expectedAmountMinor, 13000);
  assert.equal(result.entries[0].arithmeticMismatch, false);
  assert.equal(result.entries[0].needsReview, true);
});

test("partial or unreadable quantity data disables the arithmetic check", () => {
  const partial = validateExtraction(
    { entries: [entry({ quantityText: "2", unitPriceText: null })] },
    "PHP",
  );
  assert.equal(partial.entries[0].expectedAmountMinor, null);
  assert.equal(partial.entries[0].arithmeticMismatch, false);

  const unreadable = validateExtraction(
    { entries: [entry({ quantityText: "two", unitPriceText: "65.00" })] },
    "PHP",
  );
  assert.equal(unreadable.entries[0].expectedAmountMinor, null);
  assert.equal(unreadable.entries[0].arithmeticMismatch, false);
  assert.ok(unreadable.entries[0].reviewReasons.includes("quantityText"));
});

test("fractional quantities use exact arithmetic without rounding", () => {
  const exact = validateExtraction(
    {
      entries: [
        entry({ amountText: "150.00", quantityText: "1.5", unitPriceText: "100.00" }),
      ],
    },
    "PHP",
  );
  assert.equal(exact.entries[0].expectedAmountMinor, 15000);
  assert.equal(exact.entries[0].arithmeticMismatch, false);
});

test("currency conflict suppresses arithmetic validation", () => {
  const result = validateExtraction(
    {
      entries: [
        entry({
          currencyDetected: "USD",
          amountText: "120.00",
          quantityText: "2",
          unitPriceText: "65.00",
        }),
      ],
    },
    "PHP",
  );
  assert.equal(result.entries[0].currencyConflict, true);
  assert.equal(result.entries[0].unitPriceMinor, null);
  assert.equal(result.entries[0].arithmeticMismatch, false);
});

test("invalid bucket currency is rejected safely", () => {
  assert.throws(() => validateExtraction({ entries: [] }, "php"), /not a valid ISO/);
});
