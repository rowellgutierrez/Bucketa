import assert from "node:assert/strict";
import test from "node:test";
import type { Employee, Transaction } from "../data/types.ts";
import {
  buildCompensationTransaction,
  businessCompensationSummary,
  employeeOptionLabel,
  monthlyCompensation,
  paymentsForEmployee,
  summarizeEmployeePayments,
} from "./employees.ts";

const stamp = "2026-11-01T00:00:00.000Z";
const roger: Employee = {
  id: "e1", profileId: "biz1", name: "Roger", role: "Cashier", status: "active",
  salaryRateMinor: 2000000, salaryFrequency: "monthly", currency: "PHP",
  createdAt: stamp, updatedAt: stamp,
};
const maria: Employee = { ...roger, id: "e2", name: "Maria", role: "Manager" };

let seq = 0;
function pay(over: Partial<Transaction> = {}): Transaction {
  seq += 1;
  return {
    id: `t${seq}`, profileId: "biz1", bucketId: null, type: "expense",
    amountMinor: 100000, currency: "PHP", date: "2026-11-01",
    description: "Salary payment — Roger", category: "Salaries",
    origin: "manual", relatedId: "e1", createdAt: stamp, updatedAt: stamp,
    ...over,
  };
}

test("payments link to exactly one employee and stay inside their business", () => {
  const txns = [
    pay(),
    pay({ relatedId: "e2", description: "Salary payment — Maria" }),
    pay({ profileId: "other-biz" }),
    pay({ category: "Food", description: "Groceries", relatedId: null }),
  ];
  assert.equal(paymentsForEmployee(txns, roger).length, 1);
  assert.equal(paymentsForEmployee(txns, maria).length, 1);
});

test("legacy unlinked payments match by the name in the description only", () => {
  const txns = [
    pay({ relatedId: null }),
    pay({ relatedId: null, description: "Salary payment — Maria", category: "Salaries" }),
    pay({ relatedId: null, description: "Bonus payment — Roger", category: "Bonuses" }),
  ];
  assert.equal(paymentsForEmployee(txns, roger).length, 2);
  assert.equal(paymentsForEmployee(txns, maria).length, 1);
});

test("summaries report totals, last payment, and monthly breakdowns", () => {
  const txns = [
    pay({ amountMinor: 100000, date: "2026-10-01" }),
    pay({ amountMinor: 50000, date: "2026-11-01", category: "Bonuses", description: "Bonus payment — Roger" }),
    pay({ amountMinor: 200000, date: "2026-11-05", relatedId: "e2", description: "Salary payment — Maria" }),
  ];
  const summaries = summarizeEmployeePayments([roger, maria], txns);
  const rogerSummary = summaries.find((s) => s.employeeId === "e1")!;
  assert.equal(rogerSummary.paymentCount, 2);
  assert.deepEqual(rogerSummary.totalsByCurrency, [{ currency: "PHP", totalMinor: 150000 }]);
  assert.equal(rogerSummary.lastPayment?.date, "2026-11-01");
  assert.equal(rogerSummary.lastPayment?.type, "bonus");

  const months = monthlyCompensation(txns, "biz1", "PHP");
  assert.deepEqual(months.map((m) => m.month), ["2026-10", "2026-11"]);
  assert.equal(months[1].salaryMinor, 200000);
  assert.equal(months[1].bonusMinor, 50000);
  assert.equal(months[1].totalMinor, 250000);
});

test("business summary compares with recorded income and never calls it profit", () => {
  const txns = [
    pay(),
    pay({ type: "income", category: null, description: "Sales income", amountMinor: 1000000, relatedId: null }),
  ];
  const [summary] = businessCompensationSummary(txns, "biz1");
  assert.equal(summary.salaryMinor, 100000);
  assert.equal(summary.incomeMinor, 1000000);
  assert.equal(summary.percentOfIncome, 10);
  const [noIncome] = businessCompensationSummary([pay()], "biz1");
  assert.equal(noIncome.percentOfIncome, null);
});

test("a salary rate is not a payment; built payments carry the stable ID and link", () => {
  // Roger has a ₱20,000/month rate but no payments yet.
  assert.equal(paymentsForEmployee([], roger).length, 0);
  const txn = buildCompensationTransaction({
    id: "salary:stable-1",
    employee: roger,
    type: "salary",
    amountMinor: 100000,
    currency: "PHP",
    date: "2026-11-01",
    note: "November",
    timestamp: stamp,
  });
  assert.equal(txn.id, "salary:stable-1");
  assert.equal(txn.relatedId, "e1");
  assert.equal(txn.category, "Salaries");
  assert.equal(txn.description, "Salary payment — Roger · November");
  assert.equal(txn.type, "expense");
});

test("duplicate employee names get unambiguous labels; selection stays by ID", () => {
  const cashier: Employee = { ...roger, id: "emp-a001", role: "Cashier" };
  const manager: Employee = { ...roger, id: "emp-b002", role: "Manager" };
  const otherBusinessRoger: Employee = { ...roger, id: "emp-c003", profileId: "other", role: "Cashier" };
  const all = [cashier, manager, maria, otherBusinessRoger];
  assert.equal(employeeOptionLabel(cashier, all), "Roger — Cashier");
  assert.equal(employeeOptionLabel(manager, all), "Roger — Manager");
  // A unique name in the same business stays bare.
  assert.equal(employeeOptionLabel(maria, all), "Maria");
  // Payments still link to exactly one employee, whichever label was shown.
  const txns = [pay({ relatedId: "emp-a001" }), pay({ relatedId: "emp-b002" })];
  assert.equal(paymentsForEmployee(txns, cashier).length, 1);
  assert.equal(paymentsForEmployee(txns, manager).length, 1);
});

test("identical name and position fall back to a stable ID discriminator", () => {
  const first: Employee = { ...roger, id: "emp-a001", role: "Cashier" };
  const second: Employee = { ...roger, id: "emp-b002", role: "Cashier" };
  const labels = [employeeOptionLabel(first, [first, second]), employeeOptionLabel(second, [first, second])];
  assert.notEqual(labels[0], labels[1]);
  assert.ok(labels[0].startsWith("Roger — Cashier · #"));
  assert.ok(labels[1].startsWith("Roger — Cashier · #"));
  // Stable: same records produce the same label every time.
  assert.equal(employeeOptionLabel(first, [first, second]), labels[0]);
  // No position recorded is labelled as such rather than left ambiguous.
  const noRoleA: Employee = { ...roger, id: "emp-a001", role: null };
  const noRoleB: Employee = { ...roger, id: "emp-b002", role: null };
  assert.ok(employeeOptionLabel(noRoleA, [noRoleA, noRoleB]).startsWith("Roger — No position recorded · #"));
});
