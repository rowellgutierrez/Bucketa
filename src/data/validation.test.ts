import assert from "node:assert/strict";
import test from "node:test";
import {
  BucketaDataError,
  computeSaleTotal,
  findUnsafeBusinessReferences,
  validateBucket,
  validateProduct,
  validateProfile,
  validateSale,
  validateTransaction,
} from "./validation.ts";
import { bucketsRepo, initDb } from "./db.ts";
import {
  formatMoney,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency.ts";
import {
  expenseByCategory,
  filterByDateRange,
  monthlyIncomeExpense,
  summarizeTransactions,
} from "../lib/finance.ts";

const stamp = "2026-10-27T00:00:00.000Z";

test("profiles require a name and a valid ISO 4217 currency", () => {
  const ok = validateProfile({
    id: "p1", kind: "business", name: "Sari Store", currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
  });
  assert.equal(ok.currency, "PHP");
  assert.throws(
    () => validateProfile({
      id: "p2", kind: "personal", name: "  ", currency: "PHP",
      createdAt: stamp, updatedAt: stamp,
    }),
    BucketaDataError,
  );
  assert.throws(
    () => validateProfile({
      id: "p3", kind: "personal", name: "Ana", currency: "php",
      createdAt: stamp, updatedAt: stamp,
    }),
    BucketaDataError,
  );
});

test("buckets stay attached to a profile with their own currency", () => {
  const bucket = validateBucket({
    id: "b1", profileId: "p1", name: "Rent fund", kind: "budget", currency: "KRW",
    createdAt: stamp, updatedAt: stamp,
  });
  assert.equal(bucket.profileId, "p1");
  assert.throws(
    () => validateBucket({
      id: "b2", profileId: "", name: "X", kind: "budget", currency: "PHP",
      createdAt: stamp, updatedAt: stamp,
    }),
    BucketaDataError,
  );
});

test("buckets reject invalid kind/currency, and create validates before storage", async () => {
  const base = {
    id: "b3", profileId: "p1", name: "Rent fund", kind: "budget" as const,
    currency: "PHP", createdAt: stamp, updatedAt: stamp,
  };
  assert.throws(() => validateBucket({ ...base, kind: "other" as never }), BucketaDataError);
  assert.throws(() => validateBucket({ ...base, currency: "php" }), BucketaDataError);
  assert.throws(() => validateBucket({ ...base, name: " " }), BucketaDataError);
  // Validation runs before any IndexedDB access, so this rejects in Node too.
  await assert.rejects(() => bucketsRepo.create({ ...base, currency: "XX" }), BucketaDataError);
});

test("renaming a business keeps its id/currency, so its buckets stay attached", () => {
  const profile = validateProfile({
    id: "p1", kind: "business", name: "Old Name", currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
  });
  const renamed = validateProfile({ ...profile, name: "New Name" });
  assert.equal(renamed.id, profile.id);
  assert.equal(renamed.currency, profile.currency);
  const bucket = validateBucket({
    id: "b1", profileId: renamed.id, name: "Rent fund", kind: "budget",
    currency: "PHP", createdAt: stamp, updatedAt: stamp,
  });
  assert.equal(bucket.profileId, profile.id);
  assert.throws(() => validateProfile({ ...profile, name: "  " }), BucketaDataError);
});

test("business deletion is refused when another business references its records", () => {
  const bucket = {
    id: "b1", profileId: "p1", name: "Rent", kind: "budget" as const,
    currency: "PHP", createdAt: stamp, updatedAt: stamp,
  };
  const product = {
    id: "pr1", profileId: "p1", name: "Rice", sku: "RICE", priceMinor: 100,
    costMinor: 50, currency: "PHP", stock: 1, createdAt: stamp, updatedAt: stamp,
  };
  const foreignTxn = {
    id: "t9", profileId: "p2", bucketId: "b1", type: "expense" as const,
    amountMinor: 100, currency: "PHP", date: "2026-10-27", description: "X",
    category: null, origin: "manual" as const, relatedId: null,
    createdAt: stamp, updatedAt: stamp,
  };
  const foreignSale = {
    id: "s9", profileId: "p2", totalMinor: 100, currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
    items: [{ productId: "pr1", name: "Rice", sku: "RICE", unitPriceMinor: 100, quantity: 1, lineTotalMinor: 100 }],
  };
  const empty = { transactions: [], employees: [], sales: [], allTransactions: [], allSales: [] };
  assert.deepEqual(
    findUnsafeBusinessReferences("p1", { ...empty, buckets: [bucket], products: [product] }),
    [],
  );
  assert.ok(
    findUnsafeBusinessReferences("p1", {
      ...empty, buckets: [bucket], products: [],
      allTransactions: [foreignTxn],
    }).length > 0,
  );
  assert.ok(
    findUnsafeBusinessReferences("p1", {
      ...empty, buckets: [], products: [product], allSales: [foreignSale],
    }).length > 0,
  );
  assert.ok(
    findUnsafeBusinessReferences("p1", {
      ...empty, buckets: [{ ...bucket, profileId: "p2" }], products: [],
    }).length > 0,
  );
});

test("transactions reject floating point and non-positive amounts", () => {
  const base = {
    id: "t1", profileId: "p1", bucketId: null, type: "expense" as const,
    currency: "PHP", date: "2026-10-27", description: "Rice",
    category: null, origin: "manual" as const, relatedId: null,
    createdAt: stamp, updatedAt: stamp,
  };
  assert.equal(validateTransaction({ ...base, amountMinor: 25000 }).amountMinor, 25000);
  assert.throws(() => validateTransaction({ ...base, amountMinor: 250.5 }), BucketaDataError);
  assert.throws(() => validateTransaction({ ...base, amountMinor: 0 }), BucketaDataError);
  assert.throws(() => validateTransaction({ ...base, amountMinor: -100 }), BucketaDataError);
});

test("amount entry parses exactly to integer minor units per currency", () => {
  assert.equal(parseAmountToMinorUnits("1200.50", "PHP"), 120050);
  assert.equal(parseAmountToMinorUnits("1200", "PHP"), 120000);
  assert.equal(parseAmountToMinorUnits("0.05", "PHP"), 5);
  assert.equal(parseAmountToMinorUnits("500", "JPY"), 500);
  assert.equal(parseAmountToMinorUnits(" 250.5 ", "USD"), 25050);
  assert.throws(() => parseAmountToMinorUnits("1.005", "PHP"));
  assert.throws(() => parseAmountToMinorUnits("10.5", "JPY"));
  assert.throws(() => parseAmountToMinorUnits("-5", "PHP"));
  assert.throws(() => parseAmountToMinorUnits("", "PHP"));
  assert.throws(() => parseAmountToMinorUnits("abc", "PHP"));
  assert.throws(() => parseAmountToMinorUnits("99999999999999999", "PHP"));
  assert.equal(minorUnitsToAmountInput(120050, "PHP"), "1200.50");
  assert.equal(minorUnitsToAmountInput(5, "PHP"), "0.05");
  assert.equal(minorUnitsToAmountInput(500, "JPY"), "500");
  assert.equal(
    parseAmountToMinorUnits(minorUnitsToAmountInput(987654, "PHP"), "PHP"),
    987654,
  );
  assert.match(formatMoney(120050, "PHP", "en-PH"), /1,200\.50/);
});

test("dashboard aggregation keeps currencies separate and groups real records", () => {
  const txn = (id: string, type: "income" | "expense" | "transfer", amountMinor: number, currency: string, date: string, category: string | null) => ({
    id, profileId: "p1", bucketId: null, type, amountMinor, currency, date,
    description: id, category, origin: "manual" as const, relatedId: null,
    createdAt: stamp, updatedAt: stamp,
  });
  const txns = [
    txn("a", "income", 100000, "PHP", "2026-09-05", "Salary"),
    txn("b", "expense", 30000, "PHP", "2026-09-07", "Food"),
    txn("c", "expense", 10000, "PHP", "2026-10-01", "Food"),
    txn("d", "income", 5000, "USD", "2026-10-02", null),
    txn("e", "transfer", 999999, "PHP", "2026-10-03", null),
  ];
  assert.deepEqual(summarizeTransactions(txns), [
    { currency: "PHP", income: 100000, expense: 40000, net: 60000 },
    { currency: "USD", income: 5000, expense: 0, net: 5000 },
  ]);
  assert.deepEqual(monthlyIncomeExpense(txns, "PHP"), [
    { month: "2026-09", income: 100000, expense: 30000 },
    { month: "2026-10", income: 0, expense: 10000 },
  ]);
  assert.deepEqual(expenseByCategory(txns, "PHP"), [{ category: "Food", total: 40000 }]);
  assert.deepEqual(
    filterByDateRange(txns, "2026-10-01", "2026-10-02").map((t) => t.id),
    ["c", "d"],
  );
});

test("products require integer money and non-negative integer stock", () => {
  const base = {
    id: "pr1", profileId: "p1", name: "Rice 1kg", sku: "RICE-1",
    priceMinor: 6000, costMinor: 4500, currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
  };
  assert.equal(validateProduct({ ...base, stock: 12 }).stock, 12);
  assert.throws(() => validateProduct({ ...base, stock: 1.5 }), BucketaDataError);
  assert.throws(() => validateProduct({ ...base, stock: -1 }), BucketaDataError);
  assert.throws(() => validateProduct({ ...base, priceMinor: 60.5, stock: 1 }), BucketaDataError);
});

test("sale totals are computed in integers and mismatches are rejected", () => {
  const items = [
    { productId: "pr1", name: "Rice 1kg", sku: "RICE-1", unitPriceMinor: 6000, quantity: 2, lineTotalMinor: 12000 },
    { productId: "pr2", name: "Egg", sku: null, unitPriceMinor: 900, quantity: 3, lineTotalMinor: 2700 },
  ];
  assert.equal(computeSaleTotal(items), 14700);
  const sale = validateSale({
    id: "s1", profileId: "p1", items, totalMinor: 14700, currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
  });
  assert.equal(sale.totalMinor, 14700);
  assert.throws(
    () => validateSale({
      id: "s2", profileId: "p1", items, totalMinor: 99999, currency: "PHP",
      createdAt: stamp, updatedAt: stamp,
    }),
    BucketaDataError,
  );
});

test("database init fails safely when IndexedDB is unavailable (Node)", async () => {
  assert.equal(await initDb(), false);
});
