import assert from "node:assert/strict";
import test from "node:test";
import { loadOwnerProfile, ownerFirstName, parseOwnerProfile, saveOwnerProfile } from "./ownerProfile.ts";

function fakeStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}

test("owner profile round-trips through storage without touching other keys", () => {
  const store = fakeStorage();
  const saved = saveOwnerProfile({ firstName: "  Maria  ", lastName: " Santos ", showGreeting: true }, store);
  assert.equal(saved.firstName, "Maria");
  assert.equal(saved.lastName, "Santos");
  assert.deepEqual(loadOwnerProfile(store), { firstName: "Maria", lastName: "Santos", showGreeting: true });
  assert.equal(ownerFirstName(saved), "Maria");
});

test("corrupt or missing owner data falls back to empty defaults", () => {
  assert.deepEqual(parseOwnerProfile(null), { firstName: "", lastName: "", showGreeting: true });
  assert.deepEqual(parseOwnerProfile("{not json"), { firstName: "", lastName: "", showGreeting: true });
  assert.equal(ownerFirstName({ firstName: "  ", lastName: "X", showGreeting: true }), "");
});
