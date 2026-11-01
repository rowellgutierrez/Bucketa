// Existing tests are excluded from the frontend compiler individually. Keep
// this new test self-contained: Node builtins load at runtime without adding
// Node typings to the browser project or suppressing TypeScript diagnostics.
interface Assertions {
  equal(actual: unknown, expected: unknown): void;
  notEqual(actual: unknown, expected: unknown): void;
  deepEqual(actual: unknown, expected: unknown): void;
  match(actual: string, expected: RegExp): void;
  ok(value: unknown): void;
}
const assert: Assertions = (await import("node:" + "assert/strict")).default;
const test: (name: string, body: () => void) => void = (await import("node:" + "test")).default;
import { transactionDisplay } from "./transactionDisplay.ts";
import type { Transaction, TransactionType } from "../data/types.ts";
import { bucketSavedMinor, summarizeTransactions } from "./finance.ts";

test("a savings withdrawal is a reduction in savings, never positive income", () => {
  const display = transactionDisplay("savings-withdrawal");
  assert.equal(display.sign, "−");
  assert.equal(display.amountClass, "amount-out");
  assert.equal(display.label, "Savings withdrawal");
  assert.match(display.context, /Out of savings/);
  assert.match(display.context, /not an expense/);
});

test("deposits and POS sales remain distinct from income", () => {
  assert.equal(transactionDisplay("income").amountClass, "amount-in");
  assert.equal(transactionDisplay("expense").sign, "−");
  for (const type of ["savings-deposit", "sale"] as const) {
    assert.equal(transactionDisplay(type).sign, "+");
    assert.equal(transactionDisplay(type).amountClass, "amount-movement");
    assert.notEqual(transactionDisplay(type).label, "Income");
  }
});

test("a generic transfer does not invent an incoming or outgoing direction", () => {
  const display = transactionDisplay("transfer");
  assert.equal(display.sign, "");
  assert.equal(display.amountClass, "amount-movement");
  assert.match(display.context, /direction unspecified/);
});

test("every supported type has an explicit readable label and indicator", () => {
  const types: TransactionType[] = ["income", "expense", "transfer", "sale", "savings-deposit", "savings-withdrawal"];
  for (const type of types) {
    const display = transactionDisplay(type);
    assert.ok(display.label.length > 0);
    assert.ok(display.context.length > 0);
    assert.ok(display.icon.length > 0);
  }
});

test("display decisions leave amounts, saved totals and cash-flow calculations unchanged", () => {
  // Ephemeral unit-test objects only; never written to any repository or database.
  const record = (type: TransactionType, amountMinor: number): Transaction => Object.freeze({
    id: type, profileId: "test", bucketId: "goal", type, amountMinor, currency: "PHP",
    date: "2026-11-01", description: "Unit test", category: null,
    origin: "manual", relatedId: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  });
  const records = [record("income", 10000), record("expense", 2000), record("savings-deposit", 5000), record("savings-withdrawal", 1000)];
  const original = JSON.stringify(records);
  const savingsBefore = bucketSavedMinor(records, { id: "goal", currency: "PHP" });
  const summaryBefore = summarizeTransactions(records);
  for (const item of records) transactionDisplay(item.type);
  assert.equal(JSON.stringify(records), original);
  assert.equal(bucketSavedMinor(records, { id: "goal", currency: "PHP" }), savingsBefore);
  assert.deepEqual(summarizeTransactions(records), summaryBefore);
  assert.equal(summaryBefore[0].net, 8000);
});
