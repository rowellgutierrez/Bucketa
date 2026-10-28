import assert from "node:assert/strict";
import test from "node:test";
import {
  BucketaDataError,
  computeSaleTotal,
  findSkuConflict,
  findUnsafeBusinessReferences,
  validateBucket,
  validateProduct,
  validateProfile,
  validateSale,
  validateTransaction,
} from "./validation.ts";
import { bucketsRepo, initDb } from "./db.ts";
import {
  currencySymbol,
  formatMoney,
  minorUnitsToAmountInput,
  parseAmountToMinorUnits,
} from "../lib/currency.ts";
import {
  bucketGoalProgress,
  bucketSavedMinor,
  expenseByCategory,
  filterByDateRange,
  monthlyIncomeExpense,
  savingsMovementError,
  summarizeTransactions,
} from "../lib/finance.ts";
import {
  addToCart,
  buildSale,
  buildSaleItems,
  cartTotalMinor,
  changeDueMinor,
  removeFromCart,
  setCartQuantity,
} from "../lib/pos.ts";
import {
  amountOf,
  amountsForEdit,
  bucketCurrencyMismatch,
  canChangeBucketCurrency,
  emptyRecordAmounts,
  isValidCalendarDate,
  planSaveAmounts,
  plannedEntryTypes,
  reinterpretAmountMinor,
  withAmount,
} from "../lib/recordForm.ts";

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

test("bucket goals are optional positive integers, and progress uses only its own currency", () => {
  const base = {
    id: "b4", profileId: "p1", name: "Emergency fund", kind: "savings" as const,
    currency: "PHP", createdAt: stamp, updatedAt: stamp,
  };
  assert.equal(validateBucket(base).targetMinor, undefined);
  assert.equal(validateBucket({ ...base, targetMinor: null }).targetMinor, null);
  assert.equal(validateBucket({ ...base, targetMinor: 10000000 }).targetMinor, 10000000);
  assert.throws(() => validateBucket({ ...base, targetMinor: 0 }), BucketaDataError);
  assert.throws(() => validateBucket({ ...base, targetMinor: -5 }), BucketaDataError);
  assert.throws(() => validateBucket({ ...base, targetMinor: 10.5 }), BucketaDataError);

  const txn = (id: string, type: "income" | "expense", amountMinor: number, currency = "PHP") => ({
    id, profileId: "p1", bucketId: "b4", type, amountMinor, currency,
    date: "2026-10-27", description: id, category: null,
    origin: "manual" as const, relatedId: null, createdAt: stamp, updatedAt: stamp,
  });
  const progress = bucketGoalProgress(
    [txn("t1", "income", 1500000), txn("t2", "expense", 500000), txn("t3", "income", 999999, "USD")],
    { ...base, targetMinor: 10000000 },
  );
  // ₱10,000.00 of ₱100,000.00 = 10%; the USD record is never mixed in.
  assert.equal(progress?.savedMinor, 1000000);
  assert.equal(progress?.percent, 10);
  assert.equal(bucketGoalProgress([], base), null);
});

test("savings deposits accumulate, withdrawals reduce, and overdrafts are blocked", () => {
  const bucket = { id: "b-iphone", currency: "PHP", targetMinor: 5000000 }; // ₱50,000 goal
  const txn = (
    id: string,
    type: "savings-deposit" | "savings-withdrawal" | "income" | "expense",
    amountMinor: number,
    currency = "PHP",
    bucketId: string | null = "b-iphone",
  ) => ({
    id, profileId: "p1", bucketId, type, amountMinor, currency,
    date: "2026-10-27", description: id, category: null,
    origin: "manual" as const, relatedId: null, createdAt: stamp, updatedAt: stamp,
  });

  // Repeated ₱10,000 deposits accumulate instead of overwriting.
  const deposits = [txn("d1", "savings-deposit", 1000000), txn("d2", "savings-deposit", 1000000)];
  assert.equal(bucketSavedMinor(deposits, bucket), 2000000);
  assert.deepEqual(bucketGoalProgress(deposits, bucket), { savedMinor: 2000000, percent: 40 });
  assert.equal(validateTransaction(deposits[0]).type, "savings-deposit");

  // A ₱5,000 withdrawal reduces the saved amount and the goal percentage.
  const afterWithdrawal = [...deposits, txn("w1", "savings-withdrawal", 500000)];
  assert.equal(bucketSavedMinor(afterWithdrawal, bucket), 1500000);
  assert.equal(bucketGoalProgress(afterWithdrawal, bucket)?.percent, 30);

  // Withdrawing exactly the saved amount is allowed; one centavo more is not.
  assert.equal(savingsMovementError(afterWithdrawal, bucket, "savings-withdrawal", 1500000), null);
  assert.match(
    savingsMovementError(afterWithdrawal, bucket, "savings-withdrawal", 1500001) ?? "",
    /exceeds/,
  );
  assert.match(savingsMovementError(afterWithdrawal, bucket, "savings-deposit", 0) ?? "", /greater than zero/);

  // Currency separation: a USD deposit never fills a PHP goal, and vice versa.
  const mixed = [...afterWithdrawal, txn("d-usd", "savings-deposit", 1000000, "USD")];
  assert.equal(bucketSavedMinor(mixed, bucket), 1500000);
  assert.equal(bucketSavedMinor(mixed, { id: "b-iphone", currency: "USD" }), 1000000);

  // Savings movements are not income, expenses, or net cash flow. Only the
  // ordinary salary income and grocery expense below may be summarised.
  const summaries = summarizeTransactions([
    ...mixed,
    txn("salary", "income", 8000000, "PHP", null),
    txn("groceries", "expense", 200000, "PHP", null),
  ]);
  assert.deepEqual(summaries, [
    { currency: "PHP", income: 8000000, expense: 200000, net: 7800000 },
  ]);

  // Legacy behaviour preserved: assigned income still counts toward a goal.
  const legacy = [txn("old", "income", 1000000)];
  assert.equal(bucketSavedMinor(legacy, bucket), 1000000);
});

test("record form keeps income and expense amounts independent", () => {
  // Editing an income record fills only the income field.
  let amounts = amountsForEdit("income", "5000.00");
  assert.equal(amountOf(amounts, "income"), "5000.00");
  assert.equal(amountOf(amounts, "expense"), "");

  // Typing on the expense side never changes the income value, and back.
  amounts = withAmount(amounts, "expense", "500.00");
  assert.equal(amountOf(amounts, "income"), "5000.00");
  assert.equal(amountOf(amounts, "expense"), "500.00");
  amounts = withAmount(amounts, "income", "6000.00");
  assert.equal(amountOf(amounts, "expense"), "500.00");

  // A fresh form starts with both sides blank.
  assert.deepEqual(emptyRecordAmounts(), { income: "", expense: "" });
  // Editing an expense record fills only the expense field.
  const expenseEdit = amountsForEdit("expense", "250.50");
  assert.equal(amountOf(expenseEdit, "expense"), "250.50");
  assert.equal(amountOf(expenseEdit, "income"), "");
});

test("record form rejects bucket/currency mismatches instead of changing currency", () => {
  assert.equal(bucketCurrencyMismatch("PHP", "PHP"), null);
  const mismatch = bucketCurrencyMismatch("USD", "PHP");
  assert.ok(mismatch?.includes("USD"));
  assert.ok(mismatch?.includes("PHP"));
});

test("dual-entry save creates income only, expense only, or both together", () => {
  const incomeOnly = planSaveAmounts({ income: "10000", expense: "" }, "PHP");
  assert.deepEqual(incomeOnly, {
    ok: true,
    entries: [{ type: "income", amountMinor: 1000000 }],
  });

  const expenseOnly = planSaveAmounts({ income: "", expense: "7000" }, "PHP");
  assert.deepEqual(expenseOnly, {
    ok: true,
    entries: [{ type: "expense", amountMinor: 700000 }],
  });

  // The reported scenario: PHP 10,000 income + PHP 7,000 expense, one Save.
  const both = planSaveAmounts({ income: "10000", expense: "7000" }, "PHP");
  assert.deepEqual(both, {
    ok: true,
    entries: [
      { type: "income", amountMinor: 1000000 },
      { type: "expense", amountMinor: 700000 },
    ],
  });
  if (both.ok) {
    const net = both.entries.reduce(
      (sum, e) => sum + (e.type === "income" ? e.amountMinor : -e.amountMinor),
      0,
    );
    assert.equal(net, 300000); // net cash flow PHP 3,000.00
  }
  assert.deepEqual(plannedEntryTypes({ income: "1", expense: "2" }), [
    "income",
    "expense",
  ]);
});

test("dual-entry save validates both sides and stays single in edit mode", () => {
  // An invalid second entry blocks the whole save; nothing is planned.
  const invalid = planSaveAmounts({ income: "10000", expense: "abc" }, "PHP");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.message, /Expense amount/);

  const zero = planSaveAmounts({ income: "0", expense: "" }, "PHP");
  assert.equal(zero.ok, false);

  const neither = planSaveAmounts({ income: "", expense: "  " }, "PHP");
  assert.equal(neither.ok, false);

  // Edit mode populates only the edited record's side, so its planned save
  // remains a single-record operation.
  const editAmounts = amountsForEdit("expense", "7000");
  assert.deepEqual(plannedEntryTypes(editAmounts), ["expense"]);
  assert.deepEqual(planSaveAmounts(editAmounts, "PHP"), {
    ok: true,
    entries: [{ type: "expense", amountMinor: 700000 }],
  });
});

test("bucket currency can be corrected only with no assigned records", () => {
  assert.equal(canChangeBucketCurrency(0), true);
  assert.equal(canChangeBucketCurrency(1), false);
  assert.equal(canChangeBucketCurrency(5), false);
  // The mismatch message tells the user the safe unassign-correct-reassign path.
  assert.ok(bucketCurrencyMismatch("PHP", "USD")?.includes("None"));
});

test("correcting a currency preserves the amount number with no conversion", () => {
  // $500.00 (50000 minor, 2 digits) corrected to PHP stays ₱500.00.
  assert.equal(reinterpretAmountMinor(50000, "USD", "PHP"), 50000);
  // $500.00 corrected to JPY (0 digits) becomes ¥500, not ¥50,000.
  assert.equal(reinterpretAmountMinor(50000, "USD", "JPY"), 500);
  // ¥500 corrected back to USD becomes $500.00.
  assert.equal(reinterpretAmountMinor(500, "JPY", "USD"), 50000);
  // Same currency is untouched.
  assert.equal(reinterpretAmountMinor(12345, "PHP", "PHP"), 12345);
});

test("record form rejects non-existent calendar dates", () => {
  assert.equal(isValidCalendarDate("2026-02-28"), true);
  assert.equal(isValidCalendarDate("2024-02-29"), true); // leap year
  assert.equal(isValidCalendarDate("2026-02-29"), false);
  assert.equal(isValidCalendarDate("2026-02-31"), false);
  assert.equal(isValidCalendarDate("2026-04-31"), false);
  assert.equal(isValidCalendarDate("2026-13-01"), false);
  assert.equal(isValidCalendarDate("27/10/2026"), false);
  assert.equal(isValidCalendarDate(""), false);
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
    category: null, priceMinor: 6000, costMinor: 4500, currency: "PHP",
    createdAt: stamp, updatedAt: stamp,
  };
  assert.equal(validateProduct({ ...base, stock: 12 }).stock, 12);
  assert.throws(() => validateProduct({ ...base, stock: 1.5 }), BucketaDataError);
  assert.throws(() => validateProduct({ ...base, stock: -1 }), BucketaDataError);
  assert.throws(() => validateProduct({ ...base, priceMinor: 60.5, stock: 1 }), BucketaDataError);
});

test("products allow optional SKU, category, and cost, and archive safely", () => {
  const base = {
    id: "pr1", profileId: "p1", name: "Rice 1kg", sku: "RICE-1",
    category: null, priceMinor: 6000, costMinor: 4500, currency: "PHP",
    stock: 3, createdAt: stamp, updatedAt: stamp,
  };
  // No SKU, no category, and no tracked cost are all valid.
  const bare = validateProduct({ ...base, sku: null, category: null, costMinor: null });
  assert.equal(bare.sku, null);
  assert.equal(bare.costMinor, null);
  assert.equal(validateProduct({ ...base, category: "Drinks" }).category, "Drinks");
  assert.equal(validateProduct({ ...base, status: "archived" }).status, "archived");
  assert.throws(() => validateProduct({ ...base, status: "deleted" as never }), BucketaDataError);
  assert.throws(() => validateProduct({ ...base, costMinor: 10.5 }), BucketaDataError);

  // SKU conflicts are per business and case-insensitive; blank SKUs
  // never conflict, so many products may have no SKU at all.
  const products = [
    { ...base, id: "a", sku: "RICE-1" },
    { ...base, id: "b", sku: null },
    { ...base, id: "c", profileId: "p2", sku: "RICE-1" },
  ];
  assert.equal(findSkuConflict(products, "p1", " rice-1 ")?.id, "a");
  assert.equal(findSkuConflict(products, "p1", "RICE-1", "a"), null);
  assert.equal(findSkuConflict(products, "p2", "RICE-1")?.id, "c");
  assert.equal(findSkuConflict(products, "p1", null), null);
  assert.equal(findSkuConflict(products, "p1", "  "), null);
  assert.equal(findSkuConflict(products, "p1", "NEW-1"), null);
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

test("POS cart caps at stock, snapshots prices, and computes cash change in minor units", () => {
  const rice = {
    id: "pr1", profileId: "p1", name: "Rice 1kg", sku: "RICE-1", category: null,
    priceMinor: 6000, costMinor: null, currency: "PHP", stock: 2,
    status: "active" as const, createdAt: stamp, updatedAt: stamp,
  };
  const egg = { ...rice, id: "pr2", name: "Egg", sku: null, priceMinor: 900, stock: 10 };

  // Tapping adds up to available stock and never beyond it.
  let cart = addToCart([], rice);
  cart = addToCart(cart, rice);
  cart = addToCart(cart, rice);
  assert.deepEqual(cart, [{ productId: "pr1", quantity: 2 }]);
  cart = setCartQuantity(cart, rice, 99);
  assert.equal(cart[0].quantity, 2);
  cart = addToCart(cart, egg);
  assert.equal(cart.length, 2);
  cart = removeFromCart(cart, "pr2");
  assert.deepEqual(cart, [{ productId: "pr1", quantity: 2 }]);

  // Snapshots keep the price and name from sale time, even if the
  // product is later edited.
  const items = buildSaleItems(cart, [rice, egg]);
  const edited = { ...rice, name: "Rice 5kg", priceMinor: 99999 };
  assert.equal(items[0].name, "Rice 1kg");
  assert.equal(items[0].unitPriceMinor, 6000);
  assert.notEqual(items[0].unitPriceMinor, edited.priceMinor);
  assert.equal(cartTotalMinor(items), 12000);

  // Cash change is exact integer minor units; underpayment is rejected.
  assert.equal(changeDueMinor(12000, 20000), 8000);
  assert.equal(changeDueMinor(12000, 12000), 0);
  assert.equal(changeDueMinor(12000, 11999), null);

  const sale = buildSale({
    id: "sale-abcdef123456", profileId: "p1", currency: "PHP",
    items, amountReceivedMinor: 20000, createdAt: stamp,
  });
  assert.equal(sale.totalMinor, 12000);
  assert.equal(sale.changeMinor, 8000);
  assert.equal(sale.receiptNumber, "20261027-SALEABCD");
  assert.equal(
    validateSale({ ...sale, updatedAt: stamp }).receiptNumber,
    "20261027-SALEABCD",
  );
  assert.throws(
    () => validateSale({ ...sale, amountReceivedMinor: 11000, changeMinor: 0, updatedAt: stamp }),
    BucketaDataError,
  );
  assert.throws(
    () => validateSale({ ...sale, changeMinor: 7000, updatedAt: stamp }),
    BucketaDataError,
  );

  // The same product may never appear on two lines of one sale, even
  // when each line is internally consistent: combined lines could pass
  // a per-line stock check while overselling in total. A valid sale
  // with distinct products remains accepted (covered above and here).
  const duplicateItems = [
    { productId: "pr1", name: "Rice 1kg", sku: "RICE-1", unitPriceMinor: 6000, quantity: 1, lineTotalMinor: 6000 },
    { productId: "pr1", name: "Rice 1kg", sku: "RICE-1", unitPriceMinor: 6000, quantity: 1, lineTotalMinor: 6000 },
  ];
  assert.throws(
    () =>
      validateSale({
        id: "s-dup", profileId: "p1", items: duplicateItems, totalMinor: 12000,
        currency: "PHP", createdAt: stamp, updatedAt: stamp,
      }),
    BucketaDataError,
  );
  const distinctItems = [
    duplicateItems[0],
    { productId: "pr2", name: "Egg", sku: null, unitPriceMinor: 900, quantity: 2, lineTotalMinor: 1800 },
  ];
  assert.equal(
    validateSale({
      id: "s-ok", profileId: "p1", items: distinctItems, totalMinor: 7800,
      currency: "PHP", createdAt: stamp, updatedAt: stamp,
    }).items.length,
    2,
  );
});

test("currencySymbol maps bucket currencies to coin symbols without locale inference", () => {
  // The currencies named for Bucky's coins.
  assert.equal(currencySymbol("PHP"), "₱");
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("JPY"), "¥");
  assert.equal(currencySymbol("EUR"), "€");
  assert.equal(currencySymbol("GBP"), "£");
  assert.equal(currencySymbol("KRW"), "₩");
  assert.equal(currencySymbol("INR"), "₹");

  // Codes are normalised; the result never depends on device locale.
  assert.equal(currencySymbol(" php "), "₱");
  assert.equal(currencySymbol("thb"), "฿");

  // Other valid currencies get a distinct symbol or a readable ISO code,
  // never a bare ambiguous sign borrowed from another currency.
  const other = currencySymbol("AUD");
  assert.ok(other === "A$" || other === "AUD", `unexpected AUD symbol: ${other}`);
  assert.notEqual(currencySymbol("CAD"), "$");

  // Malformed or empty codes yield no symbol, so Bucky shows its
  // neutral coin emblem instead of a wrong currency mark.
  assert.equal(currencySymbol(""), "");
  assert.equal(currencySymbol("   "), "");
  assert.equal(currencySymbol("P1"), "");
  assert.equal(currencySymbol("PHPX"), "");
  assert.equal(currencySymbol("12"), "");
});

test("database init fails safely when IndexedDB is unavailable (Node)", async () => {
  assert.equal(await initDb(), false);
});
