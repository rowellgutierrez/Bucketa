import type { TransactionType } from "../data/types.ts";

export interface TransactionDisplay {
  readonly label: string;
  readonly context: string;
  readonly sign: "+" | "−" | "";
  readonly amountClass: "amount-in" | "amount-out" | "amount-movement";
  readonly icon: "income" | "expenses" | "transfer" | "pos" | "deposit" | "withdrawal";
}

/** Presentation only. A sign describes the recorded type, never changes money.
 * Savings signs are relative to savings, not total wealth or cash flow.
 * Generic transfers have no confirmed direction, so receive no +/- sign.
 */
const DISPLAY: Record<TransactionType, TransactionDisplay> = {
  income: {
    label: "Income", context: "Recorded income", sign: "+",
    amountClass: "amount-in", icon: "income",
  },
  expense: {
    label: "Expense", context: "Recorded expense", sign: "−",
    amountClass: "amount-out", icon: "expenses",
  },
  transfer: {
    label: "Transfer", context: "Movement · direction unspecified", sign: "",
    amountClass: "amount-movement", icon: "transfer",
  },
  sale: {
    label: "POS sale", context: "Sales revenue · separate from recorded income", sign: "+",
    amountClass: "amount-movement", icon: "pos",
  },
  "savings-deposit": {
    label: "Savings deposit", context: "Into savings · not income", sign: "+",
    amountClass: "amount-movement", icon: "deposit",
  },
  "savings-withdrawal": {
    label: "Savings withdrawal", context: "Out of savings · not an expense", sign: "−",
    amountClass: "amount-out", icon: "withdrawal",
  },
};

export function transactionDisplay(type: TransactionType): TransactionDisplay {
  return DISPLAY[type];
}
