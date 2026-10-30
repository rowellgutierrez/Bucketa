import { errors } from "./errors.mjs";

/**
 * Money handling for extracted records.
 * Amounts are integers in a currency's minor unit. Decimal strings from
 * the model are converted here, in application code — never trusted as
 * numbers, and totals are summed here, never taken from the model.
 */

export function isValidCurrencyCode(code) {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

export function minorUnitDigits(currency) {
  if (!isValidCurrencyCode(currency)) throw errors.invalidCurrency();
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Convert a decimal string like "250.00" to integer minor units.
 * Returns null when the text is not a clean, positive amount that fits
 * the currency's decimal convention — the caller marks it for review.
 */
export function parseAmountToMinor(amountText, currency) {
  if (typeof amountText !== "string") return null;
  const text = amountText.trim();
  if (!/^\d{1,13}(\.\d+)?$/.test(text)) return null;

  const digits = minorUnitDigits(currency);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > digits) return null;

  const minor =
    BigInt(whole) * 10n ** BigInt(digits) +
    BigInt((fraction + "0".repeat(digits)).slice(0, digits) || "0");
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/**
 * Parse a quantity written as a plain decimal string (examples: "2",
 * "1.5") into integer thousandths (milli-units), so line totals can be
 * computed without floating point. Returns a BigInt, or null when the
 * text is not a clean positive quantity with at most 3 decimal places.
 */
export function parseQuantityMilli(quantityText) {
  if (typeof quantityText !== "string") return null;
  const text = quantityText.trim();
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const milli =
    BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3) || "0");
  return milli > 0n ? milli : null;
}

/**
 * Expected line total in minor units: quantity x unit price, in exact
 * integer arithmetic. Returns null when the quantity or unit price is
 * missing/unreadable, or when the product is not exactly representable
 * in minor units (never rounded to force a match).
 */
export function computeExpectedLineMinor(quantityText, unitPriceMinor) {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) return null;
  const milli = parseQuantityMilli(quantityText);
  if (milli === null) return null;
  const product = milli * BigInt(unitPriceMinor);
  if (product % 1000n !== 0n) return null;
  const expected = product / 1000n;
  if (expected > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(expected);
}

/**
 * Sum validated entries in integer minor units. Entries without a
 * parsed amount are skipped and counted, never guessed.
 */
export function computeTotals(entries) {
  let incomeMinor = 0;
  let expenseMinor = 0;
  let countedEntries = 0;
  let skippedEntries = 0;
  for (const entry of entries) {
    if (typeof entry.amountMinor === "number" && (entry.type === "income" || entry.type === "expense")) {
      if (entry.type === "income") incomeMinor += entry.amountMinor;
      else expenseMinor += entry.amountMinor;
      countedEntries += 1;
    } else {
      skippedEntries += 1;
    }
  }
  return {
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    countedEntries,
    skippedEntries,
  };
}
