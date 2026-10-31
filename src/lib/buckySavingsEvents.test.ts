import assert from "node:assert/strict";
import test from "node:test";
import {
  createSavingsReactionState,
  observeSavingsGoal,
  planSavingsReaction,
} from "./buckySavingsEvents.ts";
import { FINANCIAL_EVENTS } from "../features/bucky/runtime/savings.js";

test("mounting an already-completed goal plans no celebration", () => {
  const state = createSavingsReactionState();
  // Hydration/mount only observes; it can never produce a reaction.
  observeSavingsGoal(state, "goal-1", 100);
  assert.equal(state.baselinePercent, 100);
  assert.equal(state.firedKeys.size, 0);
});

test("confirmed deposit below 100% plans a deposit reaction", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 40);
  const plan = planSavingsReaction(state, {
    goalId: "goal-1",
    eventId: "txn-1",
    kind: "deposit",
    percentBefore: 40,
    percentAfter: 65,
  });
  assert.ok(plan);
  assert.equal(plan!.event, "deposit");
  assert.equal(plan!.progress, 65);
  assert.equal(plan!.completesGoal, false);});

test("deposit reaching exactly 100% is the only completion transition", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 90);
  const plan = planSavingsReaction(state, {
    goalId: "goal-1",
    eventId: "txn-2",
    kind: "deposit",
    percentBefore: 90,
    percentAfter: 100,
  });
  assert.ok(plan);
  assert.equal(plan!.completesGoal, true);
});

test("a goal already at 100% does not complete again on later movements", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 100);
  const plan = planSavingsReaction(state, {
    goalId: "goal-1",
    eventId: "txn-3",
    kind: "withdrawal",
    percentBefore: 100,
    percentAfter: 80,
  });
  assert.ok(plan);
  assert.equal(plan!.completesGoal, false);
});

test("duplicate transaction IDs are deduplicated per goal", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 10);
  const input = {
    goalId: "goal-1",
    eventId: "txn-dup",
    kind: "deposit" as const,
    percentBefore: 10,
    percentAfter: 20,
  };
  assert.ok(planSavingsReaction(state, input));
  assert.equal(planSavingsReaction(state, input), null);
});

test("the same transaction ID under a different goal is not a duplicate", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 10);
  assert.ok(
    planSavingsReaction(state, {
      goalId: "goal-1",
      eventId: "txn-shared",
      kind: "deposit",
      percentBefore: 10,
      percentAfter: 20,
    }),
  );
  observeSavingsGoal(state, "goal-2", 0);
  assert.ok(
    planSavingsReaction(state, {
      goalId: "goal-2",
      eventId: "txn-shared",
      kind: "deposit",
      percentBefore: 0,
      percentAfter: 5,
    }),
  );
});

test("switching goals suppresses stale-goal reactions and fires none itself", () => {
  const state = createSavingsReactionState();
  observeSavingsGoal(state, "goal-1", 50);
  // Goal switch: observation only, no reaction planned by the switch.
  observeSavingsGoal(state, "goal-2", 100);
  assert.equal(state.firedKeys.size, 0);
  // A late event for the previously displayed goal must not fire.
  assert.equal(
    planSavingsReaction(state, {
      goalId: "goal-1",
      eventId: "txn-late",
      kind: "deposit",
      percentBefore: 50,
      percentAfter: 60,
    }),
    null,
  );
  // The newly displayed goal still reacts to its own confirmed movements.
  assert.ok(
    planSavingsReaction(state, {
      goalId: "goal-2",
      eventId: "txn-new",
      kind: "withdrawal",
      percentBefore: 100,
      percentAfter: 90,
    }),
  );
});

test("movements before any goal is observed plan nothing", () => {
  const state = createSavingsReactionState();
  assert.equal(
    planSavingsReaction(state, {
      goalId: "goal-1",
      eventId: "txn-early",
      kind: "deposit",
      percentBefore: 0,
      percentAfter: 10,
    }),
    null,
  );
});

test("clip mapping: deposit is a visible wave, completion stays Celebration, withdrawal unchanged", () => {
  // A partial deposit must be clearly visible (one-shot Wave), the strong
  // Celebration is reserved for goal completion, withdrawals keep NodYes.
  assert.equal(FINANCIAL_EVENTS.deposit, "Wave");
  assert.equal(FINANCIAL_EVENTS.goalCompleted, "Celebration");
  assert.equal(FINANCIAL_EVENTS.withdrawal, "NodYes");
});

test("invalid progress values are rejected", () => {
  const state = createSavingsReactionState();
  assert.throws(() => observeSavingsGoal(state, "goal-1", 101), RangeError);
  observeSavingsGoal(state, "goal-1", 0);
  assert.throws(
    () =>
      planSavingsReaction(state, {
        goalId: "goal-1",
        eventId: "txn-bad",
        kind: "deposit",
        percentBefore: Number.NaN,
        percentAfter: 10,
      }),
    RangeError,
  );
});
