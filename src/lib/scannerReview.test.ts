import assert from "node:assert/strict";
import test from "node:test";
import type { ExtractResponse } from "./scannerApi.ts";
import {
  applyScannerDraftEdit,
  buildScannerDrafts,
  buildScannerTransactions,
  scannerBatchRelatedId,
  scannerDraftTotals,
  scannerReviewWarnings,
  validateScannerDraft,
  type ScannerReviewContext,
} from "./scannerReview.ts";

const stamp = "2026-10-27T00:00:00.000Z";

function response(): ExtractResponse {
  return {
    mode: "mock",
    recordType: "expenses",
    currency: "PHP",
    entries: [
      {
        description: "Rice",
        type: "expense",
        amountText: "250.00",
        amountMinor: 25000,
        currency: "PHP",
        currencyDetected: "PHP",
        currencyConflict: false,
        dateText: "2026-10-03",
        categorySuggestion: "Groceries",
        confidence: 0.97,
        uncertainFields: [],
        needsReview: false,
        reviewReasons: [],
      },
      {
        description: "Jeepney fare",
        type: "expense",
        amountText: null,
        amountMinor: null,
        currency: "PHP",
        currencyDetected: null,
        currencyConflict: false,
        dateText: null,
        categorySuggestion: "Transport",
        confidence: 0.42,
        uncertainFields: ["amountText", "dateText"],
        needsReview: true,
        reviewReasons: ["amountText", "dateText", "confidence"],
      },
    ],
    totals: { incomeMinor: 0, expenseMinor: 25000, netMinor: -25000, countedEntries: 1, skippedEntries: 1 },
    needsReviewCount: 1,
  };
}

const context: ScannerReviewContext = {
  batchId: "batch-1",
  profileId: "profile-1",
  profileKind: "business",
  bucketId: "bucket-1",
  expectedCurrency: "PHP",
  recordType: "expenses",
};

test("scanner drafts keep stable IDs and require dates when extraction has none", () => {
  const drafts = buildScannerDrafts(response(), "expenses", "batch-1");
  assert.equal(drafts[0].transactionId, "scanner:batch-1:0");
  assert.equal(drafts[0].date, "2026-10-03");
  assert.equal(drafts[1].date, "");
  assert.match(validateScannerDraft(drafts[1], context).join(" "), /Amount is required/);
});

test("uncertain scanner entries require explicit confirmation after fields are fixed", () => {
  const draft = buildScannerDrafts(response(), "expenses", "batch-1")[1];
  draft.amountText = "50.00";
  draft.date = "2026-10-03";
  assert.match(validateScannerDraft(draft, context).join(" "), /checked this uncertain entry/);
  draft.explicitlyConfirmed = true;
  assert.deepEqual(validateScannerDraft(draft, context), []);
});

test("scanner transactions use deterministic IDs and namespaced batch metadata", () => {
  const drafts = buildScannerDrafts(response(), "expenses", "batch-1").slice(0, 1);
  const transactions = buildScannerTransactions(drafts, context, stamp);
  assert.equal(transactions[0].id, "scanner:batch-1:0");
  assert.equal(transactions[0].origin, "scanner-confirmed");
  assert.equal(transactions[0].relatedId, scannerBatchRelatedId("batch-1"));
  assert.equal(transactions[0].amountMinor, 25000);
});

test("sales drafts default to the Sales category and save as income", () => {
  const drafts = buildScannerDrafts(response(), "sales", "batch-2");
  drafts[0].type = "income";
  const transactions = buildScannerTransactions(
    drafts.slice(0, 1),
    { ...context, recordType: "sales", batchId: "batch-2" },
    stamp,
  );
  assert.equal(transactions[0].type, "income");
  assert.equal(transactions[0].category, "Sales");
});

test("editing a reviewed field resets explicit confirmation", () => {
  const draft = buildScannerDrafts(response(), "expenses", "batch-1")[1];
  draft.amountText = "50.00";
  draft.date = "2026-10-03";
  draft.explicitlyConfirmed = true;
  assert.deepEqual(validateScannerDraft(draft, context), []);

  for (const patch of [
    { description: "Jeepney fare (edited)" },
    { type: "income" as const },
    { amountText: "55.00" },
    { date: "2026-10-04" },
    { category: "Travel" },
  ]) {
    const edited = applyScannerDraftEdit(draft, patch);
    assert.equal(edited.explicitlyConfirmed, false);
    assert.match(
      validateScannerDraft(edited, context).join(" "),
      /checked this uncertain entry/,
    );
  }
});

test("toggling confirmation or re-entering the same value keeps confirmation", () => {
  const draft = buildScannerDrafts(response(), "expenses", "batch-1")[1];
  const confirmed = applyScannerDraftEdit(draft, { explicitlyConfirmed: true });
  assert.equal(confirmed.explicitlyConfirmed, true);
  const unchanged = applyScannerDraftEdit(confirmed, {
    amountText: confirmed.amountText,
    date: confirmed.date,
  });
  assert.equal(unchanged.explicitlyConfirmed, true);
});

test("scanner warnings use friendly labels and de-duplicate reasons", () => {
  const draft = buildScannerDrafts(response(), "expenses", "batch-1")[1];
  // amountText and dateText appear in both uncertainFields and
  // reviewReasons, and confidence is low: each prompt appears once.
  assert.deepEqual(scannerReviewWarnings(draft), [
    "Check amount",
    "Check date",
    "Please review this entry",
  ]);
});

test("scanner warnings flag currency conflicts and unknown reasons safely", () => {
  const draft = buildScannerDrafts(response(), "expenses", "batch-1")[0];
  draft.currencyConflict = true;
  draft.currencyDetected = "USD";
  draft.reviewReasons = ["currencyDetected", "someNewReason"];
  assert.deepEqual(scannerReviewWarnings(draft), [
    "Verify currency",
    "Please review this entry",
  ]);

  const clean = buildScannerDrafts(response(), "expenses", "batch-1")[0];
  assert.deepEqual(scannerReviewWarnings(clean), []);
});

test("scanner totals recalculate after an entry is removed", () => {
  const drafts = buildScannerDrafts(response(), "expenses", "batch-1");
  drafts[1].amountText = "50.00";
  drafts[1].date = "2026-10-03";
  assert.deepEqual(scannerDraftTotals(drafts, "PHP"), {
    incomeMinor: 0,
    expenseMinor: 30000,
    netMinor: -30000,
    countedEntries: 2,
  });
  const remaining = drafts.filter((draft) => draft.transactionId !== drafts[0].transactionId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].transactionId, "scanner:batch-1:1");
  assert.deepEqual(scannerDraftTotals(remaining, "PHP"), {
    incomeMinor: 0,
    expenseMinor: 5000,
    netMinor: -5000,
    countedEntries: 1,
  });
});

test("salaries are business expenses only", () => {
  const drafts = buildScannerDrafts(response(), "salaries", "batch-3").slice(0, 1);
  const personalErrors = validateScannerDraft(drafts[0], {
    ...context,
    recordType: "salaries",
    profileKind: "personal",
  });
  assert.match(personalErrors.join(" "), /business profile/);

  const transactions = buildScannerTransactions(
    drafts,
    { ...context, recordType: "salaries", batchId: "batch-3" },
    stamp,
  );
  assert.equal(transactions[0].type, "expense");
  assert.equal(transactions[0].category, "Salaries");
});
