import assert from "node:assert/strict";
import test from "node:test";
import type { Bucket, Employee, Product, Profile, Transaction } from "../data/types.ts";
import { validateProduct } from "../data/validation.ts";
import {
  buildActionFromModelProposal,
  buildBuckyProduct,
  buildBuckyTransaction,
  interpretBuckyAction,
  interpretBuckyProductCommand,
  isFinancialAnalysisQuestion,
  type BuckyActionContext,
  type BuckyProductContext,
  type ModelActionProposal,
  type ProposedBuckyAction,
} from "./buckyActions.ts";

const personal: Profile = {
  id: "p1", kind: "personal", name: "My Money", currency: "PHP",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const business: Profile = {
  id: "biz1", kind: "business", name: "Sari Store", currency: "PHP",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const bucket = (id: string, name: string, profileId = "p1"): Bucket => ({
  id, profileId, name, kind: "savings", currency: "PHP", targetMinor: 500000,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
const roger: Employee = {
  id: "e1", profileId: "biz1", name: "Roger", role: "Cashier", status: "active",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

let nextId = 0;
function ctx(overrides: Partial<BuckyActionContext> = {}): BuckyActionContext {
  return {
    profile: personal,
    buckets: [bucket("b1", "iPhone"), bucket("b2", "Travel")],
    employees: [],
    transactions: [],
    today: "2026-11-01",
    createId: () => `bucky:test-${++nextId}`,
    ...overrides,
  };
}

function proposal(text: string, context: BuckyActionContext): ProposedBuckyAction {
  const result = interpretBuckyAction(text, context);
  assert.equal(result.status, "proposal", JSON.stringify(result));
  return result.status === "proposal" ? result.action : (() => { throw new Error("unreachable"); })();
}

test("read-only financial analysis questions are Q&A, never transaction commands", () => {
  for (const q of [
    "Summarize my recorded income, expenses, and net cash flow in PHP",
    "Analyze my current PHP financial summary",
  ]) {
    assert.equal(isFinancialAnalysisQuestion(q), true, q);
    // Regression: these used to hit buildRecord and ask "How much is the
    // income?" — they must fall through to Bucky Q&A (deterministic or
    // live Meta AI when enabled), with no clarification and no write.
    assert.equal(interpretBuckyAction(q, ctx()).status, "not-action", q);
    assert.equal(interpretBuckyProductCommand(q, productCtx()).status, "not-action", q);
  }
});

test("legitimate transaction commands still produce confirmable proposals", () => {
  assert.equal(isFinancialAnalysisQuestion("Record ₱5,000 income from freelance work"), false);
  assert.equal(isFinancialAnalysisQuestion("Hi Bucky! Record ₱500 for a budget expense?"), false);
  const income = proposal("Record ₱5,000 income from freelance work", ctx());
  assert.equal(income.kind, "income");
  // Plural "expenses" in an explicit command is still an expense command.
  const expenses = proposal("Record ₱500 expenses for groceries", ctx());
  assert.equal(expenses.kind, "expense");
  const spent = proposal("Spent ₱500 on groceries today", ctx());
  assert.equal(spent.kind, "expense");
  const savings = proposal("Add ₱1,000 to my iPhone savings goal", ctx());
  assert.equal(savings.kind, "savings-contribution");
});

test("records income with amount, description, and profile currency", () => {
  const action = proposal("Record ₱5,000 income from freelance work", ctx());
  assert.equal(action.kind, "income");
  assert.equal(action.transactionType, "income");
  assert.equal(action.amountMinor, 500000);
  assert.equal(action.currency, "PHP");
  assert.equal(action.description, "Freelance work");
  assert.equal(action.date, "2026-11-01");
  assert.equal(action.profileId, "p1");
});

test("records an expense and never invents a missing description or amount", () => {
  const action = proposal("Record ₱500 expense for groceries", ctx());
  assert.equal(action.kind, "expense");
  assert.equal(action.amountMinor, 50000);
  assert.equal(action.description, "Groceries");

  assert.equal(interpretBuckyAction("Record expense for groceries", ctx()).status, "clarification");
  assert.equal(interpretBuckyAction("Record ₱500 expense", ctx()).status, "clarification");
  assert.equal(interpretBuckyAction("Record ₱500 for groceries", ctx()).status, "clarification");
});

test("adds a contribution to the explicitly named savings goal only", () => {
  const action = proposal("Add ₱1,000 to my iPhone savings goal", ctx());
  assert.equal(action.kind, "savings-contribution");
  assert.equal(action.transactionType, "savings-deposit");
  assert.equal(action.bucketId, "b1");
  assert.equal(action.bucketName, "iPhone");
  assert.equal(action.amountMinor, 100000);
});

test("clarifies when the savings goal is missing, ambiguous, or absent", () => {
  const ambiguous = interpretBuckyAction("Add ₱100 to my savings goal", ctx());
  assert.equal(ambiguous.status, "clarification");
  assert.equal(interpretBuckyAction("Add ₱100 to my savings goal", ctx({ buckets: [] })).status, "clarification");
  const single = proposal("Add ₱100 to my savings goal", ctx({ buckets: [bucket("b1", "iPhone")] }));
  assert.equal(single.bucketId, "b1");
  assert.ok(single.warnings.some((w) => w.includes("only savings goal")));
});

test("regression: 'Record Roger's…' resolves to Roger, never 'Record Roger'", () => {
  // No employee record exists in this context: the name comes from phrasing.
  const action = proposal(
    "Record Roger's ₱1,000 salary payment for November 1, 2026",
    ctx({ profile: business, buckets: [] }),
  );
  assert.equal(action.employeeName, "Roger");
  assert.equal(action.employeeMatched, false);
  const paid = proposal("Pay Roger's salary ₱1,000 today", ctx({ profile: business, buckets: [] }));
  assert.equal(paid.employeeName, "Roger");
});

test("bonuses and advances are distinct payment types, never guessed", () => {
  const bonus = proposal("Record a ₱500 bonus for Roger today", ctx({ profile: business, employees: [roger], buckets: [] }));
  assert.equal(bonus.paymentType, "bonus");
  assert.equal(bonus.category, "Bonuses");
  assert.equal(bonus.description, "Bonus payment — Roger");
  assert.equal(bonus.employeeId, "e1");
  const txn = buildBuckyTransaction(bonus, "2026-11-01T10:00:00.000Z");
  assert.equal(txn.relatedId, "e1");

  const advance = proposal("Record a ₱300 advance for Roger today", ctx({ profile: business, employees: [roger], buckets: [] }));
  assert.equal(advance.paymentType, "advance");
  assert.equal(advance.category, "Advances");

  // No type word + a known employee: Bucky asks instead of guessing.
  assert.equal(
    interpretBuckyAction("Pay Roger ₱1,000", ctx({ profile: business, employees: [roger], buckets: [] })).status,
    "clarification",
  );
  // A rate change is not a payment.
  const rate = interpretBuckyAction("Set Roger's salary rate to ₱20,000", ctx({ profile: business, employees: [roger], buckets: [] }));
  assert.equal(rate.status, "clarification");
});

test("ambiguous employee names clarify instead of guessing", () => {
  const otherRoger: Employee = { ...roger, id: "e2", role: "Manager" };
  const ambiguous = interpretBuckyAction(
    "Record ₱1,000 salary payment for Roger",
    ctx({ profile: business, employees: [roger, otherRoger], buckets: [] }),
  );
  assert.equal(ambiguous.status, "clarification");
  const byRole = proposal(
    "Record ₱1,000 salary payment for Roger the Manager",
    ctx({ profile: business, employees: [roger, otherRoger], buckets: [] }),
  );
  assert.equal(byRole.employeeId, "e2");
});

test("records a salary payment as a business expense for a matched employee", () => {
  const action = proposal(
    "Record Roger's ₱1,000 salary payment for November 1, 2026",
    ctx({ profile: business, employees: [roger], buckets: [] }),
  );
  assert.equal(action.kind, "salary-payment");
  assert.equal(action.transactionType, "expense");
  assert.equal(action.category, "Salaries");
  assert.equal(action.description, "Salary payment — Roger");
  assert.equal(action.employeeName, "Roger");
  assert.equal(action.employeeMatched, true);
  assert.equal(action.date, "2026-11-01");
  assert.equal(action.amountMinor, 100000);
  assert.ok(action.warnings.some((w) => w.includes("not a payroll run")));
});

test("salary payments require a business profile and a named person", () => {
  assert.equal(
    interpretBuckyAction("Pay Roger ₱1,000 salary", ctx({ employees: [] })).status,
    "clarification",
  );
  assert.equal(
    interpretBuckyAction("Record ₱1,000 salary payment", ctx({ profile: business, buckets: [] })).status,
    "clarification",
  );
  const unmatched = proposal("Pay Maria ₱2,000 salary", ctx({ profile: business, buckets: [] }));
  assert.equal(unmatched.employeeMatched, false);
  assert.ok(unmatched.warnings.some((w) => w.includes("No employee record")));
});

test("questions are analysis, never actions; destructive requests are unsupported", () => {
  assert.equal(interpretBuckyAction("How is my iPhone savings goal doing?", ctx()).status, "not-action");
  assert.equal(
    interpretBuckyAction("How much salary did I pay Roger?", ctx({ profile: business, employees: [roger] })).status,
    "not-action",
  );
  assert.equal(interpretBuckyAction("Delete that duplicate expense", ctx()).status, "unsupported");
  assert.equal(interpretBuckyAction("Withdraw ₱500 from my iPhone goal", ctx()).status, "unsupported");
  assert.equal(interpretBuckyAction("Transfer ₱500 to my bank", ctx()).status, "unsupported");
});

test("currency mismatches are clarified, never converted", () => {
  const result = interpretBuckyAction("Add $100 to my iPhone savings goal", ctx());
  assert.equal(result.status, "clarification");
});

test("a matching existing record produces a duplicate warning on the preview", () => {
  const existing: Transaction = {
    id: "t1", profileId: "p1", bucketId: null, type: "expense", amountMinor: 50000,
    currency: "PHP", date: "2026-11-01", description: "Groceries", category: null,
    origin: "manual", relatedId: null,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  };
  const action = proposal("Record ₱500 expense for groceries", ctx({ transactions: [existing] }));
  assert.ok(action.warnings.some((w) => w.includes("already exists")));
});

test("built transactions carry the stable preview ID for duplicate protection", () => {
  const action = proposal("Record ₱500 expense for groceries", ctx());
  const txn = buildBuckyTransaction(action, "2026-11-01T10:00:00.000Z");
  assert.equal(txn.id, action.id);
  assert.equal(txn.profileId, "p1");
  assert.equal(txn.origin, "manual");
  assert.equal(txn.relatedId, null);
  assert.equal(txn.type, "expense");
});

// --- Phase D: model proposals are cross-checked, never trusted ---

function modelProposal(over: Partial<ModelActionProposal> = {}): ModelActionProposal {
  return {
    kind: "expense",
    amountMinor: 50000,
    date: "2026-11-01",
    description: "Groceries",
    category: null,
    bucketName: null,
    employeeName: null,
    paymentType: null,
    ...over,
  };
}

test("model proposal that matches the user's words becomes a normal preview action", () => {
  const result = buildActionFromModelProposal(
    "Spent ₱500 on groceries today",
    modelProposal(),
    ctx(),
  );
  assert.equal(result.status, "proposal");
  if (result.status === "proposal") {
    assert.equal(result.action.amountMinor, 50000);
    assert.equal(result.action.description, "Groceries");
    assert.equal(result.action.kind, "expense");
    assert.ok(result.action.warnings.some((w) => w.includes("AI assistance")));
  }
});

test("model proposals with invented amounts or dates are rejected", () => {
  const wrongAmount = buildActionFromModelProposal(
    "Spent ₱500 on groceries today",
    modelProposal({ amountMinor: 90000 }),
    ctx(),
  );
  assert.equal(wrongAmount.status, "clarification");
  const wrongDate = buildActionFromModelProposal(
    "Spent ₱500 on groceries today",
    modelProposal({ date: "2026-10-01" }),
    ctx(),
  );
  assert.equal(wrongDate.status, "clarification");
  const noAmountInWords = buildActionFromModelProposal(
    "Spent on groceries today",
    modelProposal(),
    ctx(),
  );
  assert.equal(noAmountInWords.status, "clarification");
});

test("model salary proposals need a real employee record and explicit payment type", () => {
  const ok = buildActionFromModelProposal(
    "Roger got his ₱1,000 salary for November 1, 2026",
    modelProposal({
      kind: "salary-payment",
      amountMinor: 100000,
      date: "2026-11-01",
      description: null,
      employeeName: "Roger",
      paymentType: "salary",
    }),
    ctx({ profile: business, employees: [roger] }),
  );
  assert.equal(ok.status, "proposal");
  if (ok.status === "proposal") {
    assert.equal(ok.action.employeeId, "e1");
    assert.equal(ok.action.employeeMatched, true);
    assert.equal(buildBuckyTransaction(ok.action, "2026-11-01T00:00:00.000Z").relatedId, "e1");
  }
  const fabricated = buildActionFromModelProposal(
    "Roger got his ₱1,000 salary for November 1, 2026",
    modelProposal({
      kind: "salary-payment",
      amountMinor: 100000,
      date: "2026-11-01",
      description: null,
      employeeName: "Roger",
      paymentType: "salary",
    }),
    ctx({ profile: business, employees: [] }),
  );
  assert.equal(fabricated.status, "clarification");
  const noType = buildActionFromModelProposal(
    "Roger got ₱1,000 for November 1, 2026",
    modelProposal({
      kind: "salary-payment",
      amountMinor: 100000,
      date: "2026-11-01",
      description: null,
      employeeName: "Roger",
      paymentType: null,
    }),
    ctx({ profile: business, employees: [roger] }),
  );
  assert.equal(noType.status, "clarification");
});

test("model savings proposals resolve only real goals of this profile", () => {
  const ok = buildActionFromModelProposal(
    "Put ₱1,000 toward the iPhone fund today",
    modelProposal({
      kind: "savings-contribution",
      amountMinor: 100000,
      description: null,
      bucketName: "iPhone",
    }),
    ctx(),
  );
  assert.equal(ok.status, "proposal");
  if (ok.status === "proposal") {
    assert.equal(ok.action.bucketId, "b1");
    assert.equal(ok.action.transactionType, "savings-deposit");
  }
  const unknownGoal = buildActionFromModelProposal(
    "Put ₱1,000 toward the iPhone fund today",
    modelProposal({
      kind: "savings-contribution",
      amountMinor: 100000,
      description: null,
      bucketName: "House",
    }),
    ctx(),
  );
  assert.equal(unknownGoal.status, "clarification");
});

// --- QA regression: explicit dates, named goals ---

test("an impossible explicit date is clarified, never silently replaced with today", () => {
  for (const text of [
    "Record ₱500 expense for groceries on 2026-02-30",
    "Record ₱500 expense for groceries on February 30, 2026",
    "Record ₱500 expense for groceries on 30 February 2026",
    "Record ₱500 expense for groceries on 2026-13-01",
  ]) {
    const result = interpretBuckyAction(text, ctx());
    assert.equal(result.status, "clarification", text);
    if (result.status === "clarification") assert.match(result.question, /isn't a real calendar date/);
  }
  // Salary and savings paths follow the same rule.
  assert.equal(
    interpretBuckyAction("Pay Roger ₱1,000 salary on 2026-02-30", ctx({ profile: business, employees: [roger], buckets: [] })).status,
    "clarification",
  );
  assert.equal(
    interpretBuckyAction("Add ₱100 to my iPhone savings goal on 2026-02-30", ctx()).status,
    "clarification",
  );
});

test("valid explicit dates, including leap day, are honoured; no date defaults to today", () => {
  const leap = proposal("Record ₱500 expense for groceries on February 29, 2024", ctx());
  assert.equal(leap.date, "2024-02-29");
  assert.equal(
    interpretBuckyAction("Record ₱500 expense for groceries on February 29, 2026", ctx()).status,
    "clarification",
    "2026 is not a leap year",
  );
  const iso = proposal("Record ₱500 expense for groceries on 2026-03-15", ctx());
  assert.equal(iso.date, "2026-03-15");
  // No explicit date: today's date is the default (already covered for
  // income above) and the description carries no stray date text.
  const undated = proposal("Record ₱500 expense for groceries", ctx());
  assert.equal(undated.date, "2026-11-01");
  assert.equal(undated.description, "Groceries");
});

test("an explicitly named nonexistent savings goal is never substituted, even with one goal", () => {
  const result = interpretBuckyAction(
    "Add ₱100 to my NonexistentGoal savings goal",
    ctx({ buckets: [bucket("b9", "QA Test Savings")] }),
  );
  assert.equal(result.status, "clarification");
  if (result.status === "clarification") {
    assert.match(result.question, /NonexistentGoal/);
    assert.match(result.question, /QA Test Savings/);
  }
  // Multiple goals: an unmatched name is still target-not-found.
  const multi = interpretBuckyAction("Add ₱100 to my House savings goal", ctx());
  assert.equal(multi.status, "clarification");
  // No name at all with a single goal still safely selects that goal.
  const unnamed = proposal("Add ₱100 to my savings goal", ctx({ buckets: [bucket("b9", "QA Test Savings")] }));
  assert.equal(unnamed.bucketId, "b9");
  assert.ok(unnamed.warnings.some((w) => w.includes("only savings goal")));
});

test("model proposals cannot override an invalid date or an unmatched named goal", () => {
  const badDate = buildActionFromModelProposal(
    "Record ₱500 expense for groceries on 2026-02-30",
    modelProposal({ date: "2026-11-01" }),
    ctx(),
  );
  assert.equal(badDate.status, "clarification");
  const substituted = buildActionFromModelProposal(
    "Add ₱100 to my NonexistentGoal savings goal",
    modelProposal({
      kind: "savings-contribution",
      amountMinor: 10000,
      description: null,
      bucketName: "QA Test Savings",
    }),
    ctx({ buckets: [bucket("b9", "QA Test Savings")] }),
  );
  assert.equal(substituted.status, "clarification");
});

/* --- Add Product (Checkpoint 2): one deterministic business action. --- */

function productCtx(overrides: Partial<BuckyProductContext> = {}): BuckyProductContext {
  return {
    profile: business,
    products: [],
    createId: () => "bucky:product-test-1",
    ...overrides,
  };
}

test("add product: parses the documented example with safe defaults", () => {
  const result = interpretBuckyProductCommand(
    "Bucky, add Burger to my products. Selling price is ₱35.",
    productCtx(),
  );
  assert.equal(result.status, "proposal");
  if (result.status !== "proposal") return;
  assert.equal(result.product.name, "Burger");
  assert.equal(result.product.priceMinor, 3500);
  assert.equal(result.product.currency, "PHP");
  assert.equal(result.product.profileId, "biz1");
  assert.equal(result.product.sku, null);
  assert.equal(result.product.category, null);
  assert.equal(result.product.costMinor, null);
  assert.equal(result.product.stock, 0);
  assert.equal(result.product.status, "active");
  assert.deepEqual(result.product.warnings, []);
  // The built record passes the same validation Products & Inventory uses,
  // and the stable proposal ID becomes the product ID (duplicate-safe).
  const built = buildBuckyProduct(result.product, "2026-11-02T00:00:00.000Z");
  assert.equal(built.id, "bucky:product-test-1");
  assert.equal(validateProduct(built), built);
});

test("add product: documented Hakdog example parses price and opening stock", () => {
  const result = interpretBuckyProductCommand("Add a product named Hakdog, price ₱85, stock 20.", productCtx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal") {
    assert.equal(result.product.name, "Hakdog");
    assert.equal(result.product.priceMinor, 8500);
    assert.equal(result.product.stock, 20);
  }
});

test("add product: uses the selected business's currency, never an inferred one", () => {
  const usdBusiness: Profile = { ...business, currency: "USD" };
  const result = interpretBuckyProductCommand(
    "Add Iced Tea to my products. Selling price is $2.50.",
    productCtx({ profile: usdBusiness }),
  );
  assert.equal(result.status, "proposal");
  if (result.status === "proposal") {
    assert.equal(result.product.priceMinor, 250);
    assert.equal(result.product.currency, "USD");
    assert.equal(result.product.name, "Iced Tea");
  }
  // An unmarked amount is priced in the business's own currency.
  const unmarked = interpretBuckyProductCommand("Add Burger to my products for 35", productCtx());
  assert.equal(unmarked.status, "proposal");
  if (unmarked.status === "proposal") assert.equal(unmarked.product.currency, "PHP");
});

test("add product: missing or ambiguous required information asks first", () => {
  assert.equal(
    interpretBuckyProductCommand("Add Burger to my products", productCtx()).status,
    "clarification", // no selling price
  );
  assert.equal(
    interpretBuckyProductCommand("Add to my products. Selling price is ₱35.", productCtx()).status,
    "clarification", // no product name
  );
  // A currency that is not the business's own is never silently converted.
  const mismatch = interpretBuckyProductCommand(
    "Add Burger to my products. Selling price is $35.",
    productCtx(),
  );
  assert.equal(mismatch.status, "clarification");
  if (mismatch.status === "clarification") assert.match(mismatch.question, /USD/);
});

test("add product: personal profiles are rejected before any proposal", () => {
  const result = interpretBuckyProductCommand(
    "Add Burger to my products. Selling price is ₱35.",
    productCtx({ profile: personal }),
  );
  assert.equal(result.status, "clarification");
  if (result.status === "clarification") assert.match(result.question, /personal profile/);
});

test("add product: non-product commands are never hijacked", () => {
  assert.equal(interpretBuckyProductCommand("Record ₱500 expense for groceries", productCtx()).status, "not-action");
  assert.equal(interpretBuckyProductCommand("Add ₱1,000 to my iPhone savings goal", productCtx()).status, "not-action");
  assert.equal(interpretBuckyProductCommand("How many products do I have?", productCtx()).status, "not-action");
  assert.equal(interpretBuckyProductCommand("", productCtx()).status, "not-action");
});

test("add product: an existing same-name product warns instead of hiding", () => {
  const existing: Product = {
    id: "prod1", profileId: "biz1", name: "Burger", sku: null, category: null,
    priceMinor: 3500, costMinor: null, currency: "PHP", stock: 4, status: "active",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const result = interpretBuckyProductCommand(
    "Add Burger to my products. Selling price is ₱35.",
    productCtx({ products: [existing] }),
  );
  assert.equal(result.status, "proposal");
  if (result.status === "proposal") {
    assert.equal(result.product.warnings.length, 1);
    assert.match(result.product.warnings[0], /already exists/);
  }
  // A same-named product in a *different* business never warns here.
  const otherBusiness = interpretBuckyProductCommand(
    "Add Burger to my products. Selling price is ₱35.",
    productCtx({ products: [{ ...existing, profileId: "biz2" }] }),
  );
  assert.equal(otherBusiness.status, "proposal");
  if (otherBusiness.status === "proposal") assert.deepEqual(otherBusiness.product.warnings, []);
});

test('Stock, employee, product and savings advisory questions are never write commands',()=>{
 for(const q of ['Should I increase Burger stock by 10?','Should I add an employee named Roger?','Which products should I add?','Would adding money to my savings help?','Summarize my PHP income and expenses.']){assert.equal(isFinancialAnalysisQuestion(q),true,q);assert.equal(interpretBuckyAction(q,ctx()).status,'not-action',q);assert.equal(interpretBuckyProductCommand(q,productCtx()).status,'not-action',q);}
});
