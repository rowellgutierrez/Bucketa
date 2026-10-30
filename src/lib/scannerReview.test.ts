import assert from "node:assert/strict";
import test from "node:test";
import type { ExtractResponse } from "./scannerApi.ts";
import {
  applyScannerCalendarSelection,
  applyScannerDateEdit,
  applyScannerDraftEdit,
  buildScannerDrafts,
  buildScannerTransactions,
  formatScannerDateForDisplay,
  formatScannerDateInput,
  mapScannerDateInputSelection,
  normalizeExtractedDate,
  resolveScannerDateEdit,
  scannerBatchRelatedId,
  scannerDraftDateGroups,
  scannerDraftTotals,
  scannerGrandTotalAcknowledgmentSatisfied,
  scannerGrandTotalReconciliation,
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
    documentTotalText: null,
    documentTotalMinor: null,
    entries: [
      {
        description: "Rice",
        type: "expense",
        amountText: "250.00",
        amountMinor: 25000,
        quantityText: null,
        unitPriceText: null,
        unitPriceMinor: null,
        expectedAmountMinor: null,
        arithmeticMismatch: false,
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
        quantityText: null,
        unitPriceText: null,
        unitPriceMinor: null,
        expectedAmountMinor: null,
        arithmeticMismatch: false,
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

function draftWithDateText(dateText: string | null) {
  const base = response();
  base.entries = [{ ...base.entries[0], dateText }];
  return buildScannerDrafts(base, "expenses", "batch-date")[0];
}

test("supported extracted date formats prefill as YYYY-MM-DD", () => {
  const cases: Array<[string, string]> = [
    ["2026-10-30", "2026-10-30"],
    ["Oct 30, 2026", "2026-10-30"],
    ["Oct 30,2026", "2026-10-30"],
    ["October 30, 2026", "2026-10-30"],
    ["October 30,2026", "2026-10-30"],
    ["30 Oct 2026", "2026-10-30"],
    ["30 October 2026", "2026-10-30"],
    ["13/04/2026", "2026-04-13"],
    ["04/13/2026", "2026-04-13"],
  ];
  for (const [dateText, expected] of cases) {
    assert.equal(normalizeExtractedDate(dateText), expected, dateText);
    const draft = draftWithDateText(dateText);
    assert.equal(draft.date, expected, dateText);
    assert.deepEqual(validateScannerDraft(draft, context), [], dateText);
  }
});

test("normalization preserves the original transcription as a scan-read hint", () => {
  const normalized = draftWithDateText("Oct 30, 2026");
  assert.equal(normalized.date, "2026-10-30");
  assert.equal(normalized.dateHint, "Oct 30, 2026");

  // Already in storage format: nothing changed, so no hint is needed.
  const alreadyIso = draftWithDateText("2026-10-30");
  assert.equal(alreadyIso.date, "2026-10-30");
  assert.equal(alreadyIso.dateHint, null);
});

test("missing space after the comma still normalizes and keeps the scan-read hint", () => {
  // Regression: the live model transcribed "Oct 30,2026" (no space after
  // the comma), which previously left the date input blank.
  for (const dateText of ["Oct 30,2026", "October 30,2026"]) {
    assert.equal(normalizeExtractedDate(dateText), "2026-10-30", dateText);
    const draft = draftWithDateText(dateText);
    assert.equal(draft.date, "2026-10-30", dateText);
    // The exact original transcription is preserved for the reviewer.
    assert.equal(draft.dateHint, dateText, dateText);
    assert.deepEqual(validateScannerDraft(draft, context), [], dateText);
  }
});

test("ambiguous numeric dates stay blank for manual entry", () => {
  assert.equal(normalizeExtractedDate("03/04/2026"), null);
  const draft = draftWithDateText("03/04/2026");
  assert.equal(draft.date, "");
  assert.equal(draft.dateHint, "03/04/2026");
  assert.match(
    validateScannerDraft(draft, context).join(" "),
    /Enter the date as YYYY-MM-DD\. The scan read “03\/04\/2026”/,
  );
});

test("invalid calendar dates are rejected, never prefilled", () => {
  for (const dateText of [
    "2026-02-31",
    "Feb 30, 2026",
    "30 February 2026",
    "31/04/2026",
    "Oct 32, 2026",
  ]) {
    assert.equal(normalizeExtractedDate(dateText), null, dateText);
    const draft = draftWithDateText(dateText);
    assert.equal(draft.date, "", dateText);
    assert.equal(draft.dateHint, dateText, dateText);
  }
  assert.equal(normalizeExtractedDate(null), null);
  assert.equal(normalizeExtractedDate(""), null);
  assert.equal(normalizeExtractedDate("not a date"), null);
});

test("editing a normalized date still resets explicit confirmation", () => {
  const draft = draftWithDateText("October 30, 2026");
  assert.equal(draft.date, "2026-10-30");
  const confirmed = { ...draft, explicitlyConfirmed: true };
  const edited = applyScannerDraftEdit(confirmed, { date: "2026-10-31" });
  assert.equal(edited.date, "2026-10-31");
  assert.equal(edited.explicitlyConfirmed, false);
  // Re-entering the same normalized date keeps an existing confirmation.
  const unchanged = applyScannerDraftEdit(confirmed, { date: "2026-10-30" });
  assert.equal(unchanged.explicitlyConfirmed, true);
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

test("arithmetic mismatch requires confirmation and shows the expected total", () => {
  const base = buildScannerDrafts(response(), "sales", "batch-mismatch")[0];
  const draft = {
    ...base,
    description: "Burger",
    amountText: "120.00",
    quantityText: "2",
    unitPriceText: "65.00",
    unitPriceMinor: 6500,
    expectedAmountMinor: 13000,
    arithmeticMismatch: true,
    reviewReasons: ["amountMismatch"],
  };
  assert.match(validateScannerDraft(draft, context).join(" "), /quantity × unit price is PHP 130/);
  assert.ok(
    scannerReviewWarnings(draft).some((warning) => warning.startsWith("Check amount: 2 × PHP 65")),
  );

  // A knowingly different amount (for example a discount) may still be
  // saved, but only after the reviewer explicitly confirms it.
  assert.deepEqual(validateScannerDraft({ ...draft, explicitlyConfirmed: true }, context), []);
});

test("correcting a mismatched amount clears the warning but not the confirmation", () => {
  const base = buildScannerDrafts(response(), "sales", "batch-mismatch-fix")[0];
  const draft = {
    ...base,
    description: "Burger",
    amountText: "120.00",
    quantityText: "2",
    unitPriceText: "65.00",
    unitPriceMinor: 6500,
    expectedAmountMinor: 13000,
    arithmeticMismatch: true,
    reviewReasons: ["amountMismatch"],
    explicitlyConfirmed: true,
  };
  const corrected = applyScannerDraftEdit(draft, { amountText: "130.00" });
  assert.equal(corrected.explicitlyConfirmed, false);
  assert.equal(
    scannerReviewWarnings(corrected).some((warning) => warning.startsWith("Check amount: 2 ×")),
    false,
  );
  assert.match(validateScannerDraft(corrected, context).join(" "), /checked this uncertain entry/);
  assert.deepEqual(
    validateScannerDraft({ ...corrected, explicitlyConfirmed: true }, context),
    [],
  );
});

function grandTotalDrafts() {
  const base = response();
  const entry = (overrides: Partial<(typeof base.entries)[number]>) => ({
    ...base.entries[0],
    type: "income" as const,
    dateText: "Oct 30, 2026",
    categorySuggestion: "Sales",
    confidence: 0.97,
    uncertainFields: [],
    needsReview: false,
    reviewReasons: [],
    ...overrides,
  });
  const result: ExtractResponse = {
    ...base,
    recordType: "sales",
    documentTotalText: "525.00",
    documentTotalMinor: 52500,
    entries: [
      entry({
        description: "Cheesedog",
        amountText: "140.00",
        amountMinor: 14000,
        quantityText: "4",
        unitPriceText: "35.00",
        unitPriceMinor: 3500,
        expectedAmountMinor: 14000,
      }),
      entry({
        description: "Burger",
        amountText: "195.00",
        amountMinor: 19500,
        quantityText: "3",
        unitPriceText: "65.00",
        unitPriceMinor: 6500,
        expectedAmountMinor: 19500,
      }),
      entry({
        description: "Fries",
        amountText: "100.00",
        amountMinor: 10000,
        quantityText: "2",
        unitPriceText: "45.00",
        unitPriceMinor: 4500,
        expectedAmountMinor: 9000,
        arithmeticMismatch: true,
        needsReview: true,
        reviewReasons: ["amountMismatch"],
      }),
    ],
  };
  return buildScannerDrafts(result, "sales", "batch-grand-total");
}

test("grand-total reconciliation compares written, reviewed, and quantity totals exactly", () => {
  const drafts = grandTotalDrafts();
  // The Fries written amount is retained; nothing is auto-corrected.
  assert.equal(drafts[2].amountText, "100.00");
  const reconciliation = scannerGrandTotalReconciliation(drafts, "525.00", 52500, "PHP");
  assert.equal(reconciliation.status, "mismatch");
  assert.equal(reconciliation.direction, "income");
  assert.equal(reconciliation.documentTotalMinor, 52500);
  assert.equal(reconciliation.reviewedEntryTotalMinor, 43500);
  assert.equal(reconciliation.differenceMinor, 9000);
  assert.equal(reconciliation.quantityComparisonAvailable, true);
  assert.equal(reconciliation.quantityTotalMinor, 42500);
  assert.equal(reconciliation.quantityDifferenceMinor, 10000);
  assert.equal(reconciliation.requiresAcknowledgment, true);
});

test("matching written totals do not require grand-total acknowledgment", () => {
  const reconciliation = scannerGrandTotalReconciliation(
    grandTotalDrafts(),
    "435.00",
    43500,
    "PHP",
  );
  assert.equal(reconciliation.status, "matching");
  assert.equal(reconciliation.differenceMinor, 0);
  assert.equal(reconciliation.requiresAcknowledgment, false);
  assert.equal(
    scannerGrandTotalAcknowledgmentSatisfied(reconciliation, null),
    true,
  );
});

test("mixed-direction and incomplete batches are not compared against a grand total", () => {
  const drafts = grandTotalDrafts();
  drafts[1] = { ...drafts[1], type: "expense" };
  const mixed = scannerGrandTotalReconciliation(drafts, "525.00", 52500, "PHP");
  assert.equal(mixed.status, "not-comparable");
  assert.equal(mixed.reviewedEntryTotalMinor, null);
  assert.equal(mixed.requiresAcknowledgment, false);

  const untyped = grandTotalDrafts();
  untyped[0] = { ...untyped[0], type: "" };
  assert.equal(
    scannerGrandTotalReconciliation(untyped, "525.00", 52500, "PHP").status,
    "not-comparable",
  );
});

test("partial quantity coverage shows no quantity-based total", () => {
  const drafts = grandTotalDrafts();
  drafts[1] = {
    ...drafts[1],
    quantityText: null,
    unitPriceText: null,
    unitPriceMinor: null,
    expectedAmountMinor: null,
  };
  const reconciliation = scannerGrandTotalReconciliation(drafts, "525.00", 52500, "PHP");
  assert.equal(reconciliation.reviewedEntryTotalMinor, 43500);
  assert.equal(reconciliation.quantityComparisonAvailable, false);
  assert.equal(reconciliation.quantityTotalMinor, null);
  assert.equal(reconciliation.quantityDifferenceMinor, null);
});

test("edited and removed entries update grand-total reconciliation", () => {
  const drafts = grandTotalDrafts();
  const edited = drafts.map((draft) =>
    draft.description === "Fries"
      ? applyScannerDraftEdit(draft, { amountText: "90.00" })
      : draft,
  );
  const afterEdit = scannerGrandTotalReconciliation(edited, "525.00", 52500, "PHP");
  assert.equal(afterEdit.reviewedEntryTotalMinor, 42500);
  assert.equal(afterEdit.differenceMinor, 10000);

  const remaining = edited.filter((draft) => draft.description !== "Fries");
  const afterRemoval = scannerGrandTotalReconciliation(remaining, "525.00", 52500, "PHP");
  assert.equal(afterRemoval.countedEntries, 2);
  assert.equal(afterRemoval.reviewedEntryTotalMinor, 33500);
  assert.equal(afterRemoval.differenceMinor, 19000);
  assert.equal(afterRemoval.quantityTotalMinor, 33500);
});

test("grand-total acknowledgment is keyed to the exact comparison", () => {
  const drafts = grandTotalDrafts();
  const reconciliation = scannerGrandTotalReconciliation(drafts, "525.00", 52500, "PHP");
  assert.equal(scannerGrandTotalAcknowledgmentSatisfied(reconciliation, null), false);
  assert.equal(
    scannerGrandTotalAcknowledgmentSatisfied(reconciliation, reconciliation.comparisonKey),
    true,
  );

  // Any relevant change produces a new key, invalidating the old
  // acknowledgment without any stored draft state changing.
  const edited = drafts.map((draft, index) =>
    index === 0 ? applyScannerDraftEdit(draft, { amountText: "150.00" }) : draft,
  );
  const changed = scannerGrandTotalReconciliation(edited, "525.00", 52500, "PHP");
  assert.notEqual(changed.comparisonKey, reconciliation.comparisonKey);
  assert.equal(
    scannerGrandTotalAcknowledgmentSatisfied(changed, reconciliation.comparisonKey),
    false,
  );

  // Resolving the mismatch removes the acknowledgment requirement.
  const resolvedDrafts = drafts.map((draft, index) =>
    index === 0 ? applyScannerDraftEdit(draft, { amountText: "230.00" }) : draft,
  );
  const resolved = scannerGrandTotalReconciliation(resolvedDrafts, "525.00", 52500, "PHP");
  assert.equal(resolved.status, "matching");
  assert.equal(scannerGrandTotalAcknowledgmentSatisfied(resolved, null), true);
});

test("batch grand-total acknowledgment never replaces per-entry arithmetic confirmation", () => {
  const fries = grandTotalDrafts()[2];
  const errors = validateScannerDraft(fries, { ...context, recordType: "sales" });
  assert.match(errors.join(" "), /quantity × unit price is PHP 90/);
  assert.deepEqual(
    validateScannerDraft({ ...fries, explicitlyConfirmed: true }, { ...context, recordType: "sales" }),
    [],
  );
});

test("mock responses without a document total behave as before", () => {
  const drafts = buildScannerDrafts(response(), "expenses", "batch-mock");
  const missing = scannerGrandTotalReconciliation(drafts, null, null, "PHP");
  assert.equal(missing.status, "missing");
  assert.equal(missing.documentTotalMinor, null);
  assert.equal(missing.requiresAcknowledgment, false);

  // Older responses may omit the fields entirely.
  const legacy = scannerGrandTotalReconciliation(drafts, undefined, undefined, "PHP");
  assert.equal(legacy.status, "missing");

  const unreadable = scannerGrandTotalReconciliation(drafts, "five hundred", null, "PHP");
  assert.equal(unreadable.status, "unreadable");
  assert.equal(unreadable.requiresAcknowledgment, false);
});

function makeDrafts(
  specs: Array<Partial<(typeof response) extends never ? never : ExtractResponse["entries"][number]>>,
  recordType: ExtractResponse["recordType"] = "expenses",
  batchId = "batch-dates",
) {
  const base = response();
  const result: ExtractResponse = {
    ...base,
    recordType,
    entries: specs.map((spec) => ({ ...base.entries[0], ...spec })),
  };
  return buildScannerDrafts(result, recordType, batchId);
}

test("date groups sort chronologically and keep same-date entries together", () => {
  const drafts = makeDrafts([
    { description: "Later", dateText: "2026-10-30" },
    { description: "Earlier A", dateText: "Oct 28, 2026" },
    { description: "Earlier B", dateText: "2026-10-28" },
  ]);
  const groups = scannerDraftDateGroups(drafts, "expenses", "PHP");
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-28", "2026-10-30"]);
  assert.deepEqual(
    groups[0].drafts.map((d) => d.description),
    ["Earlier A", "Earlier B"],
  );
  // Same draft objects with stable identities; nothing is copied or renumbered.
  assert.equal(groups[0].drafts[0], drafts[1]);
  assert.equal(groups[1].drafts[0].transactionId, "scanner:batch-dates:0");
});

test("missing, invalid, and explicitly uncertain dates form the final Needs Date Review group", () => {
  const drafts = makeDrafts([
    { description: "Dated", dateText: "2026-10-30" },
    { description: "Missing", dateText: null, reviewReasons: ["dateText"] },
    { description: "Invalid", dateText: "Oct 32, 2026" },
    {
      description: "Uncertain",
      dateText: "2026-10-29",
      uncertainFields: ["dateText"],
      reviewReasons: ["dateText"],
    },
  ]);
  assert.equal(drafts[3].date, "2026-10-29");
  assert.equal(drafts[3].dateNeedsReview, true);
  const groups = scannerDraftDateGroups(drafts, "expenses", "PHP");
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-30", "needs-date-review"]);
  assert.deepEqual(
    groups[1].drafts.map((d) => d.description),
    ["Missing", "Invalid", "Uncertain"],
  );
  // Original transcriptions remain available as hints.
  assert.equal(groups[1].drafts[1].dateHint, "Oct 32, 2026");
});

test("an uncertain date stays in review until a valid date is supplied", () => {
  const [draft] = makeDrafts([{ description: "Partial", dateText: "Oct 30" }]);
  assert.equal(draft.dateNeedsReview, true);
  // Changing to another invalid or incomplete value does not clear it.
  assert.equal(applyScannerDraftEdit(draft, { date: "" }).dateNeedsReview, true);
  assert.equal(applyScannerDraftEdit(draft, { date: "2026-02-31" }).dateNeedsReview, true);
  // A valid calendar date clears it and moves the entry when regrouped.
  const fixed = applyScannerDraftEdit(draft, { date: "2026-10-30" });
  assert.equal(fixed.dateNeedsReview, false);
  assert.deepEqual(
    scannerDraftDateGroups([fixed], "expenses", "PHP").map((g) => g.key),
    ["2026-10-30"],
  );
});

test("finished date edits commit valid, blank, and invalid values safely", () => {
  const [draft] = makeDrafts([{ description: "Partial", dateText: "Oct 30" }]);
  const confirmed = { ...draft, explicitlyConfirmed: true };

  // Until a finished edit is committed, the draft and its group do not move.
  assert.equal(draft.date, "");
  assert.deepEqual(
    scannerDraftDateGroups([draft], "expenses", "PHP").map((g) => g.key),
    ["needs-date-review"],
  );

  const valid = applyScannerDateEdit(confirmed, "2026-10-30");
  assert.equal(valid.date, "2026-10-30");
  assert.equal(valid.dateNeedsReview, false);
  assert.equal(valid.explicitlyConfirmed, false);
  // Identity stays stable across regrouping.
  assert.equal(valid.transactionId, draft.transactionId);
  assert.deepEqual(
    scannerDraftDateGroups([valid], "expenses", "PHP").map((g) => g.key),
    ["2026-10-30"],
  );

  // Clearing a date returns the entry to Needs Date Review.
  const blank = applyScannerDateEdit(valid, "   ");
  assert.equal(blank.date, "");
  assert.equal(blank.dateNeedsReview, false); // valid date had already cleared review
  const blankUncertain = applyScannerDateEdit(confirmed, "");
  assert.equal(blankUncertain.date, "");
  assert.equal(blankUncertain.dateNeedsReview, true);

  // Invalid and incomplete text is preserved verbatim and never clears review.
  for (const text of ["2026-02-31", "2026-13-01", "2026-", "30/10/2026", "Oct 30, 2026"]) {
    const result = applyScannerDateEdit(confirmed, text);
    assert.equal(result.date, text);
    assert.equal(result.dateNeedsReview, true);
    assert.equal(resolveScannerDateEdit(text).status, "invalid");
    assert.deepEqual(
      scannerDraftDateGroups([result], "expenses", "PHP").map((g) => g.key),
      ["needs-date-review"],
    );
  }
});

test("entered years are preserved exactly and summaries follow committed regrouping", () => {
  assert.deepEqual(resolveScannerDateEdit("2026-10-30"), { status: "valid", date: "2026-10-30" });
  // No silent rewriting or arbitrary year restrictions are introduced.
  assert.deepEqual(resolveScannerDateEdit("0202-10-30"), { status: "valid", date: "0202-10-30" });

  const drafts = makeDrafts([
    { description: "A", amountText: "10.00", dateText: "2026-10-30" },
    { description: "B", amountText: "20.00", dateText: "2026-10-30" },
  ]);
  const regrouped = drafts.map((draft, index) =>
    index === 1 ? applyScannerDateEdit(draft, "2026-10-28") : draft,
  );
  const groups = scannerDraftDateGroups(regrouped, "expenses", "PHP");
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-28", "2026-10-30"]);
  assert.equal(groups[0].summary.expensesMinor, 2000);
  assert.equal(groups[1].summary.expensesMinor, 1000);
  assert.equal(groups[0].drafts[0].transactionId, drafts[1].transactionId);
});

test("a finished date edit does not change grand-total reconciliation", () => {
  const drafts = grandTotalDrafts();
  const edited = drafts.map((draft, index) =>
    index === 0 ? applyScannerDateEdit(draft, "2026-10-29") : draft,
  );
  const reconciliation = scannerGrandTotalReconciliation(edited, "525.00", 52500, "PHP");
  assert.equal(reconciliation.reviewedEntryTotalMinor, 43500);
  assert.equal(reconciliation.differenceMinor, 9000);
  assert.equal(reconciliation.quantityTotalMinor, 42500);
});

test("all three date formats display and strictly parse the same internal ISO date", () => {
  assert.equal(formatScannerDateForDisplay("2026-10-30", "DD/MM/YYYY"), "30/10/2026");
  assert.equal(formatScannerDateForDisplay("2026-10-30", "MM/DD/YYYY"), "10/30/2026");
  assert.equal(formatScannerDateForDisplay("2026-10-30", "YYYY-MM-DD"), "2026-10-30");
  assert.deepEqual(resolveScannerDateEdit("30/10/2026", "DD/MM/YYYY"), { status: "valid", date: "2026-10-30" });
  assert.deepEqual(resolveScannerDateEdit("10/30/2026", "MM/DD/YYYY"), { status: "valid", date: "2026-10-30" });
  assert.deepEqual(resolveScannerDateEdit("2026-10-30", "YYYY-MM-DD"), { status: "valid", date: "2026-10-30" });

  // Ambiguous dates follow only the explicitly selected preference.
  assert.deepEqual(resolveScannerDateEdit("03/04/2026", "DD/MM/YYYY"), { status: "valid", date: "2026-04-03" });
  assert.deepEqual(resolveScannerDateEdit("03/04/2026", "MM/DD/YYYY"), { status: "valid", date: "2026-03-04" });
  // Wrong-format, impossible, and incomplete input is rejected, never reparsed.
  assert.equal(resolveScannerDateEdit("2026-10-30", "DD/MM/YYYY").status, "invalid");
  assert.equal(resolveScannerDateEdit("30/10/2026", "YYYY-MM-DD").status, "invalid");
  assert.equal(resolveScannerDateEdit("31/02/2026", "DD/MM/YYYY").status, "invalid");
  assert.equal(resolveScannerDateEdit("30/10/", "DD/MM/YYYY").status, "invalid");
  assert.deepEqual(resolveScannerDateEdit("  ", "MM/DD/YYYY"), { status: "blank", date: "" });
  // Leap years use real calendar rules in every format.
  assert.equal(resolveScannerDateEdit("29/02/2024", "DD/MM/YYYY").status, "valid");
  assert.equal(resolveScannerDateEdit("29/02/2026", "DD/MM/YYYY").status, "invalid");
  assert.equal(resolveScannerDateEdit("02/29/2024", "MM/DD/YYYY").status, "valid");
});

test("smart date typing inserts separators and assists only unambiguous leading zeros", () => {
  // Full digit streams for every selected format.
  assert.equal(formatScannerDateInput("30102026", "DD/MM/YYYY"), "30/10/2026");
  assert.equal(formatScannerDateInput("10292026", "MM/DD/YYYY"), "10/29/2026");
  assert.equal(formatScannerDateInput("20261030", "YYYY-MM-DD"), "2026-10-30");
  // Typed or pasted separators are normalized only under the selected format.
  assert.equal(formatScannerDateInput("30/10/2026", "DD/MM/YYYY"), "30/10/2026");
  assert.equal(formatScannerDateInput("3/4/2026", "DD/MM/YYYY"), "03/04/2026");
  assert.equal(formatScannerDateInput("2026-10-30", "YYYY-MM-DD"), "2026-10-30");

  // Days 4-9 and months 2-9 cannot start a valid two-digit component.
  assert.equal(formatScannerDateInput("4", "DD/MM/YYYY"), "04/");
  // A bulk digit stream uses fixed-width components in the selected format;
  // it does not guess that "314" was typed as separate keystrokes.
  assert.equal(formatScannerDateInput("314", "MM/DD/YYYY"), "31/04/");
  // Ambiguous first digits wait for the next digit and are never reinterpreted.
  assert.equal(formatScannerDateInput("3", "DD/MM/YYYY"), "3");
  assert.equal(formatScannerDateInput("1", "MM/DD/YYYY"), "1");
  assert.equal(formatScannerDateInput("20", "MM/DD/YYYY"), "20/");
  assert.equal(formatScannerDateInput("20102026", "DD/MM/YYYY"), "20/10/2026");
  // Completed invalid components and non-date text are preserved for correction.
  assert.equal(formatScannerDateInput("32102026", "DD/MM/YYYY"), "32/10/2026");
  assert.equal(formatScannerDateInput("Oct 30", "DD/MM/YYYY"), "Oct 30");
  assert.equal(resolveScannerDateEdit(formatScannerDateInput("29022024", "DD/MM/YYYY"), "DD/MM/YYYY").status, "valid");
  assert.equal(resolveScannerDateEdit(formatScannerDateInput("29022026", "DD/MM/YYYY"), "DD/MM/YYYY").status, "invalid");
});

test("smart date typing follows sequential keystrokes in every format", () => {
  // Month-first typing: the leading-zero month is completed before the
  // day digits arrive, so the same digits that form an invalid bulk month
  // become a valid sequential date.
  let monthFirst = formatScannerDateInput("3", "MM/DD/YYYY");
  assert.equal(monthFirst, "03/");
  monthFirst = formatScannerDateInput("03/1", "MM/DD/YYYY", monthFirst);
  assert.equal(monthFirst, "03/1");
  monthFirst = formatScannerDateInput("03/14", "MM/DD/YYYY", monthFirst);
  assert.equal(monthFirst, "03/14/");
  monthFirst = formatScannerDateInput("03/14/2", "MM/DD/YYYY", monthFirst);
  assert.equal(monthFirst, "03/14/2");
  monthFirst = formatScannerDateInput("03/14/2026", "MM/DD/YYYY", monthFirst);
  assert.equal(monthFirst, "03/14/2026");
  assert.deepEqual(resolveScannerDateEdit(monthFirst, "MM/DD/YYYY"), {
    status: "valid",
    date: "2026-03-14",
  });

  // Day-first typing receives a separator after each completed component.
  let dayFirst = formatScannerDateInput("3", "DD/MM/YYYY");
  assert.equal(dayFirst, "3");
  dayFirst = formatScannerDateInput("30", "DD/MM/YYYY", dayFirst);
  assert.equal(dayFirst, "30/");
  dayFirst = formatScannerDateInput("30/1", "DD/MM/YYYY", dayFirst);
  assert.equal(dayFirst, "30/1");
  dayFirst = formatScannerDateInput("30/10", "DD/MM/YYYY", dayFirst);
  assert.equal(dayFirst, "30/10/");
  dayFirst = formatScannerDateInput("30/10/2026", "DD/MM/YYYY", dayFirst);
  assert.equal(dayFirst, "30/10/2026");
  assert.deepEqual(resolveScannerDateEdit(dayFirst, "DD/MM/YYYY"), {
    status: "valid",
    date: "2026-10-30",
  });

  // Year-first typing receives a separator after the year and month.
  let yearFirst = formatScannerDateInput("2", "YYYY-MM-DD");
  assert.equal(yearFirst, "2");
  yearFirst = formatScannerDateInput("2026", "YYYY-MM-DD", yearFirst);
  assert.equal(yearFirst, "2026-");
  yearFirst = formatScannerDateInput("2026-1", "YYYY-MM-DD", yearFirst);
  assert.equal(yearFirst, "2026-1");
  yearFirst = formatScannerDateInput("2026-10", "YYYY-MM-DD", yearFirst);
  assert.equal(yearFirst, "2026-10-");
  yearFirst = formatScannerDateInput("2026-10-3", "YYYY-MM-DD", yearFirst);
  assert.equal(yearFirst, "2026-10-3");
  yearFirst = formatScannerDateInput("2026-10-30", "YYYY-MM-DD", yearFirst);
  assert.equal(yearFirst, "2026-10-30");
  assert.deepEqual(resolveScannerDateEdit(yearFirst, "YYYY-MM-DD"), {
    status: "valid",
    date: "2026-10-30",
  });

  // Backspacing over a newly appended separator removes the preceding digit.
  assert.equal(formatScannerDateInput("03/14", "MM/DD/YYYY", "03/14/"), "03/1");
  assert.equal(formatScannerDateInput("30/10", "DD/MM/YYYY", "30/10/"), "30/1");
  assert.equal(formatScannerDateInput("2026-10", "YYYY-MM-DD", "2026-10-"), "2026-1");

  // Pasted complete dates and bulk digit streams stay in the selected format.
  assert.equal(formatScannerDateInput("03/14/2026", "MM/DD/YYYY", ""), "03/14/2026");
  assert.equal(formatScannerDateInput("30/10/2026", "DD/MM/YYYY", ""), "30/10/2026");
  assert.equal(formatScannerDateInput("2026-10-30", "YYYY-MM-DD", ""), "2026-10-30");
  assert.equal(formatScannerDateInput("03142026", "MM/DD/YYYY", ""), "03/14/2026");
  assert.equal(formatScannerDateInput("31102026", "MM/DD/YYYY", ""), "31/10/2026");
  assert.equal(
    resolveScannerDateEdit(formatScannerDateInput("31102026", "MM/DD/YYYY", ""), "MM/DD/YYYY").status,
    "invalid",
  );
});

test("smart date caret mapping preserves the edited component", () => {
  // Reported case: deleting the day tens digit pads the remaining day,
  // but the caret stays in the day component instead of jumping to the end.
  const reportedEntered = "10/9/2026";
  const reportedFormatted = formatScannerDateInput(reportedEntered, "MM/DD/YYYY", "10/29/2026");
  assert.equal(reportedFormatted, "10/09/2026");
  assert.deepEqual(mapScannerDateInputSelection(reportedEntered, reportedFormatted, 3, 3), {
    start: 4,
    end: 4,
  });
  // A caret after the remaining day digit also stays after that digit.
  assert.deepEqual(mapScannerDateInputSelection(reportedEntered, reportedFormatted, 4, 4), {
    start: 5,
    end: 5,
  });
  // A selection around the remaining day digit follows it after padding.
  assert.deepEqual(mapScannerDateInputSelection(reportedEntered, reportedFormatted, 3, 4), {
    start: 4,
    end: 5,
  });

  // Leading-zero insertion moves an end caret after the completed component.
  assert.deepEqual(mapScannerDateInputSelection("4", "04/", 1, 1), { start: 3, end: 3 });
  // Automatic separators in every format advance the caret into the next field.
  assert.deepEqual(mapScannerDateInputSelection("03/14", "03/14/", 5, 5), { start: 6, end: 6 });
  assert.deepEqual(mapScannerDateInputSelection("30/10", "30/10/", 5, 5), { start: 6, end: 6 });
  assert.deepEqual(mapScannerDateInputSelection("2026-10", "2026-10-", 7, 7), { start: 8, end: 8 });

  // Backspace over a separator uses the existing digit-removal result and
  // keeps the caret beside the remaining digit.
  const afterSeparatorBackspace = formatScannerDateInput("30", "DD/MM/YYYY", "30/");
  assert.equal(afterSeparatorBackspace, "3");
  assert.deepEqual(mapScannerDateInputSelection("30", afterSeparatorBackspace, 2, 2), {
    start: 1,
    end: 1,
  });
  // Delete over a separator likewise stays near the edited separator.
  const afterSeparatorDelete = formatScannerDateInput("3010/2026", "DD/MM/YYYY", "30/10/2026");
  assert.equal(afterSeparatorDelete, "30/10/2026");
  assert.deepEqual(mapScannerDateInputSelection("3010/2026", afterSeparatorDelete, 2, 2), {
    start: 3,
    end: 3,
  });

  // Ordinary insertion and selection replacement without a formatting
  // change preserve the browser selection exactly.
  assert.deepEqual(mapScannerDateInputSelection("10/15/2026", "10/15/2026", 4, 4), {
    start: 4,
    end: 4,
  });
  assert.deepEqual(mapScannerDateInputSelection("10/15/2026", "10/15/2026", 3, 5), {
    start: 3,
    end: 5,
  });

  // Pasting a complete date moves an end caret by inserted separators;
  // invalid text returned untouched keeps its caret unchanged.
  const pastedFormatted = formatScannerDateInput("03142026", "MM/DD/YYYY", "");
  assert.equal(pastedFormatted, "03/14/2026");
  assert.deepEqual(mapScannerDateInputSelection("03142026", pastedFormatted, 8, 8), {
    start: 10,
    end: 10,
  });
  assert.deepEqual(mapScannerDateInputSelection("Oct 30", "Oct 30", 3, 3), {
    start: 3,
    end: 3,
  });

  // Repeated digits remain in the edited component, and out-of-range
  // selection positions are clamped to the entered text boundaries.
  assert.deepEqual(mapScannerDateInputSelection("10/0/2026", "10/00/2026", 3, 3), {
    start: 4,
    end: 4,
  });
  assert.deepEqual(mapScannerDateInputSelection("10/10/2026", "10/10/2026", 99, -1), {
    start: 10,
    end: 10,
  });
});

test("smart date caret mapping anchors repeated digits by their suffix", () => {
  // MM/DD/YYYY: Delete leaves the caret before the remaining zero, while
  // Backspace leaves it after that zero; padding must preserve each side.
  assert.deepEqual(mapScannerDateInputSelection("10/0/2026", "10/00/2026", 3, 3), {
    start: 4,
    end: 4,
  });
  assert.deepEqual(mapScannerDateInputSelection("10/0/2026", "10/00/2026", 4, 4), {
    start: 5,
    end: 5,
  });

  // DD/MM/YYYY uses the same repeated-zero mapping in day-first order.
  assert.deepEqual(mapScannerDateInputSelection("30/0/2026", "30/00/2026", 3, 3), {
    start: 4,
    end: 4,
  });
  assert.deepEqual(mapScannerDateInputSelection("30/0/2026", "30/00/2026", 4, 4), {
    start: 5,
    end: 5,
  });

  // YYYY-MM-DD repeated zeros in both the month and day keep their side.
  assert.deepEqual(mapScannerDateInputSelection("2026-0-30", "2026-00-30", 5, 5), {
    start: 6,
    end: 6,
  });
  assert.deepEqual(mapScannerDateInputSelection("2026-0-30", "2026-00-30", 6, 6), {
    start: 7,
    end: 7,
  });
  assert.deepEqual(mapScannerDateInputSelection("2026-10-0", "2026-10-00", 8, 8), {
    start: 9,
    end: 9,
  });
  assert.deepEqual(mapScannerDateInputSelection("2026-10-0", "2026-10-00", 9, 9), {
    start: 10,
    end: 10,
  });
});

test("deleting an internal date separator preserves every date digit", () => {
  // DD/MM/YYYY: either internal separator is restored structurally.
  const dayFirst = "30/10/2026";
  assert.equal(formatScannerDateInput("3010/2026", "DD/MM/YYYY", dayFirst), dayFirst);
  assert.deepEqual(mapScannerDateInputSelection("3010/2026", dayFirst, 2, 2), {
    start: 3,
    end: 3,
  });
  assert.equal(formatScannerDateInput("30/102026", "DD/MM/YYYY", dayFirst), dayFirst);
  assert.deepEqual(mapScannerDateInputSelection("30/102026", dayFirst, 5, 5), {
    start: 6,
    end: 6,
  });
  assert.deepEqual(resolveScannerDateEdit(dayFirst, "DD/MM/YYYY"), {
    status: "valid",
    date: "2026-10-30",
  });

  // MM/DD/YYYY: the same digit preservation applies in month-first order.
  const monthFirst = "10/30/2026";
  assert.equal(formatScannerDateInput("1030/2026", "MM/DD/YYYY", monthFirst), monthFirst);
  assert.deepEqual(mapScannerDateInputSelection("1030/2026", monthFirst, 2, 2), {
    start: 3,
    end: 3,
  });
  assert.equal(formatScannerDateInput("10/302026", "MM/DD/YYYY", monthFirst), monthFirst);
  assert.deepEqual(mapScannerDateInputSelection("10/302026", monthFirst, 5, 5), {
    start: 6,
    end: 6,
  });
  assert.deepEqual(resolveScannerDateEdit(monthFirst, "MM/DD/YYYY"), {
    status: "valid",
    date: "2026-10-30",
  });

  // YYYY-MM-DD: deleting either dash restores the same ISO-shaped text.
  const yearFirst = "2026-10-30";
  assert.equal(formatScannerDateInput("202610-30", "YYYY-MM-DD", yearFirst), yearFirst);
  assert.deepEqual(mapScannerDateInputSelection("202610-30", yearFirst, 4, 4), {
    start: 5,
    end: 5,
  });
  assert.equal(formatScannerDateInput("2026-1030", "YYYY-MM-DD", yearFirst), yearFirst);
  assert.deepEqual(mapScannerDateInputSelection("2026-1030", yearFirst, 7, 7), {
    start: 8,
    end: 8,
  });
  assert.deepEqual(resolveScannerDateEdit(yearFirst, "YYYY-MM-DD"), {
    status: "valid",
    date: "2026-10-30",
  });

  // Partial dates also keep their digits when an internal separator is deleted.
  assert.equal(formatScannerDateInput("301", "DD/MM/YYYY", "30/1"), "30/1");
  assert.deepEqual(mapScannerDateInputSelection("301", "30/1", 2, 2), {
    start: 3,
    end: 3,
  });
  assert.equal(formatScannerDateInput("103", "MM/DD/YYYY", "10/3"), "10/3");
  assert.equal(formatScannerDateInput("20261", "YYYY-MM-DD", "2026-1"), "2026-1");
  assert.deepEqual(mapScannerDateInputSelection("20261", "2026-1", 4, 4), {
    start: 5,
    end: 5,
  });

  // Trailing auto-inserted separators retain the established behavior:
  // Backspace removes the preceding digit so the separator does not bounce.
  assert.equal(formatScannerDateInput("30", "DD/MM/YYYY", "30/"), "3");
  assert.equal(formatScannerDateInput("2026", "YYYY-MM-DD", "2026-"), "202");
});

test("smart date typing handles separator deletion and mid-string replacement predictably", () => {
  // Backspacing over an auto-inserted separator removes the digit before it.
  assert.equal(formatScannerDateInput("30", "DD/MM/YYYY", "30/"), "3");
  assert.equal(formatScannerDateInput("2026", "YYYY-MM-DD", "2026-"), "202");
  // Ordinary digit backspace simply reformats the remaining digits.
  assert.equal(formatScannerDateInput("30/10/202", "DD/MM/YYYY", "30/10/2026"), "30/10/202");
  // Replacing a selected component keeps the remaining components in place.
  assert.equal(formatScannerDateInput("31/10/2026", "DD/MM/YYYY", "30/10/2026"), "31/10/2026");
  assert.equal(formatScannerDateInput("30/11/2026", "DD/MM/YYYY", "30/10/2026"), "30/11/2026");
});

test("changing display preference never changes internal dates, groups, or invalid text", () => {
  const [draft] = makeDrafts([{ description: "Dated", amountText: "10.00", dateText: "2026-10-30" }]);
  for (const format of ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const) {
    const shown = formatScannerDateForDisplay(draft.date, format);
    const recommitted = applyScannerDateEdit(draft, shown, format);
    assert.equal(recommitted.date, "2026-10-30");
    assert.equal(recommitted.transactionId, draft.transactionId);
  }
  assert.deepEqual(
    scannerDraftDateGroups([draft], "expenses", "PHP").map((g) => g.key),
    ["2026-10-30"],
  );
  // Invalid committed text is shown verbatim under every preference.
  assert.equal(formatScannerDateForDisplay("30/10/", "MM/DD/YYYY"), "30/10/");
  assert.equal(formatScannerDateForDisplay("", "DD/MM/YYYY"), "");
});

test("calendar selections commit ISO dates once and clearing returns to Needs Date Review", () => {
  const [draft] = makeDrafts([{ description: "Partial", dateText: "Oct 30" }]);
  const selected = applyScannerCalendarSelection(draft, "2026-10-30");
  assert.equal(selected.date, "2026-10-30");
  assert.equal(selected.dateNeedsReview, false);
  assert.equal(selected.transactionId, draft.transactionId);
  assert.deepEqual(
    scannerDraftDateGroups([selected], "expenses", "PHP").map((g) => g.key),
    ["2026-10-30"],
  );

  const cleared = applyScannerCalendarSelection(selected, "");
  assert.equal(cleared.date, "");
  assert.deepEqual(
    scannerDraftDateGroups([cleared], "expenses", "PHP").map((g) => g.key),
    ["needs-date-review"],
  );

  // A native picker should never send this, but it must not be committed.
  assert.equal(applyScannerCalendarSelection(draft, "2026-02-31"), draft);
  // Summaries and reconciliation are unaffected by the selection mechanism.
  const totals = scannerDraftDateGroups([selected], "expenses", "PHP")[0].summary;
  assert.equal(totals.expensesMinor, 25000);
});

test("editing a date moves the entry and removing an entry updates groups", () => {
  const drafts = makeDrafts([
    { description: "Mover", dateText: "2026-10-28", amountText: "10.00" },
    { description: "Stay", dateText: "2026-10-28", amountText: "20.00" },
  ]);
  const moved = drafts.map((draft, index) =>
    index === 0 ? applyScannerDraftEdit(draft, { date: "2026-10-30" }) : draft,
  );
  let groups = scannerDraftDateGroups(moved, "expenses", "PHP");
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-28", "2026-10-30"]);
  assert.equal(groups[0].summary.expensesMinor, 2000);
  assert.equal(groups[1].summary.expensesMinor, 1000);

  const remaining = moved.filter((draft) => draft.description !== "Mover");
  groups = scannerDraftDateGroups(remaining, "expenses", "PHP");
  assert.deepEqual(groups.map((g) => g.key), ["2026-10-28"]);
  assert.equal(groups[0].summary.entryCount, 1);
});

test("daily summaries partition sales, expenses, salaries, and other income exactly once", () => {
  const sales = makeDrafts(
    [
      { description: "Sold", type: "income", amountText: "140.00", dateText: "2026-10-30" },
      { description: "Refund", type: "expense", amountText: "40.00", dateText: "2026-10-30" },
    ],
    "sales",
  );
  const salesSummary = scannerDraftDateGroups(sales, "sales", "PHP")[0].summary;
  assert.equal(salesSummary.salesMinor, 14000);
  assert.equal(salesSummary.expensesMinor, 4000);
  assert.equal(salesSummary.otherIncomeMinor, 0);
  assert.equal(salesSummary.netMinor, 10000);

  const salaries = makeDrafts(
    [{ description: "Wages", type: "expense", amountText: "500.00", dateText: "2026-10-30" }],
    "salaries",
  );
  const salarySummary = scannerDraftDateGroups(salaries, "salaries", "PHP")[0].summary;
  assert.equal(salarySummary.salaryPaymentsMinor, 50000);
  // Counted once: salaries are not also reported as ordinary expenses,
  // and the net subtracts them exactly once.
  assert.equal(salarySummary.expensesMinor, 0);
  assert.equal(salarySummary.netMinor, -50000);
  assert.equal(scannerDraftTotals(salaries, "PHP").expenseMinor, 50000);

  const mixed = makeDrafts(
    [
      { description: "Gift", type: "income", amountText: "0.10", dateText: "2026-10-30" },
      { description: "Gift 2", type: "income", amountText: "0.20", dateText: "2026-10-30" },
    ],
    "financial records",
  );
  const mixedSummary = scannerDraftDateGroups(mixed, "financial records", "PHP")[0].summary;
  assert.equal(mixedSummary.otherIncomeMinor, 30);
  assert.equal(mixedSummary.netMinor, 30);
});

test("invalid amounts are excluded from daily sums and undated amounts stay provisional", () => {
  const drafts = makeDrafts([
    { description: "Dated", amountText: "100.00", dateText: "2026-10-30" },
    { description: "No amount", amountText: null, amountMinor: null, dateText: "2026-10-30" },
    { description: "Undated", amountText: "50.00", dateText: null, reviewReasons: ["dateText"] },
  ]);
  const groups = scannerDraftDateGroups(drafts, "expenses", "PHP");
  assert.equal(groups[0].summary.expensesMinor, 10000);
  assert.equal(groups[0].summary.countedEntries, 1);
  assert.equal(groups[0].summary.incompleteEntries, 1);
  // The undated amount appears only in the separate provisional group.
  assert.equal(groups[1].key, "needs-date-review");
  assert.equal(groups[1].summary.expensesMinor, 5000);
  assert.equal(groups[1].summary.netMinor, -5000);
});

test("date grouping does not change grand-total reconciliation", () => {
  const drafts = grandTotalDrafts();
  const groups = scannerDraftDateGroups(drafts, "sales", "PHP");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].summary.salesMinor, 43500);
  const reconciliation = scannerGrandTotalReconciliation(drafts, "525.00", 52500, "PHP");
  assert.equal(reconciliation.reviewedEntryTotalMinor, 43500);
  assert.equal(reconciliation.differenceMinor, 9000);
  assert.equal(reconciliation.quantityTotalMinor, 42500);
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
