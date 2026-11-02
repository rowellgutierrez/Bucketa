import { historyHref, parseHistoryScope, personalHrefForProfile, profileIdFromHash, selectHistory, transactionsHrefForProfile, type HistoryScope } from "./historyScope.ts";
import type { Profile, Transaction, TransactionType } from "../data/types.ts";

const assert: { equal(a: unknown, b: unknown): void; deepEqual(a: unknown, b: unknown): void; ok(a: unknown): void } = (await import("node:" + "assert/strict")).default;
const test: (name: string, body: () => void) => void = (await import("node:" + "test")).default;
const profiles: Profile[] = ["personal", "business", "usd"].map(id => ({ id, kind: id === "personal" ? "personal" : "business", name: id, currency: id === "usd" ? "USD" : "PHP", createdAt: "", updatedAt: "" }));
const record = (id: string, profileId: string, type: TransactionType, date: string, currency = "PHP"): Transaction => Object.freeze({ id, profileId, type, date, currency, amountMinor: 10000, bucketId: null, description: id, category: null, origin: "manual", relatedId: null, createdAt: id, updatedAt: id });
const records = [record("a", "personal", "savings-withdrawal", "2026-11-01"), record("b", "personal", "savings-deposit", "2026-10-01"), record("c", "business", "expense", "2026-11-01"), record("d", "usd", "income", "2026-10-02", "USD"), record("e", "business", "transfer", "2026-10-03"), record("f", "business", "sale", "2026-10-04"), record("orphan", "deleted", "income", "2026-11-01")];
const context = (scope: HistoryScope["scope"] = "all", profileId = ""): HistoryScope => ({ scope, profileId, from: "", to: "" });

test("Home context round-trips with dates and encoded profile identifiers", () => {
  for (const scope of [context(), context("personal"), { ...context("business", "shop & /?name"), from: "2026-10-01", to: "2026-11-01" }]) {
    assert.deepEqual(parseHistoryScope(historyHref(scope)), { context: scope, error: null });
  }
  assert.equal(parseHistoryScope("#/transactions"), null);
});
test("invalid parameters fail closed rather than opening business management", () => {
  for (const query of ["history=0&scope=all", "scope=personal", "history=1&scope=other", "history=1&scope=business", "history=1&scope=all&profileId=shop", "history=1&scope=all&scope=personal", "history=1&scope=all&from=2026-02-30", "history=1&scope=all&from=no", "history=1&scope=all&from=2026-11-02&to=2026-11-01", "history=1&scope=all&currency=PHP"]) {
    assert.ok(parseHistoryScope("#/transactions?" + query)?.error);
  }
});
test("personal history includes savings without an unrelated business", () => {
  assert.deepEqual(selectHistory(records, profiles, context("personal")).records.map(t => t.id), ["a", "b"]);
});
test("all history keeps every matching type and currency, excluding deleted profiles", () => {
  const selection = selectHistory(records, profiles, context()).records;
  assert.equal(selection.length, 6);
  assert.ok(selection.some(t => t.currency === "USD"));
  assert.ok(selection.some(t => t.type === "transfer"));
  assert.ok(selection.some(t => t.type === "sale"));
  assert.deepEqual(selection.slice(0, 2).map(t => t.id), ["c", "a"]);
});
test("business and inclusive date scopes match Home selection", () => {
  const selected = selectHistory(records, profiles, { ...context("business", "business"), from: "2026-10-03", to: "2026-10-04" });
  assert.deepEqual(selected.records.map(t => t.id), ["f", "e"]);
  assert.equal(selectHistory(records, profiles, { ...context(), from: "2027-01-01" }).records.length, 0);
});
test("missing and wrong-kind business profiles never fall back", () => {
  for (const id of ["deleted", "personal", ""]) {
    const result = selectHistory(records, profiles, context("business", id));
    assert.ok(result.error);
    assert.equal(result.records.length, 0);
  }
});
test("selection preserves records, amounts, order and savings semantics", () => {
  const before = JSON.stringify(records);
  const selected = selectHistory(records, profiles, context()).records;
  assert.equal(JSON.stringify(records), before);
  assert.equal(selected.find(t => t.id === "a"), records[0]);
  assert.equal(records[0].amountMinor, 10000);
  assert.equal(records[0].type, "savings-withdrawal");
});
test("scanner-to-transactions link carries the source business by stable ID", () => {
  const href = transactionsHrefForProfile("biz-usd-1");
  assert.equal(href, "#/transactions?profileId=biz-usd-1");
  assert.equal(profileIdFromHash(href), "biz-usd-1");
  // IDs are encoded, never inferred from a display name.
  assert.equal(profileIdFromHash(transactionsHrefForProfile("a b&c")), "a b&c");
  assert.equal(profileIdFromHash(personalHrefForProfile("personal")), "personal");
  // The USD business context stays isolated: selecting by ID keeps the
  // other businesses' records out of the business scope.
  assert.deepEqual(selectHistory(records, profiles, context("business", "usd")).records.map(t => t.id), ["d"]);
});
test("hashes without an explicit profile keep the default selection", () => {
  assert.equal(profileIdFromHash("#/transactions"), null);
  assert.equal(profileIdFromHash("#/transactions?history=1&scope=business&profileId=business"), null);
  assert.equal(profileIdFromHash("#/transactions?profileId="), null);
  assert.equal(profileIdFromHash("#/transactions?profileId=a&profileId=b"), null);
  assert.equal(profileIdFromHash("#/transactions?profileId=a&extra=1"), null);
});
