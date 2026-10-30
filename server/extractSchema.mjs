/**
 * Extraction schema and prompt for handwritten financial records.
 *
 * Honesty rules encoded here and in the prompt:
 * - Every field may be null. Null means "not readable", never a guess.
 * - Entries never include subtotal or grand-total rows. A clearly labelled
 *   final document total is transcribed separately in documentTotalText;
 *   entry totals and differences are always computed in code, never by
 *   the model.
 * - Amounts come back as decimal strings so no floating point is trusted.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    documentTotalText: { type: ["string", "null"] },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: ["string", "null"] },
          type: { type: ["string", "null"], enum: ["income", "expense", null] },
          amountText: { type: ["string", "null"] },
          quantityText: { type: ["string", "null"] },
          unitPriceText: { type: ["string", "null"] },
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
          "quantityText",
          "unitPriceText",
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
  required: ["entries", "documentTotalText"],
  additionalProperties: false,
};

export function buildExtractionPrompt(expectedCurrency, recordType) {
  const kind = typeof recordType === "string" && recordType ? recordType : "financial records";
  return [
    `Extract the handwritten ${kind} in this image into structured entries.`,
    `The expected currency is ${expectedCurrency}. If the image clearly shows a different currency, report it in currencyDetected; otherwise report ${expectedCurrency} when a currency symbol or code is visible, or null when none is visible.`,
    "Return null for any field you cannot read clearly. Never invent a date, currency, amount, or description.",
    "amountText must be the amount exactly as written, as a decimal string (for example \"250.00\"), without currency symbols or thousands separators.",
    "Item lines are often written informally, for example \"Burger - 2pcs (65) = 130\", \"Burger 2 x 65 = 130\", \"Burger 2pcs @65\", or \"Burger qty 2 price 65 total 130\". When you can read them clearly, put the quantity in quantityText and the unit price in unitPriceText, each as a plain decimal string; a number in parentheses after a quantity usually indicates the unit price.",
    "For such item lines, amountText is the final line total: the figure after \"=\" or the figure labelled as the total. If a line shows only a quantity and a unit price with no written total, set amountText to null; never multiply or calculate a total yourself.",
    "Return null for quantityText or unitPriceText when you cannot read them clearly, and list them in uncertainFields. Never invent a quantity or unit price.",
    "Dates: report each date exactly as written in dateText, never converting or completing it. If one date at the top of the record clearly applies to the whole record, use that same date for every entry it covers; if an individual line has its own date, use that line's date for that entry instead. If a date is incomplete (for example it has no year), ambiguous, or written as a relative word such as \"today\" or \"yesterday\", return it exactly as written and list dateText in uncertainFields; never add a missing year or turn a relative word into a calendar date.",
    "Set confidence between 0 and 1 for each entry, and list every field you are unsure about in uncertainFields.",
    "Subtotal, grand-total, and other summary rows are not entries and must never be included in entries. Item rows are entries; summary rows only describe the document as a whole.",
    "If the document shows a clearly labelled final grand total, return that figure exactly as written in documentTotalText, as a decimal string without currency symbols or thousands separators. Preserve the amount as written; never calculate, correct, or invent a grand total. If several totals conflict, or the final total is missing, unclear, contradictory, or unreadable, return null for documentTotalText.",
    "Do not calculate entry totals or differences. Extract entries and, when clearly labelled, the written document total only.",
  ].join(" ");
}
