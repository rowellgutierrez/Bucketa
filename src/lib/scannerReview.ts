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
  quantityText: string | null;
  unitPriceText: string | null;
  unitPriceMinor: number | null;
  expectedAmountMinor: number | null;
  arithmeticMismatch: boolean;
  date: string;
  /**
   * Original extracted date text. Kept as a visible "Scan read:" hint when
   * the date cannot safely prefill, and also when normalization changed
   * its format (for example "Oct 30, 2026" prefilled as 2026-10-30), so
   * the reviewer can compare the prefilled value against the scan.
   */
  dateHint: string | null;
  /**
   * True while the extracted date still needs human review: it was
   * missing, could not be normalized, or the extractor flagged it
   * uncertain. Cleared only when the user supplies a valid calendar
   * date (see applyScannerDraftEdit); changing to another invalid or
   * incomplete value keeps it set.
   */
  dateNeedsReview: boolean;
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

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function toIsoDate(year: number, month: number, day: number): string | null {
  const pad = (value: number) => String(value).padStart(2, "0");
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  return isValidCalendarDate(candidate) ? candidate : null;
}

/**
 * Deterministically normalize an extracted date transcription to
 * YYYY-MM-DD, or return null when it cannot be read unambiguously.
 * No Date.parse and no locale-dependent parsing: month names come from
 * a fixed English table, and a numeric date such as 03/04/2026 — where
 * neither component can be told apart as day or month — is refused so
 * the reviewer enters it manually instead of Bucketa guessing.
 */
export function normalizeExtractedDate(
  dateText: string | null | undefined,
): string | null {
  if (!dateText) return null;
  const text = dateText.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (isValidCalendarDate(text)) return text;

  // "Oct 30, 2026" / "October 30, 2026" — the space after the comma is
  // optional, because handwriting transcription may omit it ("Oct 30,2026").
  const monthFirst = /^([A-Za-z]+)\.? (\d{1,2}),?\s*(\d{4})$/.exec(text);
  if (monthFirst) {
    const month = MONTH_NUMBERS[monthFirst[1].toLowerCase()];
    if (month === undefined) return null;
    return toIsoDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  // "30 Oct 2026" / "30 October 2026"
  const dayFirst = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})$/.exec(text);
  if (dayFirst) {
    const month = MONTH_NUMBERS[dayFirst[2].toLowerCase()];
    if (month === undefined) return null;
    return toIsoDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  // Numeric "13/04/2026" or "04/13/2026": only when one component is
  // greater than 12, which identifies it as the day without guessing.
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (first > 12 && second >= 1 && second <= 12) {
      return toIsoDate(year, second, first);
    }
    if (second > 12 && first >= 1 && first <= 12) {
      return toIsoDate(year, first, second);
    }
    return null;
  }

  return null;
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
    const validDate = normalizeExtractedDate(extractedDate) ?? "";
    return {
      transactionId: `scanner:${batchId}:${index}`,
      description: entry.description ?? "",
      type: initialType(entry, recordType),
      amountText: initialAmount(entry, result.currency),
      quantityText: entry.quantityText,
      unitPriceText: entry.unitPriceText,
      unitPriceMinor: entry.unitPriceMinor,
      expectedAmountMinor: entry.expectedAmountMinor,
      arithmeticMismatch: entry.arithmeticMismatch,
      date: validDate,
      // Preserve the original transcription as a hint when it could not
      // prefill, and when normalization rewrote its format, so the
      // reviewer sees both what the scan read and the prefilled value.
      dateHint:
        validDate && validDate === extractedDate.trim() ? null : entry.dateText,
      dateNeedsReview:
        !validDate ||
        entry.uncertainFields.includes("dateText") ||
        entry.reviewReasons.includes("dateText"),
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
    draft.arithmeticMismatch ||
    draft.confidence < 0.8 ||
    draft.uncertainFields.length > 0 ||
    draft.reviewReasons.includes("confidence") ||
    draft.reviewReasons.includes("currencyDetected") ||
    draft.reviewReasons.includes("amountMismatch")
  );
}

/** Friendly, non-technical review prompts for one scanner draft. */
const SCANNER_WARNING_LABELS: Record<string, string> = {
  amountText: "Check amount",
  quantityText: "Check quantity",
  unitPriceText: "Check unit price",
  amountMismatch: "Check amount: quantity × unit price doesn't match",
  dateText: "Check date",
  description: "Check description",
  type: "Check income or expense",
  currencyDetected: "Verify currency",
  confidence: "Please review this entry",
};

function formatDraftMinor(amountMinor: number, currency: string): string {
  try {
    return `${currency} ${minorUnitsToAmountInput(amountMinor, currency)}`;
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

/**
 * True while the draft's current amount still disagrees with the
 * server-computed quantity x unit price. Compared live, so correcting
 * the amount in review clears the mismatch (explicit confirmation is
 * still required, because the entry was flagged).
 */
export function scannerDraftAmountMismatch(draft: ScannerDraft): boolean {
  if (!draft.arithmeticMismatch || draft.expectedAmountMinor === null) return false;
  const amount = scannerDraftAmountMinor(draft, draft.currency);
  return amount !== null && amount !== draft.expectedAmountMinor;
}

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
  for (const field of draft.uncertainFields) {
    if (field !== "amountMismatch") add(field);
  }
  for (const reason of draft.reviewReasons) {
    if (reason !== "amountMismatch") add(reason);
  }
  if (draft.currencyConflict) add("currencyDetected");
  if (scannerDraftAmountMismatch(draft)) {
    const current = scannerDraftAmountMinor(draft, draft.currency);
    warnings.push(
      `Check amount: ${draft.quantityText ?? "?"} × ${draft.unitPriceMinor !== null ? formatDraftMinor(draft.unitPriceMinor, draft.currency) : "?"} = ${draft.expectedAmountMinor !== null ? formatDraftMinor(draft.expectedAmountMinor, draft.currency) : "?"}, but the scan read ${current !== null ? formatDraftMinor(current, draft.currency) : "an unclear amount"}`,
    );
  } else if (draft.arithmeticMismatch) {
    // Flagged by the server but not currently quantifiable (for example
    // the amount was cleared, or the expected total is not exactly
    // representable); keep a generic prompt until it is confirmed. When
    // the entered amount now equals the expected total, the mismatch is
    // resolved and no warning is shown.
    const current = scannerDraftAmountMinor(draft, draft.currency);
    if (draft.expectedAmountMinor === null || current === null) add("amountMismatch");
  }
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
  const next: ScannerDraft = reviewedFieldChanged
    ? { ...draft, ...patch, explicitlyConfirmed: false }
    : { ...draft, ...patch };
  // A date flagged for review stays flagged until the user supplies a
  // valid calendar date. Changing it to another invalid or incomplete
  // value (including clearing it) does not clear the flag.
  if (
    "date" in patch &&
    patch.date !== draft.date &&
    patch.date &&
    isValidCalendarDate(patch.date)
  ) {
    next.dateNeedsReview = false;
  }
  return next;
}

export type ScannerDateEditStatus = "valid" | "blank" | "invalid";

/** User-selectable scanner date display/manual-entry format. */
export type ScannerDateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

export const SCANNER_DATE_FORMATS: readonly ScannerDateFormat[] = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
];

export const DEFAULT_SCANNER_DATE_FORMAT: ScannerDateFormat = "DD/MM/YYYY";

/**
 * Format a committed internal ISO date for display under the selected
 * preference. Blank stays blank and invalid committed text is returned
 * verbatim, so changing preference never reinterprets stored values.
 */
export function formatScannerDateForDisplay(
  isoDate: string,
  format: ScannerDateFormat,
): string {
  if (!isoDate) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !isValidCalendarDate(isoDate)) {
    return isoDate;
  }
  const [year, month, day] = isoDate.split("-");
  switch (format) {
    case "DD/MM/YYYY":
      return `${day}/${month}/${year}`;
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "YYYY-MM-DD":
      return isoDate;
  }
}

export interface ScannerDateEditResolution {
  status: ScannerDateEditStatus;
  /** Committed draft date: the ISO date, "" for blank, or the exact invalid text. */
  date: string;
}

function scannerDateSeparator(format: ScannerDateFormat): string {
  return format === "YYYY-MM-DD" ? "-" : "/";
}

function isDayOrMonthAutoCompleted(component: "day" | "month", digit: string): boolean {
  const value = Number(digit);
  return component === "month" ? value >= 2 : value >= 4;
}

/** Format a digit stream, inserting separators after completed components. */
function formatScannerDateDigitStream(digits: string, format: ScannerDateFormat): string {
  const separator = scannerDateSeparator(format);
  const order: Array<"day" | "month" | "year"> =
    format === "DD/MM/YYYY"
      ? ["day", "month", "year"]
      : format === "MM/DD/YYYY"
        ? ["month", "day", "year"]
        : ["year", "month", "day"];
  let remaining = digits.slice(0, 8);
  const parts: string[] = [];
  for (const component of order) {
    if (!remaining) break;
    if (component === "year") {
      parts.push(remaining.slice(0, 4));
      remaining = remaining.slice(4);
      continue;
    }
    if (remaining.length === 1) {
      parts.push(
        isDayOrMonthAutoCompleted(component, remaining)
          ? `0${remaining}`
          : remaining,
      );
      remaining = "";
      break;
    }
    parts.push(remaining.slice(0, 2));
    remaining = remaining.slice(2);
  }
  const lastComponent = order[parts.length - 1];
  const lastComponentComplete =
    lastComponent === "year"
      ? parts[parts.length - 1]?.length === 4
      : parts[parts.length - 1]?.length === 2;
  return parts.join(separator) + (parts.length > 0 && parts.length < 3 && remaining === "" && lastComponentComplete ? separator : "");
}

/**
 * Format scanner date text while the user is typing. Pure and
 * deterministic: digits are interpreted only under the selected format,
 * separators are inserted after completed day/month/year components,
 * and a single day/month digit is zero-padded only when it cannot begin
 * a valid two-digit component (months 2-9, days 4-9). Completed
 * two-digit components are never reinterpreted, invalid values are not
 * corrected, and text containing other characters is returned untouched
 * for correction. Pass the previous formatted value so Backspace/Delete
 * over a separator removes the preceding digit instead of bouncing.
 */
export function formatScannerDateInput(
  enteredText: string,
  format: ScannerDateFormat,
  previousText = "",
): string {
  if (/[^\d/\-\s]/.test(enteredText)) return enteredText;
  const separator = scannerDateSeparator(format);

  // Backspace/Delete removed only a separator: remove the digit before
  // it as well, so the separator does not immediately reappear.
  if (previousText && enteredText.length < previousText.length) {
    const previousDigits = previousText.replace(/\D/g, "");
    const enteredDigits = enteredText.replace(/\D/g, "");
    if (previousDigits && previousDigits === enteredDigits) {
      let index = 0;
      while (
        index < enteredText.length &&
        index < previousText.length &&
        enteredText[index] === previousText[index]
      ) {
        index += 1;
      }
      if (previousText[index] === "/" || previousText[index] === "-") {
        const digitsAfterSeparator = previousText
          .slice(index + 1)
          .replace(/\D/g, "")
          .length;
        if (digitsAfterSeparator > 0) {
          // An internal separator is structural: restore it without
          // removing a digit or redistributing digits between components.
          return previousText;
        }
        const digitsBefore = previousText.slice(0, index).replace(/\D/g, "").length;
        if (digitsBefore > 0) {
          const digits = previousDigits.split("");
          digits.splice(digitsBefore - 1, 1);
          return formatScannerDateDigitStream(digits.join(""), format);
        }
      }
    }
  }

  if (/[/\-]/.test(enteredText)) {
    const order: Array<"day" | "month" | "year"> =
      format === "DD/MM/YYYY"
        ? ["day", "month", "year"]
        : format === "MM/DD/YYYY"
          ? ["month", "day", "year"]
          : ["year", "month", "day"];
    const maxLengths = order.map((component) => (component === "year" ? 4 : 2));
    const rawParts = enteredText.replace(/\s/g, "").split(/[/\-]/);
    if (rawParts.length > 3 || rawParts.some((part, i) => part.length > maxLengths[i])) {
      return enteredText;
    }
    const endsWithSeparator = /[/\-]$/.test(enteredText.trim());
    const parts = rawParts.map((part, i) => {
      const component = order[i];
      if (component === "year" || part.length !== 1) return part;
      const completed =
        i < rawParts.length - 1 || endsWithSeparator || isDayOrMonthAutoCompleted(component, part);
      return completed ? `0${part}` : part;
    });
    const lastComponent = order[parts.length - 1];
    const lastPart = parts[parts.length - 1];
    const shouldAppendSeparator =
      !endsWithSeparator &&
      parts.length < 3 &&
      lastComponent !== "year" &&
      lastPart?.length === 2;
    return parts.join(separator) + (shouldAppendSeparator ? separator : "");
  }

  return formatScannerDateDigitStream(enteredText.replace(/\D/g, ""), format);
}

export interface ScannerDateInputSelection {
  start: number;
  end: number;
}

/**
 * Map a browser selection from the entered text to the formatted text.
 * The longest unchanged prefix and suffix stay anchored; a caret after the
 * changed region shifts by the change in length, and a caret inside the
 * changed region is clamped inside the formatted replacement. This keeps
 * the caret beside the edited component when formatting inserts a leading
 * zero or separator instead of letting the controlled input move it to the
 * end. The text itself is never altered by this mapping.
 */
export function mapScannerDateInputSelection(
  enteredText: string,
  formattedText: string,
  selectionStart: number,
  selectionEnd: number,
): ScannerDateInputSelection {
  const clampEntered = (position: number) =>
    Math.min(Math.max(position, 0), enteredText.length);
  const start = clampEntered(selectionStart);
  const end = clampEntered(Math.max(selectionStart, selectionEnd));
  if (enteredText === formattedText) return { start, end };

  // Anchor the unchanged suffix first: when formatting inserts a character
  // identical to the digit after the caret (such as a leading zero before
  // an existing 0), that following digit must stay aligned with the suffix
  // rather than being claimed as part of the prefix.
  let suffix = 0;
  const maxSuffix = Math.min(enteredText.length, formattedText.length);
  while (
    suffix < maxSuffix &&
    enteredText[enteredText.length - 1 - suffix] ===
      formattedText[formattedText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  let prefix = 0;
  const maxPrefix = Math.min(
    enteredText.length - suffix,
    formattedText.length - suffix,
  );
  while (prefix < maxPrefix && enteredText[prefix] === formattedText[prefix]) {
    prefix += 1;
  }
  const enteredChangeEnd = enteredText.length - suffix;
  const formattedChangeEnd = formattedText.length - suffix;
  const lengthChange = formattedText.length - enteredText.length;
  const mapPosition = (position: number) => {
    if (position >= enteredChangeEnd) return position + lengthChange;
    if (position <= prefix) return position;
    return Math.min(position, formattedChangeEnd);
  };
  return { start: mapPosition(start), end: mapPosition(end) };
}

/**
 * Resolve a finished scanner date edit. This is only called when editing
 * is complete (Enter or blur), never per keystroke, so entries do not
 * regroup while the user is still typing. Parsing is strict under the
 * selected format only — Bucketa never guesses or switches formats.
 * Valid dates are stored internally as ISO YYYY-MM-DD; blank clears the
 * date; anything else is kept verbatim so the user sees and can correct
 * their own text. Invalid or incomplete values never clear
 * dateNeedsReview (see applyScannerDraftEdit) and always fail save
 * validation.
 */
export function resolveScannerDateEdit(
  enteredText: string,
  format: ScannerDateFormat = "YYYY-MM-DD",
): ScannerDateEditResolution {
  const trimmed = enteredText.trim();
  if (!trimmed) return { status: "blank", date: "" };
  let candidate: string | null = null;
  if (format === "DD/MM/YYYY") {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (match) candidate = `${match[3]}-${match[2]}-${match[1]}`;
  } else if (format === "MM/DD/YYYY") {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (match) candidate = `${match[3]}-${match[1]}-${match[2]}`;
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) candidate = trimmed;
  }
  if (candidate && isValidCalendarDate(candidate)) {
    return { status: "valid", date: candidate };
  }
  return { status: "invalid", date: enteredText };
}

/** Commit a finished date edit to a draft, preserving all review safeguards. */
export function applyScannerDateEdit(
  draft: ScannerDraft,
  enteredText: string,
  format: ScannerDateFormat = "YYYY-MM-DD",
): ScannerDraft {
  return applyScannerDraftEdit(draft, { date: resolveScannerDateEdit(enteredText, format).date });
}

/**
 * Commit a calendar-picker selection. The picker reports ISO dates, so
 * this never passes through manual format parsing. A blank picker value
 * clears the date; an invalid picker value (which native pickers should
 * never produce) leaves the draft untouched rather than committing it.
 */
export function applyScannerCalendarSelection(
  draft: ScannerDraft,
  pickerValue: string,
): ScannerDraft {
  if (!pickerValue) return applyScannerDraftEdit(draft, { date: "" });
  if (/^\d{4}-\d{2}-\d{2}$/.test(pickerValue) && isValidCalendarDate(pickerValue)) {
    return applyScannerDraftEdit(draft, { date: pickerValue });
  }
  return draft;
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
        ? `Enter the date as YYYY-MM-DD. The scan read “${draft.dateHint}”, which Bucketa could not safely convert to a single calendar date.`
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
  } else if (scannerDraftAmountMismatch(draft) && !draft.explicitlyConfirmed) {
    errors.push(
      `Confirm the checked amount: quantity × unit price is ${draft.expectedAmountMinor !== null ? formatDraftMinor(draft.expectedAmountMinor, context.expectedCurrency) : "unclear"}, which does not match the entered amount.`,
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

export interface ScannerDateGroupSummary {
  salesMinor: number;
  expensesMinor: number;
  salaryPaymentsMinor: number;
  otherIncomeMinor: number;
  netMinor: number;
  entryCount: number;
  countedEntries: number;
  incompleteEntries: number;
}

export interface ScannerDraftDateGroup {
  /** ISO date, or "needs-date-review" for the undated/uncertain group. */
  key: string;
  date: string | null;
  needsDateReview: boolean;
  drafts: ScannerDraft[];
  summary: ScannerDateGroupSummary;
}

function summarizeDateGroup(
  drafts: ScannerDraft[],
  recordType: ScannerRecordType,
  currency: string,
): ScannerDateGroupSummary {
  const summary: ScannerDateGroupSummary = {
    salesMinor: 0,
    expensesMinor: 0,
    salaryPaymentsMinor: 0,
    otherIncomeMinor: 0,
    netMinor: 0,
    entryCount: drafts.length,
    countedEntries: 0,
    incompleteEntries: 0,
  };
  for (const draft of drafts) {
    const amount = scannerDraftAmountMinor(draft, currency);
    if (amount === null || !draft.type) continue;
    summary.countedEntries += 1;
    // Partition by batch record type and direction, never by the
    // editable category text, so each entry is counted exactly once.
    if (recordType === "sales" && draft.type === "income") {
      summary.salesMinor += amount;
    } else if (recordType === "salaries" && draft.type === "expense") {
      summary.salaryPaymentsMinor += amount;
    } else if (draft.type === "expense") {
      summary.expensesMinor += amount;
    } else {
      summary.otherIncomeMinor += amount;
    }
  }
  summary.incompleteEntries = summary.entryCount - summary.countedEntries;
  summary.netMinor =
    summary.salesMinor +
    summary.otherIncomeMinor -
    summary.expensesMinor -
    summary.salaryPaymentsMinor;
  return summary;
}

/**
 * Group drafts by their reviewed date for display and daily summaries.
 * Valid dates sort earliest first; drafts whose date is missing,
 * invalid, or still flagged for review form a final "Needs Date
 * Review" group. Pure and non-mutating: the same draft objects keep
 * their stable identities, and editing a date or removing an entry
 * regroups automatically on the next call. These are review previews
 * only — they never affect saving or grand-total reconciliation.
 */
export function scannerDraftDateGroups(
  drafts: ScannerDraft[],
  recordType: ScannerRecordType,
  currency: string,
): ScannerDraftDateGroup[] {
  const dated = new Map<string, ScannerDraft[]>();
  const needsReview: ScannerDraft[] = [];
  for (const draft of drafts) {
    if (draft.dateNeedsReview || !isValidCalendarDate(draft.date)) {
      needsReview.push(draft);
    } else {
      const group = dated.get(draft.date) ?? [];
      group.push(draft);
      dated.set(draft.date, group);
    }
  }
  const groups: ScannerDraftDateGroup[] = [...dated.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, groupDrafts]) => ({
      key: date,
      date,
      needsDateReview: false,
      drafts: groupDrafts,
      summary: summarizeDateGroup(groupDrafts, recordType, currency),
    }));
  if (needsReview.length > 0) {
    groups.push({
      key: "needs-date-review",
      date: null,
      needsDateReview: true,
      drafts: needsReview,
      summary: summarizeDateGroup(needsReview, recordType, currency),
    });
  }
  return groups;
}

export type ScannerGrandTotalStatus =
  | "missing"
  | "unreadable"
  | "not-comparable"
  | "matching"
  | "mismatch";

export interface ScannerGrandTotalReconciliation {
  status: ScannerGrandTotalStatus;
  /** Written grand total as transcribed, when the extractor reported one. */
  documentTotalText: string | null;
  /** Written grand total in minor units; null when missing or unreadable. */
  documentTotalMinor: number | null;
  /** The single direction shared by every reviewed entry, when comparable. */
  direction: ScannerEntryType | null;
  /** Sum of the current editable draft amounts, in minor units. */
  reviewedEntryTotalMinor: number | null;
  /** Written total minus reviewed entry total (signed), when comparable. */
  differenceMinor: number | null;
  /** Sum of quantity x unit price, only when every entry supports it. */
  quantityTotalMinor: number | null;
  /** Written total minus the quantity-based total, when available. */
  quantityDifferenceMinor: number | null;
  quantityComparisonAvailable: boolean;
  countedEntries: number;
  mismatch: boolean;
  requiresAcknowledgment: boolean;
  /**
   * Fingerprint of everything the comparison is based on. A batch
   * acknowledgment is only valid for the exact key it was given for, so
   * editing an amount, changing a direction, or removing an entry
   * automatically invalidates a stale acknowledgment.
   */
  comparisonKey: string;
}

/**
 * Compare the written document grand total against the current editable
 * drafts, in exact minor-unit arithmetic. The written total is evidence
 * only: it never changes an entry, is never saved, and no balancing entry
 * is ever invented. A comparison is only made when every draft has a
 * usable amount and all entries share one direction — mixed income and
 * expense batches have no single meaningful document total.
 */
export function scannerGrandTotalReconciliation(
  drafts: ScannerDraft[],
  documentTotalText: string | null | undefined,
  documentTotalMinor: number | null | undefined,
  currency: string,
): ScannerGrandTotalReconciliation {
  const normalizedTotalText = documentTotalText?.trim() ? documentTotalText : null;
  const normalizedTotalMinor =
    typeof documentTotalMinor === "number" &&
    Number.isSafeInteger(documentTotalMinor) &&
    documentTotalMinor > 0
      ? documentTotalMinor
      : null;

  const draftKey = drafts
    .map(
      (draft) =>
        `${draft.transactionId}:${draft.type}:${scannerDraftAmountMinor(draft, currency) ?? "invalid"}:${draft.expectedAmountMinor ?? "none"}`,
    )
    .join("|");
  const comparisonKey = [
    normalizedTotalText ?? "",
    normalizedTotalMinor ?? "",
    draftKey,
  ].join("::");

  const base: ScannerGrandTotalReconciliation = {
    status: "missing",
    documentTotalText: normalizedTotalText,
    documentTotalMinor: normalizedTotalMinor,
    direction: null,
    reviewedEntryTotalMinor: null,
    differenceMinor: null,
    quantityTotalMinor: null,
    quantityDifferenceMinor: null,
    quantityComparisonAvailable: false,
    countedEntries: 0,
    mismatch: false,
    requiresAcknowledgment: false,
    comparisonKey,
  };

  if (normalizedTotalMinor === null) {
    return { ...base, status: normalizedTotalText ? "unreadable" : "missing" };
  }

  const amounts: number[] = [];
  const directions = new Set<ScannerEntryType>();
  let expectedTotal = 0;
  let quantityComplete = drafts.length > 0;
  for (const draft of drafts) {
    const amount = scannerDraftAmountMinor(draft, currency);
    if (!draft.type || amount === null) {
      return { ...base, status: "not-comparable" };
    }
    directions.add(draft.type);
    amounts.push(amount);
    if (draft.expectedAmountMinor === null) quantityComplete = false;
    else expectedTotal += draft.expectedAmountMinor;
  }
  if (drafts.length === 0 || directions.size !== 1) {
    return { ...base, status: "not-comparable" };
  }

  const reviewedEntryTotalMinor = amounts.reduce((sum, amount) => sum + amount, 0);
  const differenceMinor = normalizedTotalMinor - reviewedEntryTotalMinor;
  const mismatch = differenceMinor !== 0;
  return {
    ...base,
    status: mismatch ? "mismatch" : "matching",
    direction: [...directions][0],
    reviewedEntryTotalMinor,
    differenceMinor,
    quantityTotalMinor: quantityComplete ? expectedTotal : null,
    quantityDifferenceMinor: quantityComplete
      ? normalizedTotalMinor - expectedTotal
      : null,
    quantityComparisonAvailable: quantityComplete,
    countedEntries: amounts.length,
    mismatch,
    requiresAcknowledgment: mismatch,
  };
}

/** True when a mismatch acknowledgment for this exact comparison exists. */
export function scannerGrandTotalAcknowledgmentSatisfied(
  reconciliation: ScannerGrandTotalReconciliation,
  acknowledgedComparisonKey: string | null,
): boolean {
  return (
    !reconciliation.requiresAcknowledgment ||
    acknowledgedComparisonKey === reconciliation.comparisonKey
  );
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
