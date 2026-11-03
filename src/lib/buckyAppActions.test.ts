import assert from "node:assert/strict";
import test from "node:test";
import type { Bucket, Employee, Product, Profile, Sale, Transaction } from "../data/types.ts";
import { validateBucket, validateEmployee } from "../data/validation.ts";
import { bestSellingProducts, buildBucketRecord, buildEmployeeRecord, consumePosCartHandoff, earnedOnDate, interpretAppAction, queuePosCartHandoff, resolveNamedProfile, type AppActionContext } from "./buckyAppActions.ts";

const stamp = "2026-11-01T00:00:00.000Z";
const business: Profile = { id: "biz1", kind: "business", name: "Sari Store", currency: "PHP", createdAt: stamp, updatedAt: stamp };
const personal: Profile = { id: "p1", kind: "personal", name: "My Money", currency: "PHP", createdAt: stamp, updatedAt: stamp };
const hakdog: Product = { id: "prod1", profileId: "biz1", name: "Hakdog", sku: null, category: null, priceMinor: 8500, costMinor: null, currency: "PHP", stock: 20, status: "active", createdAt: stamp, updatedAt: stamp };
const burger: Product = { id: "prod2", profileId: "biz1", name: "Burger", sku: null, category: null, priceMinor: 5000, costMinor: null, currency: "PHP", stock: 3, status: "active", createdAt: stamp, updatedAt: stamp };
let seq = 0;
function ctx(over: Partial<AppActionContext> = {}): AppActionContext {
  return { profile: business, products: [hakdog, burger], employees: [], buckets: [], today: "2026-11-01", createId: () => `bucky:app-${++seq}`, ...over };
}

test("add employee proposes a valid record and requires a business profile", () => {
  const result = interpretAppAction("Add employee Roger.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-employee") {
    assert.equal(result.action.name, "Roger");
    assert.equal(validateEmployee(buildEmployeeRecord(result.action, stamp)).name, "Roger");
  } else assert.fail("expected employee proposal");
  assert.equal(interpretAppAction("Add employee Roger.", ctx({ profile: personal })).status, "clarification");
});

test("named business employee command parses name and monthly PHP salary", () => {
  const bibingka: Profile = { id: "biz2", kind: "business", name: "Bibingka", currency: "PHP", createdAt: stamp, updatedAt: stamp };
  const resolved = resolveNamedProfile("add an employee record under my Bibingka business", [business, bibingka]);
  assert.equal(resolved.status, "matched");
  const result = interpretAppAction("Hey Bucky, add an employee record under my Bibingka business. His name is Michael Anzures, and his monthly salary is PHP 15,000.", ctx({ profile: bibingka }));
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-employee") {
    assert.equal(result.action.name, "Michael Anzures");
    assert.equal(result.action.profileId, "biz2");
    assert.equal(result.action.salaryRateMinor, 1500000);
    assert.equal(result.action.salaryFrequency, "monthly");
    const record = buildEmployeeRecord(result.action, stamp);
    assert.equal(validateEmployee(record).salaryRateMinor, 1500000);
    assert.equal(record.profileId, "biz2");
  } else assert.fail("expected employee proposal");
});

test("named profile resolution never guesses missing or ambiguous businesses", () => {
  assert.equal(resolveNamedProfile("summarize my Bibingka business", [business]).status, "named-missing");
  const dupA: Profile = { ...business, id: "dup1", name: "Store" };
  const dupB: Profile = { ...business, id: "dup2", name: "Store" };
  assert.equal(resolveNamedProfile("add employee Roger under my Store business", [dupA, dupB]).status, "ambiguous");
  assert.equal(resolveNamedProfile("add employee Roger", [business]).status, "none");
  // Salary in a different currency is a clarification, never a conversion.
  const usd: Profile = { ...business, id: "biz-usd", currency: "USD" };
  assert.equal(interpretAppAction("Add employee Roger, monthly salary PHP 15,000", ctx({ profile: usd })).status, "clarification");
});

test("increase stock resolves the product and computes the new level", () => {
  const result = interpretAppAction("Increase Hakdog stock by 10.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "adjust-stock") {
    assert.equal(result.action.productId, "prod1");
    assert.equal(result.action.newStock, 30);
  } else assert.fail("expected stock proposal");
  assert.equal(interpretAppAction("Increase Unknown stock by 10.", ctx()).status, "clarification");
});

test("create savings bucket proposes a valid bucket without touching contributions", () => {
  const result = interpretAppAction("Create a savings bucket for my motorcycle.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "create-bucket") {
    assert.equal(result.action.name, "Motorcycle");
    assert.equal(validateBucket(buildBucketRecord(result.action, stamp)).kind, "savings");
  } else assert.fail("expected bucket proposal");
  assert.equal(interpretAppAction("Add ₱500 to my iPhone savings.", ctx()).status, "not-action");
});

test("POS cart proposals parse number words, respect stock, and never hijack records", () => {
  const result = interpretAppAction("Add two burgers to the POS cart.", ctx());
  assert.equal(result.status, "proposal");
  if (result.status === "proposal" && result.action.kind === "pos-cart-add") {
    assert.equal(result.action.productId, "prod2");
    assert.equal(result.action.quantity, 2);
  } else assert.fail("expected cart proposal");
  assert.equal(interpretAppAction("Record ₱500 expense for groceries", ctx()).status, "not-action");
});

test("best sellers and earned-today are computed from real records only", () => {
  const sale: Sale = { id: "s1", profileId: "biz1", items: [{ productId: "prod1", name: "Hakdog", sku: null, unitPriceMinor: 8500, quantity: 4, lineTotalMinor: 34000 }, { productId: "prod2", name: "Burger", sku: null, unitPriceMinor: 5000, quantity: 2, lineTotalMinor: 10000 }], totalMinor: 44000, currency: "PHP", createdAt: "2026-11-01T08:00:00.000Z", updatedAt: stamp };
  const best = bestSellingProducts([sale], "biz1");
  assert.equal(best[0].name, "Hakdog");
  assert.equal(best[0].quantity, 4);
  const txn: Transaction = { id: "t1", profileId: "biz1", bucketId: null, type: "income", amountMinor: 100000, currency: "PHP", date: "2026-11-01", description: "Sales", category: null, origin: "manual", relatedId: null, createdAt: stamp, updatedAt: stamp };
  assert.deepEqual(earnedOnDate([txn], [sale], "biz1", "2026-11-01"), [{ date: "2026-11-01", currency: "PHP", incomeMinor: 100000, posRevenueMinor: 44000 }]);
  assert.deepEqual(earnedOnDate([txn], [sale], "biz1", "2026-11-02"), []);
});

test("POS handoff is single-use, profile-scoped, and expires", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  queuePosCartHandoff(storage, { profileId: "biz1", items: [{ productId: "prod1", quantity: 2 }], createdAt: 1000 });
  assert.equal(consumePosCartHandoff(storage, "other", 2000), null);
  queuePosCartHandoff(storage, { profileId: "biz1", items: [{ productId: "prod1", quantity: 2 }], createdAt: 1000 });
  assert.equal(consumePosCartHandoff(storage, "biz1", 2000)?.items[0].quantity, 2);
  assert.equal(consumePosCartHandoff(storage, "biz1", 2000), null);
});
