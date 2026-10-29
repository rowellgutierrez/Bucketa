import type { Transaction } from "../data/types";
import { newId, nowIso, validateTransaction } from "../data/validation.ts";
import {
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
  type MinorUnits,
} from "./currency.ts";
import { isValidCalendarDate } from "./recordForm.ts";
import type {
  ExtractResponse,
  ExtractedEntry,
  ScannerRecordType,
} from "./scannerApi";

export type ScannerEntryType = "income" | "expense";
export type ScannerProfileKind = "personal" | "business";

export interface ScannerDraft {
  /** Stable draft and transaction identifier; never renumbered on removal. */
  transactionId: string;
  description: string;
  type: ScannerEntryType | "";
  amountText: string;
  date: string;
  /** Original extracted date text when it cannot safely prefill the date. */
  dateHint: string | null;
  category: string;
  currency: string;
  currencyDetected: string | null;
  currencyConflict: boolean;
  confidence: number;
  uncertainFields: string[];
  reviewReasons: string[];
  explicitlyConfirmed: boolean;
}

export interface ScannerReviewContext {
  batchId: string;
  profileId: string;
  profileKind: ScannerProfileKind;
  bucketId: string | null;
  expectedCurrency: string;
  recordType: ScannerRecordType;
}

export function createScannerBatchId(): string {
  return newId();
}

export function scannerBatchRelatedId(batchId: string): string {
  return `scanner-batch:${batchId}`;
}

function initialType(
  entry: ExtractedEntry,
  recordType: ScannerRecordType,
): ScannerEntryType | "" {
  if (recordType === "salaries") return "expense";
  if (entry.type) return entry.type;
  if (recordType === "expenses") return "expense";
  if (recordType === "sales") return "income";
  return "";
}

function initialCategory(
  entry: ExtractedEntry,
  recordType: ScannerRecordType,
): string {
  if (recordType === "sales") return "Sales";
  if (recordType === "salaries") return "Salaries";
  return entry.categorySuggestion ?? "";
}

function initialAmount(entry: ExtractedEntry, currency: string): string {
  if (entry.amountText) return entry.amountText;
  if (entry.amountMinor !== null) {
    try {
      return minorUnitsToAmountInput(entry.amountMinor, currency);
    } catch {
      return "";
    }
  }
  return "";
}

/** Convert one extraction response into editable, stable scanner drafts. */
export function buildScannerDrafts(
  result: ExtractResponse,
  recordType: ScannerRecordType,
  batchId: string,
): ScannerDraft[] {
  return result.entries.map((entry, index) => {
    const extractedDate = entry.dateText ?? "";
    const validDate = isValidCalendarDate(extractedDate) ? extractedDate : "";
    return {
      transactionId: `scanner:${batchId}:${index}`,
      description: entry.description ?? "",
      type: initialType(entry, recordType),
      amountText: initialAmount(entry, result.currency),
      date: validDate,
      dateHint: validDate ? null : entry.dateText,
      category: initialCategory(entry, recordType),
      currency: result.currency,
      currencyDetected: entry.currencyDetected,
      currencyConflict: entry.currencyConflict,
      confidence: entry.confidence,
      uncertainFields: [...entry.uncertainFields],
      reviewReasons: [...entry.reviewReasons],
      explicitlyConfirmed: false,
    };
  });
}

/**
 * An entry needs a separate human confirmation when the extractor was
 * uncertain, confidence was low, or the detected currency conflicts with
 * the locked profile/bucket currency. Merely filling a visibly missing
 * field does not prove that a low-confidence value was checked.
 */
export function requiresExplicitConfirmation(draft: ScannerDraft): boolean {
  return (
    draft.currencyConflict ||
    draft.confidence < 0.8 ||
    draft.uncertainFields.length > 0 ||
    draft.reviewReasons.includes("confidence") ||
    draft.reviewReasons.includes("currencyDetected")
  );
}

/** Friendly, non-technical review prompts for one scanner draft. */
const SCANNER_WARNING_LABELS: Record<string, string> = {
  amountText: "Check amount",
  dateText: "Check date",
  description: "Check description",
  type: "Check income or expense",
  currencyDetected: "Verify currency",
  confidence: "Please review this entry",
};

/**
 * Translate the extractor's technical uncertain fields and review reasons
 * into short prompts a user can act on. Unknown reasons fall back to a
 * generic prompt, each prompt appears at most once, and the internal
 * confidence/uncertainty data itself is left untouched for validation.
 */
export function scannerReviewWarnings(draft: ScannerDraft): string[] {
  const warnings: string[] = [];
  const add = (reason: string) => {
    const label = SCANNER_WARNING_LABELS[reason] ?? "Please review this entry";
    if (!warnings.includes(label)) warnings.push(label);
  };
  for (const field of draft.uncertainFields) add(field);
  for (const reason of draft.reviewReasons) add(reason);
  if (draft.currencyConflict) add("currencyDetected");
  return warnings;
}

const REVIEWED_SCANNER_FIELDS = [
  "description",
  "type",
  "amountText",
  "date",
  "category",
] as const satisfies readonly (keyof ScannerDraft)[];

/**
 * Apply one in-place review edit. When a reviewed field actually changes,
 * any earlier explicit confirmation no longer covers the edited values, so
 * it is reset and the entry must be checked again. Toggling the
 * confirmation itself, or re-entering an identical value, keeps it.
 */
export function applyScannerDraftEdit(
  draft: ScannerDraft,
  patch: Partial<ScannerDraft>,
): ScannerDraft {
  const reviewedFieldChanged = REVIEWED_SCANNER_FIELDS.some(
    (field) => field in patch && patch[field] !== draft[field],
  );
  return reviewedFieldChanged
    ? { ...draft, ...patch, explicitlyConfirmed: false }
    : { ...draft, ...patch };
}

export function scannerDraftAmountMinor(
  draft: ScannerDraft,
  currency: string,
): MinorUnits | null {
  try {
    const amount = parseAmountToMinorUnits(draft.amountText, currency);
    return amount > 0 ? amount : null;
  } catch {
    return null;
  }
}

/** Validate one draft using scanner-specific rules. */
export function validateScannerDraft(
  draft: ScannerDraft,
  context: ScannerReviewContext,
): string[] {
  const errors: string[] = [];

  if (context.recordType === "salaries" && context.profileKind !== "business") {
    errors.push("Salaries can only be saved for a business profile.");
  }
  if (!draft.description.trim()) errors.push("Description is required.");

  if (!draft.type) {
    errors.push("Choose income or expense.");
  } else if (context.recordType === "salaries" && draft.type !== "expense") {
    errors.push("Salary records must be saved as expenses.");
  }

  if (!draft.amountText.trim()) {
    errors.push("Amount is required.");
  } else {
    try {
      const amount = parseAmountToMinorUnits(
        draft.amountText,
        context.expectedCurrency,
      );
      if (amount <= 0) errors.push("Amount must be greater than zero.");
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "Amount is invalid.",
      );
    }
  }

  if (!draft.date) {
    errors.push(
      draft.dateHint
        ? `Enter the date as YYYY-MM-DD. The scan read “${draft.dateHint}”, which is not a complete calendar date.`
        : "Date is required.",
    );
  } else if (!isValidCalendarDate(draft.date)) {
    errors.push("Enter a real calendar date.");
  }

  if (draft.currency !== context.expectedCurrency) {
    errors.push(`Currency must remain ${context.expectedCurrency}.`);
  }
  if (draft.currencyConflict && !draft.explicitlyConfirmed) {
    errors.push(
      `Confirm that this amount is in ${context.expectedCurrency}, not ${draft.currencyDetected ?? "the detected currency"}.`,
    );
  } else if (
    requiresExplicitConfirmation(draft) &&
    !draft.explicitlyConfirmed
  ) {
    errors.push("Confirm that you checked this uncertain entry.");
  }

  return errors;
}

export function validateScannerDrafts(
  drafts: ScannerDraft[],
  context: ScannerReviewContext,
): Map<string, string[]> {
  return new Map(
    drafts.map((draft) => [draft.transactionId, validateScannerDraft(draft, context)]),
  );
}

export function scannerDraftTotals(
  drafts: ScannerDraft[],
  currency: string,
): { incomeMinor: number; expenseMinor: number; netMinor: number; countedEntries: number } {
  let incomeMinor = 0;
  let expenseMinor = 0;
  let countedEntries = 0;
  for (const draft of drafts) {
    const amount = scannerDraftAmountMinor(draft, currency);
    if (amount === null || !draft.type) continue;
    countedEntries += 1;
    if (draft.type === "income") incomeMinor += amount;
    else expenseMinor += amount;
  }
  return {
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    countedEntries,
  };
}

/**
 * Build the exact transactions to save. This applies the existing
 * transaction validator in addition to scanner-specific validation.
 * Sales become income/expense transactions here — never POS sales.
 */
export function buildScannerTransactions(
  drafts: ScannerDraft[],
  context: ScannerReviewContext,
  stamp = nowIso(),
): Transaction[] {
  if (drafts.length === 0) {
    throw new Error("Remove or restore at least one entry before saving.");
  }
  const errors = validateScannerDrafts(drafts, context);
  if ([...errors.values()].some((entryErrors) => entryErrors.length > 0)) {
    throw new Error("Fix the highlighted scanner entries before saving.");
  }

  return drafts.map((draft) => {
    const amountMinor = scannerDraftAmountMinor(draft, context.expectedCurrency);
    if (amountMinor === null || !draft.type) {
      throw new Error("Fix the highlighted scanner entries before saving.");
    }
    const transaction: Transaction = {
      id: draft.transactionId,
      profileId: context.profileId,
      bucketId: context.bucketId,
      type: draft.type,
      amountMinor,
      currency: context.expectedCurrency,
      date: draft.date,
      description: draft.description.trim(),
      category: draft.category.trim() ? draft.category.trim() : null,
      origin: "scanner-confirmed",
      relatedId: scannerBatchRelatedId(context.batchId),
      createdAt: stamp,
      updatedAt: stamp,
    };
    return validateTransaction(transaction);
  });
}
