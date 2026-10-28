/**
 * Extraction schema and prompt for handwritten financial records.
 *
 * Honesty rules encoded here and in the prompt:
 * - Every field may be null. Null means "not readable", never a guess.
 * - There is deliberately no total field: totals are computed in code.
 * - Amounts come back as decimal strings so no floating point is trusted.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: ["string", "null"] },
          type: { type: ["string", "null"], enum: ["income", "expense", null] },
          amountText: { type: ["string", "null"] },
          currencyDetected: { type: ["string", "null"] },
          dateText: { type: ["string", "null"] },
          categorySuggestion: { type: ["string", "null"] },
          confidence: { type: "number" },
          uncertainFields: { type: "array", items: { type: "string" } },
        },
        required: [
          "description",
          "type",
          "amountText",
          "currencyDetected",
          "dateText",
          "categorySuggestion",
          "confidence",
          "uncertainFields",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

export function buildExtractionPrompt(expectedCurrency, recordType) {
  const kind = typeof recordType === "string" && recordType ? recordType : "financial records";
  return [
    `Extract the handwritten ${kind} in this image into structured entries.`,
    `The expected currency is ${expectedCurrency}. If the image clearly shows a different currency, report it in currencyDetected; otherwise report ${expectedCurrency} when a currency symbol or code is visible, or null when none is visible.`,
    "Return null for any field you cannot read clearly. Never invent a date, currency, amount, or description.",
    "amountText must be the amount exactly as written, as a decimal string (for example \"250.00\"), without currency symbols or thousands separators.",
    "Set confidence between 0 and 1 for each entry, and list every field you are unsure about in uncertainFields.",
    "Do not calculate totals. Extract entries only.",
  ].join(" ");
}
