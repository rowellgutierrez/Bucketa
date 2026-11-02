import type { Employee, Transaction } from "../data/types.ts";
import { summarizeTransactions } from "./finance.ts";

/**
 * Employees & salary payments — pure helpers.
 *
 * A salary/bonus/advance payment is exactly one business expense
 * transaction. The link to its employee is the transaction's relatedId
 * (the employee ID); older records written before employee linking carry
 * only the "Salary payment — <name>" description, which is parsed as a
 * legacy fallback. Salary *rates* live on the employee record and are
 * never treated as payments. Nothing here creates records.
 */

export type CompensationType = "salary" | "bonus" | "advance";

/** Explicit units only; exact decimal multiplication, rounded half-up to one
 * currency minor unit. No record is created or changed by this helper. */
export function calculatePaymentMinor(rateMinor: number, units: string): number {
  if (!Number.isSafeInteger(rateMinor) || rateMinor <= 0) throw new Error("Enter a positive rate.");
  if (!/^\d{1,9}(?:\.\d{1,4})?$/.test(units.trim())) throw new Error("Enter units worked (up to 4 decimal places).");
  const [whole, fraction = ""] = units.trim().split(".");
  const scale = 10n ** BigInt(fraction.length);
  const quantity = BigInt(whole) * scale + BigInt(fraction || "0");
  if (quantity <= 0n) throw new Error("Units worked must be greater than zero.");
  const result = (BigInt(rateMinor) * quantity + scale / 2n) / scale;
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Calculated payment is outside the supported range.");
  return Number(result);
}

export const COMPENSATION_CATEGORIES: Record<CompensationType, string> = {
  salary: "Salaries",
  bonus: "Bonuses",
  advance: "Advances",
};

export const COMPENSATION_LABELS: Record<CompensationType, string> = {
  salary: "Salary",
  bonus: "Bonus",
  advance: "Advance",
};

const CATEGORY_TYPES = new Map<string, CompensationType>([
  ["salaries", "salary"],
  ["bonuses", "bonus"],
  ["advances", "advance"],
]);

/** The compensation type of a transaction, or null when it is not one. */
export function compensationTypeOf(txn: Transaction): CompensationType | null {
  if (txn.type !== "expense") return null;
  const byCategory = CATEGORY_TYPES.get((txn.category ?? "").trim().toLowerCase());
  if (byCategory) return byCategory;
  const match = /^(salary|bonus|advance)\s+payment\b/i.exec(txn.description.trim());
  if (match) return match[1].toLowerCase() as CompensationType;
  return null;
}

/** Employee name written into a payment description, when present. */
export function paymentEmployeeName(description: string): string | null {
  const match = /^(?:salary|bonus|advance)\s+payment\s*[—:-]\s*([^—·(]+)/i.exec(description.trim());
  return match ? match[1].trim() : null;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Unambiguous display label for picking one employee out of a list.
 *
 * Selection everywhere is by unique employee ID; this only fixes what the
 * user *sees* before choosing. Employees sharing a name are distinguished
 * by position; when name and position are both identical, a stable short
 * suffix derived from the employee's own ID (never contact details or any
 * other sensitive field) separates them. Unique names stay bare.
 */
export function employeeOptionLabel(employee: Employee, employees: readonly Employee[]): string {
  const sameName = employees.filter(
    (e) => e.profileId === employee.profileId && normalizedName(e.name) === normalizedName(employee.name),
  );
  if (sameName.length <= 1) return employee.name;
  const withRole = `${employee.name} — ${employee.role?.trim() ? employee.role.trim() : "No position recorded"}`;
  const sameNameAndRole = sameName.filter(
    (e) => (e.role?.trim().toLowerCase() ?? "") === (employee.role?.trim().toLowerCase() ?? ""),
  );
  if (sameNameAndRole.length <= 1) return withRole;
  const suffixOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(-4) || id;
  const suffix = suffixOf(employee.id);
  const collides = sameNameAndRole.some((e) => e.id !== employee.id && suffixOf(e.id) === suffix);
  return `${withRole} · #${collides ? employee.id : suffix}`;
}

/**
 * Payments belonging to one employee within their own business only:
 * linked by relatedId, or — for legacy unlinked records — by the exact
 * name written in the payment description.
 */
export function paymentsForEmployee(transactions: Transaction[], employee: Employee): Transaction[] {
  return transactions
    .filter((t) => {
      if (t.profileId !== employee.profileId) return false;
      if (!compensationTypeOf(t)) return false;
      if (t.relatedId) return t.relatedId === employee.id;
      const name = paymentEmployeeName(t.description);
      return name !== null && normalizedName(name) === normalizedName(employee.name);
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export interface EmployeePaymentSummary {
  employeeId: string;
  paymentCount: number;
  /** Totals per currency; currencies are never combined. */
  totalsByCurrency: { currency: string; totalMinor: number }[];
  lastPayment: { date: string; amountMinor: number; currency: string; type: CompensationType } | null;
}

export function summarizeEmployeePayments(
  employees: Employee[],
  transactions: Transaction[],
): EmployeePaymentSummary[] {
  return employees.map((employee) => {
    const payments = paymentsForEmployee(transactions, employee);
    const byCurrency = new Map<string, number>();
    for (const p of payments) byCurrency.set(p.currency, (byCurrency.get(p.currency) ?? 0) + p.amountMinor);
    const last = payments[0];
    return {
      employeeId: employee.id,
      paymentCount: payments.length,
      totalsByCurrency: [...byCurrency.entries()]
        .map(([currency, totalMinor]) => ({ currency, totalMinor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      lastPayment: last
        ? {
            date: last.date.slice(0, 10),
            amountMinor: last.amountMinor,
            currency: last.currency,
            type: compensationTypeOf(last) ?? "salary",
          }
        : null,
    };
  });
}

export interface CompensationMonth {
  /** YYYY-MM */
  month: string;
  salaryMinor: number;
  bonusMinor: number;
  advanceMinor: number;
  totalMinor: number;
  count: number;
}

/** Monthly compensation totals for one business and currency, oldest first. */
export function monthlyCompensation(
  transactions: Transaction[],
  profileId: string,
  currency: string,
): CompensationMonth[] {
  const byMonth = new Map<string, CompensationMonth>();
  for (const t of transactions) {
    if (t.profileId !== profileId || t.currency !== currency) continue;
    const type = compensationTypeOf(t);
    if (!type) continue;
    const month = t.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const entry = byMonth.get(month) ?? {
      month, salaryMinor: 0, bonusMinor: 0, advanceMinor: 0, totalMinor: 0, count: 0,
    };
    if (type === "salary") entry.salaryMinor += t.amountMinor;
    else if (type === "bonus") entry.bonusMinor += t.amountMinor;
    else entry.advanceMinor += t.amountMinor;
    entry.totalMinor += t.amountMinor;
    entry.count += 1;
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface BusinessCompensationSummary {
  currency: string;
  salaryMinor: number;
  bonusMinor: number;
  advanceMinor: number;
  totalMinor: number;
  paymentCount: number;
  /** Recorded business income in the same currency (income records only,
   * POS revenue excluded to avoid double counting). */
  incomeMinor: number;
  /** Compensation as a percentage of recorded income, or null when there
   * is no recorded income to compare against. Context only — recorded
   * cash flow is never profit. */
  percentOfIncome: number | null;
}

/** Per-currency compensation vs recorded income for one business. */
export function businessCompensationSummary(
  transactions: Transaction[],
  profileId: string,
): BusinessCompensationSummary[] {
  const own = transactions.filter((t) => t.profileId === profileId);
  const incomeByCurrency = new Map(
    summarizeTransactions(own).map((s) => [s.currency, s.income]),
  );
  const currencies = new Set<string>();
  const result = new Map<string, BusinessCompensationSummary>();
  for (const t of own) {
    const type = compensationTypeOf(t);
    if (!type) continue;
    currencies.add(t.currency);
    const entry = result.get(t.currency) ?? {
      currency: t.currency,
      salaryMinor: 0, bonusMinor: 0, advanceMinor: 0, totalMinor: 0,
      paymentCount: 0, incomeMinor: incomeByCurrency.get(t.currency) ?? 0,
      percentOfIncome: null,
    };
    if (type === "salary") entry.salaryMinor += t.amountMinor;
    else if (type === "bonus") entry.bonusMinor += t.amountMinor;
    else entry.advanceMinor += t.amountMinor;
    entry.totalMinor += t.amountMinor;
    entry.paymentCount += 1;
    result.set(t.currency, entry);
  }
  for (const entry of result.values()) {
    entry.percentOfIncome = entry.incomeMinor > 0
      ? (entry.totalMinor / entry.incomeMinor) * 100
      : null;
  }
  return [...result.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Builds the single expense transaction behind a confirmed payment. The
 * caller supplies the stable ID at preview time, so confirming twice (or
 * refreshing mid-save) can never create a second expense for one payment.
 */
export function buildCompensationTransaction(args: {
  id: string;
  employee: Employee;
  type: CompensationType;
  amountMinor: number;
  currency: string;
  date: string;
  note?: string;
  timestamp: string;
}): Transaction {
  const label = COMPENSATION_LABELS[args.type];
  const note = (args.note ?? "").trim();
  return {
    id: args.id,
    profileId: args.employee.profileId,
    bucketId: null,
    type: "expense",
    amountMinor: args.amountMinor,
    currency: args.currency,
    date: args.date,
    description: `${label} payment — ${args.employee.name}${note ? ` · ${note}` : ""}`,
    category: COMPENSATION_CATEGORIES[args.type],
    origin: "manual",
    relatedId: args.employee.id,
    createdAt: args.timestamp,
    updatedAt: args.timestamp,
  };
}
