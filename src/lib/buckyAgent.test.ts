import assert from "node:assert/strict";
import test from "node:test";
import type { Bucket, Product, Profile, Sale, Transaction } from "../data/types.ts";
import {
  analyzeBuckyFinances,
  answerBuckyQuestion,
  buildBuckyModelSummary,
} from "./buckyAgent.ts";

const stamp = "2026-10-15T12:00:00.000Z";
const NOW = new Date("2026-10-15T12:00:00.000Z");

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    kind: "personal",
    name: "Alex Personal",
    currency: "PHP",
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

let seq = 0;
function txn(over: Partial<Transaction> = {}): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    profileId: "p1",
    bucketId: null,
    type: "expense",
    amountMinor: 10000,
    currency: "PHP",
    date: "2026-10-05",
    description: "Groceries",
    category: "Food",
    origin: "manual",
    relatedId: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function bucket(over: Partial<Bucket> = {}): Bucket {
  return {
    id: "b1",
    profileId: "p1",
    name: "Emergency Fund",
    kind: "savings",
    currency: "PHP",
    targetMinor: 100000,
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: `prod-${over.name ?? "item"}`,
    profileId: "p1",
    name: "Item",
    sku: null,
    category: null,
    priceMinor: 5000,
    costMinor: null,
    currency: "PHP",
    stock: 10,
    status: "active",
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: "s1",
    profileId: "p1",
    items: [
      { productId: "prod-Item", name: "Item", sku: null, unitPriceMinor: 15000, quantity: 2, lineTotalMinor: 30000 },
    ],
    totalMinor: 30000,
    currency: "PHP",
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

function analyze(over: Partial<Parameters<typeof analyzeBuckyFinances>[0]> = {}) {
  return analyzeBuckyFinances({
    profile: profile(),
    buckets: [],
    transactions: [],
    products: [],
    sales: [],
    now: NOW,
    ...over,
  });
}

test("empty records: honest empty state, profile currency, scan proposal, insufficient answer", () => {
  const a = analyze();
  assert.equal(a.hasAnyData, false);
  assert.deepEqual(a.currencies.map((c) => c.currency), ["PHP"]);
  assert.equal(a.currencies[0].incomeMinor, 0);
  assert.ok(a.insights.some((i) => i.id === "empty"));
  assert.ok(a.proposals.some((p) => p.action.type === "scan"));
  assert.ok(a.limitations.some((l) => l.includes("No financial records")));
  const ans = answerBuckyQuestion("How am I doing?", a);
  assert.equal(ans.insufficientData, true);
});

test("cash flow is per currency and currencies are never combined", () => {
  const a = analyze({
    transactions: [
      txn({ type: "income", amountMinor: 100000, currency: "PHP", description: "Salary" }),
      txn({ type: "expense", amountMinor: 25000, currency: "PHP" }),
      txn({ type: "expense", amountMinor: 5000, currency: "USD", description: "Hosting" }),
    ],
  });
  assert.deepEqual(a.currencies.map((c) => c.currency), ["PHP", "USD"]);
  const php = a.currencies.find((c) => c.currency === "PHP")!;
  const usd = a.currencies.find((c) => c.currency === "USD")!;
  assert.equal(php.incomeMinor, 100000);
  assert.equal(php.expenseMinor, 25000);
  assert.equal(php.netCashFlowMinor, 75000);
  assert.equal(usd.incomeMinor, 0);
  assert.equal(usd.expenseMinor, 5000);
  assert.equal(usd.netCashFlowMinor, -5000);
  // No insight ever mixes the two currencies into one total.
  for (const i of a.insights.filter((x) => x.kind === "cash-flow")) {
    assert.ok(i.currency === "PHP" || i.currency === "USD");
  }
  assert.ok(a.limitations.some((l) => l.includes("not profit")));
});

test("zero-decimal currency evidence uses the currency's own minor units (JPY)", () => {
  const a = analyze({
    profile: profile({ currency: "JPY" }),
    transactions: [
      txn({ type: "expense", amountMinor: 500, currency: "JPY", description: "Train fare" }),
    ],
  });
  const cash = a.insights.find((i) => i.kind === "cash-flow")!;
  const expenses = cash.evidence.find((e) => e.label === "Expenses")!;
  // 500 minor units in JPY is ¥500, not ¥5.00 from a hardcoded /100.
  assert.ok(expenses.value.includes("500"), expenses.value);
  assert.ok(!expenses.value.includes("5.00"), expenses.value);
});

test("POS revenue is reported separately and never double-counted as transaction income", () => {
  const business = profile({ id: "biz1", kind: "business", name: "Sari Store", currency: "PHP" });
  const a = analyze({
    profile: business,
    transactions: [
      txn({ profileId: "biz1", type: "income", amountMinor: 100000, description: "Capital" }),
      // A sale-type transaction record must also not be folded into income.
      txn({ profileId: "biz1", type: "sale", amountMinor: 77700, description: "POS mirror" }),
    ],
    sales: [sale({ profileId: "biz1" })],
  });
  const php = a.currencies.find((c) => c.currency === "PHP")!;
  assert.equal(php.incomeMinor, 100000);
  assert.equal(php.posRevenueMinor, 30000);
  assert.equal(php.posSaleCount, 1);
  assert.ok(a.insights.some((i) => i.kind === "pos"));
  assert.ok(a.limitations.some((l) => l.includes("True product profit cannot be calculated")));
  const ans = answerBuckyQuestion("How much POS revenue did I make?", a);
  assert.equal(ans.insufficientData, false);
  assert.ok(ans.facts.some((f) => f.label === "POS revenue"));
});

test("personal and business records remain isolated even when callers pass mixed data", () => {
  const business = profile({ id: "biz1", kind: "business", name: "Other Business" });
  const a = analyze({
    transactions: [
      txn({ profileId: "p1", type: "income", amountMinor: 100000, description: "Mine" }),
      txn({ profileId: "biz1", type: "income", amountMinor: 999000, description: "Theirs" }),
    ],
    buckets: [bucket({ profileId: "biz1" })],
    products: [product({ profileId: "biz1", stock: 0 })],
    sales: [sale({ profileId: "biz1", totalMinor: 888000 })],
  });
  assert.equal(business.id, "biz1"); // fixture sanity
  const php = a.currencies.find((c) => c.currency === "PHP")!;
  assert.equal(php.incomeMinor, 100000);
  assert.equal(php.posRevenueMinor, 0);
  assert.equal(a.lowStock.length, 0);
  assert.ok(!a.insights.some((i) => i.kind === "savings"));
});

test("duplicate-looking transactions are grouped and flagged, never removed or merged", () => {
  const txns = [
    txn({ description: "Milk", amountMinor: 7500, date: "2026-10-03" }),
    txn({ description: "  milk ", amountMinor: 7500, date: "2026-10-03" }),
    txn({ description: "Milk", amountMinor: 8000, date: "2026-10-03" }),
    txn({ description: "Milk", amountMinor: 7500, date: "2026-10-04" }),
  ];
  const a = analyze({ transactions: txns });
  assert.equal(a.duplicateGroups.length, 1);
  assert.equal(a.duplicateGroups[0].count, 2);
  assert.ok(a.insights.some((i) => i.kind === "duplicates" && i.severity === "attention"));
  const ans = answerBuckyQuestion("Do I have any duplicates?", a);
  assert.equal(ans.insufficientData, false);
  assert.ok(ans.facts.length > 0);
});

test("savings movements and transfers are not treated as duplicate income/expenses", () => {
  const a = analyze({
    transactions: [
      txn({ type: "savings-deposit", description: "Save", amountMinor: 5000, date: "2026-10-03" }),
      txn({ type: "savings-deposit", description: "Save", amountMinor: 5000, date: "2026-10-03" }),
      txn({ type: "transfer", description: "Move", amountMinor: 5000, date: "2026-10-03" }),
      txn({ type: "transfer", description: "Move", amountMinor: 5000, date: "2026-10-03" }),
    ],
  });
  assert.equal(a.duplicateGroups.length, 0);
  const ans = answerBuckyQuestion("Any duplicates?", a);
  assert.equal(ans.insufficientData, false);
  assert.match(ans.answer, /no possible duplicate groups/i);
});

test("savings progress uses only the bucket's own currency and profile", () => {
  const a = analyze({
    buckets: [bucket(), bucket({ id: "b2", name: "No Goal", targetMinor: null })],
    transactions: [
      txn({ bucketId: "b1", type: "income", amountMinor: 40000 }),
      txn({ bucketId: "b1", type: "savings-deposit", amountMinor: 10000 }),
      txn({ bucketId: "b1", type: "income", amountMinor: 99900, currency: "USD" }),
    ],
  });
  const savings = a.insights.filter((i) => i.kind === "savings");
  assert.equal(savings.length, 1);
  assert.match(savings[0].title, /50% of goal/);
  const saved = savings[0].evidence.find((e) => e.label === "Saved")!;
  assert.ok(saved.value.includes("500"), saved.value);
  const ans = answerBuckyQuestion("How is my savings goal?", a);
  assert.equal(ans.insufficientData, false);
});

test("expense increase of 25% or more this month (UTC) raises a month-change insight", () => {
  const a = analyze(
    {
      transactions: [
        txn({ amountMinor: 10000, date: "2026-09-10", description: "Last month" }),
        txn({ amountMinor: 15000, date: "2026-10-10", description: "This month" }),
      ],
    },
  );
  const php = a.currencies[0];
  assert.equal(php.previousMonthExpenseMinor, 10000);
  assert.equal(php.currentMonthExpenseMinor, 15000);
  assert.equal(php.monthExpenseChangePct, 50);
  assert.ok(a.insights.some((i) => i.kind === "month-change"));
  const ans = answerBuckyQuestion("Why are my expenses increasing?", a);
  assert.equal(ans.insufficientData, false);
  assert.ok(ans.facts.some((f) => f.label === "This month expenses"));
});

test("small expense changes and first-month data do not claim an increase", () => {
  const small = analyze({
    transactions: [
      txn({ amountMinor: 10000, date: "2026-09-10" }),
      txn({ amountMinor: 11000, date: "2026-10-10" }),
    ],
  });
  assert.ok(!small.insights.some((i) => i.kind === "month-change"));
  const firstMonth = analyze({
    transactions: [txn({ amountMinor: 11000, date: "2026-10-10" })],
  });
  assert.equal(firstMonth.currencies[0].monthExpenseChangePct, null);
});

test("month handling is timezone-stable at a UTC month boundary", () => {
  const a = analyzeBuckyFinances({
    profile: profile(),
    buckets: [],
    products: [],
    sales: [],
    now: new Date("2026-11-01T00:30:00.000Z"),
    transactions: [
      txn({ amountMinor: 10000, date: "2026-10-15", description: "October" }),
      txn({ amountMinor: 20000, date: "2026-11-01", description: "November" }),
    ],
  });
  const php = a.currencies[0];
  assert.equal(php.currentMonthExpenseMinor, 20000);
  assert.equal(php.previousMonthExpenseMinor, 10000);
  assert.equal(php.monthExpenseChangePct, 100);
});

test("low inventory flags active products at 3 or fewer, worst first, excluding archived", () => {
  const a = analyze({
    products: [
      product({ name: "Rice", stock: 2 }),
      product({ name: "Soap", stock: 0 }),
      product({ name: "Archived", stock: 0, status: "archived" }),
      product({ name: "Plenty", stock: 25 }),
    ],
  });
  assert.deepEqual(a.lowStock.map((p) => p.name), ["Soap", "Rice"]);
  const insight = a.insights.find((i) => i.kind === "inventory")!;
  assert.equal(insight.severity, "attention");
  const ans = answerBuckyQuestion("What is low on stock?", a);
  assert.equal(ans.insufficientData, false);
});

test("uncategorised expenses and question fallbacks are honest about insufficient data", () => {
  const a = analyze({
    transactions: [
      txn({ category: null, description: "A" }),
      txn({ category: "  ", description: "B" }),
      txn({ category: null, description: "C" }),
    ],
  });
  assert.ok(a.insights.some((i) => i.kind === "data-quality" && /no category/.test(i.title)));
  assert.equal(answerBuckyQuestion("How much POS revenue?", a).insufficientData, true);
  assert.equal(answerBuckyQuestion("How is my bucket goal?", a).insufficientData, true);
  const fallback = answerBuckyQuestion("Tell me something else entirely", a);
  assert.equal(fallback.insufficientData, false);
  assert.match(fallback.answer, /expenses, cash flow/);
});

test("analysis never mutates inputs and proposals only navigate or open the scanner", () => {
  const txns = [txn({ type: "income", amountMinor: 100000, description: "Salary" })];
  const before = JSON.stringify(txns);
  const a = analyze({ transactions: txns });
  assert.equal(JSON.stringify(txns), before);
  assert.ok(a.proposals.length > 0);
  for (const p of a.proposals) {
    assert.ok(p.action.type === "navigate" || p.action.type === "scan");
  }
});

test("model summary contains aggregated totals only, never raw record descriptions", () => {
  const a = analyze({
    transactions: [
      txn({ type: "income", amountMinor: 100000, description: "Secret salary description", category: "Job" }),
    ],
  });
  const summary = buildBuckyModelSummary(a);
  assert.equal(summary.currencies[0].incomeMinor, 100000);
  assert.ok(!JSON.stringify(summary).includes("Secret salary description"));
  assert.equal(summary.duplicateGroupCount, 0);
});
