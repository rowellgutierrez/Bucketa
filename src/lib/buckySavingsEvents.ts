/**
 * Pure decision logic for Savings Bucky reactions.
 *
 * Safety rules enforced here (covered by buckySavingsEvents.test.ts):
 * - A reaction is planned only for a confirmed, committed savings
 *   movement — never on page mount, reload, hydration, or a goal switch.
 * - Reactions are deduplicated by transaction ID scoped to the goal ID,
 *   so a retried render or replayed event can never celebrate twice.
 * - Observing a goal (mount / goal switch) only records a baseline; it
 *   never produces a reaction, so an already-completed goal does not
 *   replay its completion celebration.
 * - A completion is reported only on an in-session transition from
 *   below 100% to exactly 100% caused by the confirmed movement.
 */

export type SavingsReactionKind = "deposit" | "withdrawal";

export interface SavingsReactionState {
  /** Goal currently baselined by observation, if any. */
  goalId: string | null;
  /** Last observed percent for the baselined goal. */
  baselinePercent: number | null;
  /** `${goalId}:${eventId}` keys that already produced a reaction. */
  firedKeys: Set<string>;
}

export interface SavingsReactionInput {
  goalId: string;
  /** Stable transaction ID of the committed savings movement. */
  eventId: string;
  kind: SavingsReactionKind;
  /** Goal progress (0–100) before the movement was committed. */
  percentBefore: number;
  /** Goal progress (0–100) after the movement was committed. */
  percentAfter: number;
}

export interface SavingsReaction {
  event: SavingsReactionKind;
  goalId: string;
  eventId: string;
  /** Authoritative post-commit progress to hand to the mascot. */
  progress: number;
  /** True only for an in-session transition into exactly 100%. */
  completesGoal: boolean;
}

export function createSavingsReactionState(): SavingsReactionState {
  return { goalId: null, baselinePercent: null, firedKeys: new Set() };
}

function assertPercent(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${label} must be a finite number from 0 to 100.`);
  }
}

/**
 * Record the currently displayed goal and its progress WITHOUT planning
 * any reaction. Called on mount and whenever the displayed goal changes,
 * so pre-existing progress (including an already-completed goal) is
 * treated as a baseline rather than a new achievement.
 */
export function observeSavingsGoal(
  state: SavingsReactionState,
  goalId: string,
  percent: number,
): void {
  if (!goalId) throw new TypeError("Goal id is required.");
  assertPercent(percent, "Observed progress");
  state.goalId = goalId;
  state.baselinePercent = percent;
}

/**
 * Plan the reaction for one confirmed savings movement. Returns null
 * when the movement must not produce a reaction: a duplicate event, or
 * a movement for a goal other than the one currently displayed (for
 * example a deposit to a different savings bucket, or a stale event
 * arriving after a goal switch).
 */
export function planSavingsReaction(
  state: SavingsReactionState,
  input: SavingsReactionInput,
): SavingsReaction | null {
  if (!input.goalId) throw new TypeError("Goal id is required.");
  if (!input.eventId) throw new TypeError("Event id is required.");
  assertPercent(input.percentBefore, "Progress before movement");
  assertPercent(input.percentAfter, "Progress after movement");

  if (state.goalId !== input.goalId) return null;

  const key = `${input.goalId}:${input.eventId}`;
  if (state.firedKeys.has(key)) return null;
  state.firedKeys.add(key);

  return {
    event: input.kind,
    goalId: input.goalId,
    eventId: input.eventId,
    progress: input.percentAfter,
    completesGoal: input.percentBefore < 100 && input.percentAfter === 100,
  };
}
