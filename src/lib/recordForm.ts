import type { TransactionType } from "../data/types";
import {
  minorUnitDigits,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "./currency.ts";

/** The two editable record types that carry an amount in the record forms. */
export type EntryType = Extract<TransactionType, "income" | "expense">;

/**
 * Income and expense amounts live in independent fields. Switching the
 * Income/Expense toggle never carries a typed value from one side to the
 * other, and editing a record fills only its own type's field.
 */
export interface RecordAmounts {
  income: string;
  expense: string;
}

export function emptyRecordAmounts(): RecordAmounts {
  return { income: "", expense: "" };
}

export function amountOf(amounts: RecordAmounts, type: EntryType): string {
  return amounts[type];
}

export function withAmount(
  amounts: RecordAmounts,
  type: EntryType,
  value: string,
): RecordAmounts {
  return { ...amounts, [type]: value };
}

/** Amounts to show when editing: only the record's own type is populated. */
export function amountsForEdit(type: EntryType, amountText: string): RecordAmounts {
  return withAmount(emptyRecordAmounts(), type, amountText);
}

/** Strict YYYY-MM-DD check that also rejects non-existent dates like 2026-02-31. */
export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * A record assigned to a bucket must use the bucket's currency. Returns an
 * error message on mismatch, or null when the currency is acceptable.
 */
export function bucketCurrencyMismatch(
  bucketCurrency: string,
  transactionCurrency: string,
): string | null {
  if (bucketCurrency === transactionCurrency) return null;
  return (
    `This bucket is in ${bucketCurrency}, so the record currency must be ` +
    `${bucketCurrency} (currently ${transactionCurrency}). Change the ` +
    `currency, choose a different bucket, or set the bucket to None to ` +
    `correct this record first and reassign it afterwards.`
  );
}

/**
 * Re-read the same displayed amount number in another currency, with no
 * exchange-rate conversion: $500.00 becomes ¥500 or ₱500.00 as minor units.
 * Used only when a user explicitly corrects a record's currency.
 */
export function reinterpretAmountMinor(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
): number {
  if (fromCurrency === toCurrency) return amountMinor;
  const text = minorUnitsToAmountInput(amountMinor, fromCurrency);
  const digits = minorUnitDigits(toCurrency);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > digits) {
    // A trailing zero fraction (500.00 -> 500) is preserved exactly; a real
    // fraction the target currency cannot represent must be edited by hand.
    if (!/^0*$/.test(fraction.slice(digits))) {
      throw new Error(
        `${toCurrency} cannot represent the fraction in ${text}; edit the amount when correcting the currency.`,
      );
    }
    const trimmed = digits === 0 ? whole : `${whole}.${fraction.slice(0, digits)}`;
    return parseAmountToMinorUnits(trimmed, toCurrency);
  }
  return parseAmountToMinorUnits(text, toCurrency);
}

export interface PlannedEntry {
  type: EntryType;
  amountMinor: number;
}

export type PlannedSave =
  | { ok: true; entries: PlannedEntry[] }
  | { ok: false; message: string };

/** Types with a non-empty amount entered, income first. */
export function plannedEntryTypes(amounts: RecordAmounts): EntryType[] {
  return (["income", "expense"] as EntryType[]).filter(
    (type) => amounts[type].trim() !== "",
  );
}

/**
 * Validates EVERY entered amount before anything is saved, so an invalid
 * Income or Expense entry blocks the whole save and is never silently
 * discarded. Only entered sides produce transactions.
 */
export function planSaveAmounts(
  amounts: RecordAmounts,
  currency: string,
): PlannedSave {
  const types = plannedEntryTypes(amounts);
  if (types.length === 0) {
    return { ok: false, message: "Enter an amount for income or expense." };
  }
  const entries: PlannedEntry[] = [];
  for (const type of types) {
    const label = type === "income" ? "Income" : "Expense";
    try {
      const amountMinor = parseAmountToMinorUnits(amounts[type], currency);
      if (amountMinor <= 0) {
        return { ok: false, message: `${label} amount must be greater than zero.` };
      }
      entries.push({ type, amountMinor });
    } catch (error) {
      return {
        ok: false,
        message: `${label} amount: ${error instanceof Error ? error.message : "invalid amount"}`,
      };
    }
  }
  return { ok: true, entries };
}

/** A bucket's currency may be corrected only while no records are assigned. */
export function canChangeBucketCurrency(assignedCount: number): boolean {
  return assignedCount === 0;
}
