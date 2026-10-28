/**
 * Mock extractor for M1A. Returns fictional financial records only.
 * No image content is read, stored, or logged — the mock ignores the
 * image entirely, which is also what makes the pipeline testable offline.
 */
export function extractWithMock(expectedCurrency) {
  return {
    entries: [
      {
        description: "Rice (fictional sample)",
        type: "expense",
        amountText: "250.00",
        currencyDetected: expectedCurrency,
        dateText: null,
        categorySuggestion: "Groceries",
        confidence: 0.97,
        uncertainFields: ["dateText"],
      },
      {
        description: "Sardines (fictional sample)",
        type: "expense",
        amountText: "180.00",
        currencyDetected: expectedCurrency,
        dateText: null,
        categorySuggestion: "Groceries",
        confidence: 0.95,
        uncertainFields: ["dateText"],
      },
      {
        description: "Jeepney fare (fictional sample)",
        type: "expense",
        amountText: null,
        currencyDetected: null,
        dateText: null,
        categorySuggestion: "Transport",
        confidence: 0.42,
        uncertainFields: ["amountText", "currencyDetected", "dateText"],
      },
    ],
  };
}
