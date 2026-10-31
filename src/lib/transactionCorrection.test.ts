import assert from "node:assert/strict";
import test from "node:test";
import type { Transaction } from "../data/types.ts";
import { monthlyIncomeExpense, summarizeTransactions } from "./finance.ts";
import {
  applyTransactionCorrection,
  buildTransactionCorrectionPatch,
  isCorrectableTransaction,
} from "./transactionCorrection.ts";

/**
 * Offline correction-workflow tests (Phase B3.2). All records are
 * fictional. IndexedDB itself is not available under node --test, so the
 * repository merge is simulated with applyTransactionCorrection, which
 * mirrors transactionsRepo.update (patch merged over the stored record;
 * id, createdAt, and profileId always taken from the stored record).
 * The pages wire these helpers to the real repository unchanged.
 */

const stamp = "2026-10-27T00:00:00.000Z";

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-1",
    profileId: "profile-1",
    bucketId: "bucket-1",
    type: "expense",
    amountMinor: 15000,
    currency: "PHP",
    date: "2026-10-05",
    description: "Burger",
    category: "Food",
    origin: "scanner-confirmed",
    relatedId: "scanner-batch:batch-1",
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function correct(
  existing: Transaction,
  over: Partial<Parameters<typeof buildTransactionCorrectionPatch>[1]> = {},
): Transaction {
  const patch = buildTransactionCorrectionPatch(existing, {
    type: existing.type as "income" | "expense",
    amountMinor: existing.amountMinor,
    currency: existing.currency,
    date: existing.date,
    description: existing.description,
    category: existing.category,
    bucketId: existing.bucketId,
    ...over,
  });
  return applyTransactionCorrection(existing, patch, "2026-11-01T00:00:00.000Z");
}

test("scanner-confirmed income and expense are eligible for correction", () => {
  assert.equal(isCorrectableTransaction(txn({ type: "income" })), true);
  assert.equal(isCorrectableTransaction(txn({ type: "expense" })), true);
});

test("manual transaction editing eligibility is unchanged", () => {
  assert.equal(
    isCorrectableTransaction(txn({ origin: "manual", relatedId: null, type: "income" })),
    true,
  );
  assert.equal(
    isCorrectableTransaction(txn({ origin: "manual", relatedId: null, type: "expense" })),
    true,
  );
});

test("POS-origin records remain restricted", () => {
  assert.equal(isCorrectableTransaction(txn({ origin: "pos", type: "income" })), false);
  assert.equal(isCorrectableTransaction(txn({ origin: "pos", type: "sale" })), false);
});

test("savings movements and other protected types remain restricted", () => {
  assert.equal(isCorrectableTransaction(txn({ origin: "manual", type: "savings-deposit" })), false);
  assert.equal(isCorrectableTransaction(txn({ origin: "manual", type: "savings-withdrawal" })), false);
  assert.equal(isCorrectableTransaction(txn({ origin: "scanner-confirmed", type: "transfer" })), false);
});

test("scanner provenance is preserved after editing", () => {
  const before = txn();
  const after = correct(before, { amountMinor: 17500, description: "Burger (large)" });
  assert.equal(after.origin, "scanner-confirmed");
  assert.equal(after.relatedId, "scanner-batch:batch-1");
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, "2026-11-01T00:00:00.000Z");
});

test("currency, bucket, and profile cannot change for scanner-confirmed records", () => {
  const before = txn();
  const patch = buildTransactionCorrectionPatch(before, {
    type: "expense",
    amountMinor: 15000,
    currency: "USD",
    date: before.date,
    description: before.description,
    category: before.category,
    bucketId: "bucket-OTHER",
  });
  assert.ok(!("currency" in patch));
  assert.ok(!("bucketId" in patch));
  assert.ok(!("profileId" in patch));
  assert.ok(!("origin" in patch));
  assert.ok(!("relatedId" in patch));
  const after = applyTransactionCorrection(before, patch, "2026-11-01T00:00:00.000Z");
  assert.equal(after.currency, "PHP");
  assert.equal(after.bucketId, "bucket-1");
  assert.equal(after.profileId, "profile-1");
});

test("manual records keep the existing editable currency and bucket behaviour", () => {
  const manual = txn({ origin: "manual", relatedId: null });
  const patch = buildTransactionCorrectionPatch(manual, {
    type: "expense",
    amountMinor: 15000,
    currency: "USD",
    date: manual.date,
    description: manual.description,
    category: manual.category,
    bucketId: null,
  });
  assert.equal(patch.currency, "USD");
  assert.equal(patch.bucketId, null);
});

test("corrected amounts are reflected in financial calculations", () => {
  const records = [
    txn({ id: "a", type: "income", amountMinor: 25000 }),
    txn({ id: "b", type: "expense", amountMinor: 15000 }),
  ];
  const corrected = records.map((r) =>
    r.id === "b" ? correct(r, { amountMinor: 10000 }) : r,
  );
  const [summary] = summarizeTransactions(corrected);
  assert.equal(summary.income, 25000);
  assert.equal(summary.expense, 10000);
  assert.equal(summary.net, 15000);
});

test("corrected dates are reflected in period summaries", () => {
  const before = txn({ date: "2026-10-05", amountMinor: 15000 });
  const after = correct(before, { date: "2026-11-02" });
  const months = monthlyIncomeExpense([after], "PHP");
  assert.deepEqual(months, [{ month: "2026-11", income: 0, expense: 15000 }]);
});

test("deleting a scanner-confirmed record updates summaries", () => {
  const records = [
    txn({ id: "a", type: "income", amountMinor: 25000 }),
    txn({ id: "b", type: "expense", amountMinor: 15000 }),
  ];
  const remaining = records.filter((r) => r.id !== "b");
  const [summary] = summarizeTransactions(remaining);
  assert.equal(summary.expense, 0);
  assert.equal(summary.net, 25000);
});

test("a corrected saved scan no longer matches its original planned batch", () => {
  // saveScannerTransactions resolves "already-saved" only when every
  // planned record exists with identical financial content (id, profile,
  // bucket, type, amount, currency, date, description, category, origin,
  // relatedId). A correction changes that content, so re-saving the
  // original batch must conflict rather than duplicate or overwrite.
  const saved = txn();
  const corrected = correct(saved, { amountMinor: 99900, date: "2026-10-06" });
  const financialContent = (r: Transaction) =>
    JSON.stringify({
      id: r.id, profileId: r.profileId, bucketId: r.bucketId, type: r.type,
      amountMinor: r.amountMinor, currency: r.currency, date: r.date,
      description: r.description, category: r.category, origin: r.origin,
      relatedId: r.relatedId,
    });
  assert.notEqual(financialContent(corrected), financialContent(saved));
  // An untouched record still matches exactly, preserving already-saved.
  assert.equal(financialContent(correct(saved)), financialContent(saved));
});
