import type { Transaction } from "../data/types";
import type { MinorUnits } from "./currency";

export interface CurrencySummary {
  currency: string;
  income: MinorUnits;
  expense: MinorUnits;
  net: MinorUnits;
}

export interface MonthlyTotals {
  /** YYYY-MM */
  month: string;
  income: MinorUnits;
  expense: MinorUnits;
}

export interface CategoryTotal {
  category: string;
  total: MinorUnits;
}

/** Income/expense totals per currency. Currencies are never combined. */
export function summarizeTransactions(transactions: Transaction[]): CurrencySummary[] {
  const byCurrency = new Map<string, CurrencySummary>();
  for (const txn of transactions) {
    if (txn.type !== "income" && txn.type !== "expense") continue;
    const entry =
      byCurrency.get(txn.currency) ??
      { currency: txn.currency, income: 0, expense: 0, net: 0 };
    entry[txn.type] += txn.amountMinor;
    entry.net = entry.income - entry.expense;
    byCurrency.set(txn.currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Inclusive YYYY-MM-DD date filter on the transaction date. */
export function filterByDateRange(
  transactions: Transaction[],
  from: string,
  to: string,
): Transaction[] {
  return transactions.filter((txn) => {
    const day = txn.date.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

/** Monthly income/expense totals for one currency, oldest first. */
export function monthlyIncomeExpense(
  transactions: Transaction[],
  currency: string,
): MonthlyTotals[] {
  const byMonth = new Map<string, MonthlyTotals>();
  for (const txn of transactions) {
    if (txn.currency !== currency) continue;
    if (txn.type !== "income" && txn.type !== "expense") continue;
    const month = txn.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const entry = byMonth.get(month) ?? { month, income: 0, expense: 0 };
    entry[txn.type] += txn.amountMinor;
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface GoalProgress {
  /** Saved amount for the bucket in its currency; see bucketSavedMinor. */
  savedMinor: MinorUnits;
  /** 0–100, clamped. Negative saved counts as 0. */
  percent: number;
}

export type SavingsMovementType = Extract<
  Transaction["type"],
  "savings-deposit" | "savings-withdrawal"
>;

/**
 * Amount currently saved in one bucket, in the bucket's own currency only.
 * Legacy assigned income/expense records keep counting exactly as before;
 * savings deposits add and savings withdrawals subtract. Savings movements
 * are never income or expenses. Currencies never mix.
 */
export function bucketSavedMinor(
  transactions: Transaction[],
  bucket: { id: string; currency: string },
): MinorUnits {
  let saved = 0;
  for (const txn of transactions) {
    if (txn.bucketId !== bucket.id || txn.currency !== bucket.currency) continue;
    if (txn.type === "income" || txn.type === "savings-deposit") saved += txn.amountMinor;
    else if (txn.type === "expense" || txn.type === "savings-withdrawal") {
      saved -= txn.amountMinor;
    }
  }
  return saved;
}

/**
 * Validates a savings movement against the bucket's saved amount. Returns an
 * error message, or null when the movement may be saved. A withdrawal may
 * never exceed the amount currently saved in that bucket and currency.
 */
export function savingsMovementError(
  transactions: Transaction[],
  bucket: { id: string; currency: string },
  type: SavingsMovementType,
  amountMinor: number,
): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return "Amount must be a valid amount greater than zero.";
  }
  if (type === "savings-withdrawal") {
    const saved = bucketSavedMinor(transactions, bucket);
    if (amountMinor > saved) return "Withdrawal exceeds the amount saved in this bucket.";
  }
  return null;
}

/**
 * Savings progress for one bucket with a goal, in the bucket's own currency
 * only. Returns null when the bucket has no goal. Currencies never mix.
 */
export function bucketGoalProgress(
  transactions: Transaction[],
  bucket: { id: string; currency: string; targetMinor?: number | null },
): GoalProgress | null {
  if (!bucket.targetMinor || bucket.targetMinor <= 0) return null;
  const saved = bucketSavedMinor(transactions, bucket);
  return {
    savedMinor: saved,
    percent: Math.min(100, Math.max(0, (saved / bucket.targetMinor) * 100)),
  };
}

/** Expense totals by category for one currency, largest first. */
export function expenseByCategory(
  transactions: Transaction[],
  currency: string,
): CategoryTotal[] {
  const byCategory = new Map<string, MinorUnits>();
  for (const txn of transactions) {
    if (txn.currency !== currency || txn.type !== "expense") continue;
    const category = txn.category?.trim() ? txn.category : "Uncategorised";
    byCategory.set(category, (byCategory.get(category) ?? 0) + txn.amountMinor);
  }
  return [...byCategory.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}
