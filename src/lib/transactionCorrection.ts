import type { Transaction } from "../data/types.ts";

/**
 * Safe correction rules for saved income/expense records.
 *
 * Manual and scanner-confirmed income/expense records may be corrected
 * through the existing history-page forms. POS records, transfers, sales,
 * and savings movements stay managed by their own workflows and are never
 * correctable here. Scanner-confirmed records keep their provenance,
 * ownership, bucket, and currency: a correction may only change the type,
 * amount, date, description, and category that the reviewer can see.
 */

export function isScannerConfirmedTransaction(
  txn: Pick<Transaction, "origin">,
): boolean {
  return txn.origin === "scanner-confirmed";
}

export function isCorrectableTransaction(
  txn: Pick<Transaction, "origin" | "type">,
): boolean {
  return (
    (txn.origin === "manual" || txn.origin === "scanner-confirmed") &&
    (txn.type === "income" || txn.type === "expense")
  );
}

export interface TransactionCorrectionInput {
  type: "income" | "expense";
  amountMinor: number;
  /** Currency entered in the form. Ignored for scanner-confirmed records. */
  currency: string;
  date: string;
  description: string;
  category: string | null;
  /** Bucket selected in the form. Ignored for scanner-confirmed records. */
  bucketId: string | null;
}

/**
 * Build the repository patch for a correction. The patch never contains
 * id, createdAt, profileId, origin, or relatedId, so repository update
 * preserves them. For scanner-confirmed records it also omits currency
 * and bucketId, so neither can change through the correction form.
 */
export function buildTransactionCorrectionPatch(
  existing: Transaction,
  input: TransactionCorrectionInput,
): Partial<Transaction> {
  const patch: Partial<Transaction> = {
    type: input.type,
    amountMinor: input.amountMinor,
    date: input.date,
    description: input.description,
    category: input.category,
  };
  if (!isScannerConfirmedTransaction(existing)) {
    patch.currency = input.currency as Transaction["currency"];
    patch.bucketId = input.bucketId;
  }
  return patch;
}

/**
 * Apply a correction patch the way the repository update does: merged
 * over the existing record with identity, ownership, and creation time
 * always taken from the stored record.
 */
export function applyTransactionCorrection(
  existing: Transaction,
  patch: Partial<Transaction>,
  updatedAt: string,
): Transaction {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    profileId: existing.profileId,
    origin: existing.origin,
    relatedId: existing.relatedId,
    updatedAt,
  };
}
