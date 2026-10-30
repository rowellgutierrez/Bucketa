import { errors } from "./errors.mjs";
import {
  computeExpectedLineMinor,
  computeTotals,
  isValidCurrencyCode,
  parseAmountToMinor,
  parseQuantityMilli,
} from "./money.mjs";

const KNOWN_FIELDS = [
  "description",
  "type",
  "amountText",
  "quantityText",
  "unitPriceText",
  "currencyDetected",
  "dateText",
  "categorySuggestion",
  "confidence",
  "uncertainFields",
];
const REVIEW_CONFIDENCE = 0.8;
const MAX_ENTRIES = 50;

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate raw extractor output against the selected bucket's currency.
 * Returns draft entries with review flags. Expected currency always wins;
 * a conflicting detected currency is flagged, never adopted silently.
 */
export function validateExtraction(raw, expectedCurrency) {
  if (!isValidCurrencyCode(expectedCurrency)) throw errors.invalidCurrency();
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
    throw errors.extractionUnavailable();
  }
  if (raw.entries.length > MAX_ENTRIES) throw errors.extractionUnavailable();

  const entries = raw.entries.map((item) => {
    const source = item && typeof item === "object" ? item : {};
    const description = cleanString(source.description);
    const type = source.type === "income" || source.type === "expense" ? source.type : null;
    const amountText = cleanString(source.amountText);
    const rawCurrency = cleanString(source.currencyDetected);
    const currencyDetected =
      rawCurrency && isValidCurrencyCode(rawCurrency.toUpperCase())
        ? rawCurrency.toUpperCase()
        : null;
    const dateText = cleanString(source.dateText);
    const categorySuggestion = cleanString(source.categorySuggestion);
    const confidence =
      typeof source.confidence === "number" && source.confidence >= 0 && source.confidence <= 1
        ? source.confidence
        : 0;
    const uncertainFields = Array.isArray(source.uncertainFields)
      ? source.uncertainFields.filter((f) => KNOWN_FIELDS.includes(f))
      : [];

    const currencyConflict =
      currencyDetected !== null && currencyDetected !== expectedCurrency;
    const amountMinor =
      amountText && !currencyConflict ? parseAmountToMinor(amountText, expectedCurrency) : null;

    // Optional quantity / unit price, extracted separately when legible.
    // They are only ever used to cross-check the extracted line total in
    // exact integer arithmetic; the extracted amount is never replaced.
    const quantityText = cleanString(source.quantityText);
    const unitPriceText = cleanString(source.unitPriceText);
    const quantityMilli = quantityText ? parseQuantityMilli(quantityText) : null;
    const unitPriceMinor =
      unitPriceText && !currencyConflict
        ? parseAmountToMinor(unitPriceText, expectedCurrency)
        : null;
    const expectedAmountMinor =
      quantityMilli !== null && unitPriceMinor !== null
        ? computeExpectedLineMinor(quantityText, unitPriceMinor)
        : null;
    // A mismatch also covers the case where quantity x unit price is not
    // exactly representable in minor units (expectedAmountMinor is null):
    // no integer-minor amount could equal it, so it must be reviewed.
    const arithmeticMismatch =
      quantityMilli !== null &&
      unitPriceMinor !== null &&
      amountMinor !== null &&
      expectedAmountMinor !== amountMinor;

    const reviewReasons = [];
    if (!description) reviewReasons.push("description");
    if (!type) reviewReasons.push("type");
    if (!amountText) reviewReasons.push("amountText");
    if (amountText && amountMinor === null && !currencyConflict) {
      reviewReasons.push("amountText");
    }
    if (quantityText && quantityMilli === null) reviewReasons.push("quantityText");
    if (unitPriceText && unitPriceMinor === null && !currencyConflict) {
      reviewReasons.push("unitPriceText");
    }
    if (arithmeticMismatch) reviewReasons.push("amountMismatch");
    if (!dateText) reviewReasons.push("dateText");
    if (confidence < REVIEW_CONFIDENCE) reviewReasons.push("confidence");
    if (currencyConflict) reviewReasons.push("currencyDetected");
    for (const field of uncertainFields) {
      if (!reviewReasons.includes(field)) reviewReasons.push(field);
    }

    return {
      description,
      type,
      amountText,
      amountMinor,
      quantityText,
      unitPriceText,
      unitPriceMinor,
      expectedAmountMinor,
      arithmeticMismatch,
      currency: expectedCurrency,
      currencyDetected,
      currencyConflict,
      dateText,
      categorySuggestion,
      confidence,
      uncertainFields,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    };
  });

  const documentTotalText = cleanString(raw.documentTotalText);
  // The written document total is review evidence only. Parse it with the
  // same currency-aware parser as entry amounts, but never include it in
  // transaction totals and never derive entries or differences from it.
  // An unreadable total becomes null instead of failing the extraction.
  const documentTotalMinor = documentTotalText
    ? parseAmountToMinor(documentTotalText, expectedCurrency)
    : null;

  return {
    currency: expectedCurrency,
    documentTotalText,
    documentTotalMinor,
    entries,
    totals: computeTotals(entries),
    needsReviewCount: entries.filter((e) => e.needsReview).length,
  };
}
