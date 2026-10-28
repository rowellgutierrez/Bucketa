import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTotals,
  isValidCurrencyCode,
  minorUnitDigits,
  parseAmountToMinor,
} from "../money.mjs";

test("minor unit digits follow ISO 4217 conventions", () => {
  assert.equal(minorUnitDigits("PHP"), 2);
  assert.equal(minorUnitDigits("USD"), 2);
  assert.equal(minorUnitDigits("EUR"), 2);
  assert.equal(minorUnitDigits("GBP"), 2);
  assert.equal(minorUnitDigits("KRW"), 0);
  assert.equal(minorUnitDigits("JPY"), 0);
});

test("validates currency codes", () => {
  assert.equal(isValidCurrencyCode("PHP"), true);
  assert.equal(isValidCurrencyCode("KRW"), true);
  assert.equal(isValidCurrencyCode("php"), false);
  assert.equal(isValidCurrencyCode("US"), false);
  assert.equal(isValidCurrencyCode("12"), false);
});

test("converts decimal strings to integer minor units", () => {
  assert.equal(parseAmountToMinor("250.00", "PHP"), 25000);
  assert.equal(parseAmountToMinor("0.05", "PHP"), 5);
  assert.equal(parseAmountToMinor("123456", "KRW"), 123456);
  assert.equal(parseAmountToMinor("1000", "JPY"), 1000);
});

test("rejects amounts that do not fit the currency or are not clean amounts", () => {
  assert.equal(parseAmountToMinor("100.5", "KRW"), null);
  assert.equal(parseAmountToMinor("1.234", "PHP"), null);
  assert.equal(parseAmountToMinor("abc", "PHP"), null);
  assert.equal(parseAmountToMinor("1,000.00", "PHP"), null);
  assert.equal(parseAmountToMinor("0", "PHP"), null);
  assert.equal(parseAmountToMinor("-50", "PHP"), null);
  assert.equal(parseAmountToMinor(null, "PHP"), null);
});

test("totals are summed in code from integers and skip unparsed entries", () => {
  const totals = computeTotals([
    { type: "expense", amountMinor: 25000 },
    { type: "expense", amountMinor: 18000 },
    { type: "income", amountMinor: 50000 },
    { type: "expense", amountMinor: null },
    { type: null, amountMinor: 100 },
  ]);
  assert.deepEqual(totals, {
    incomeMinor: 50000,
    expenseMinor: 43000,
    netMinor: 7000,
    countedEntries: 3,
    skippedEntries: 2,
  });
});
