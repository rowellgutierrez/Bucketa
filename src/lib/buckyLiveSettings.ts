/**
 * Bucky live Meta AI settings — MEMORY ONLY.
 *
 * The enable toggle and the live test token live in this module's memory
 * for the current app session only. They are never written to
 * localStorage, IndexedDB, a URL, logs, or source files, and they clear
 * when the app reloads. Default is OFF: Bucky answers deterministically
 * until the user explicitly enables live mode in Settings → Bucky & Voice
 * and enters the operator's token there.
 */

export interface BuckyLiveSettings {
  enabled: boolean;
  token: string;
}

const DEFAULT_SETTINGS: BuckyLiveSettings = { enabled: false, token: "" };

let current: BuckyLiveSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<() => void>();

export function getBuckyLiveSettings(): BuckyLiveSettings {
  return current;
}

export function subscribeBuckyLiveSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateBuckyLiveSettings(patch: Partial<BuckyLiveSettings>): BuckyLiveSettings {
  current = { ...current, ...patch };
  for (const listener of listeners) listener();
  return current;
}

/** Live only when the user enabled it AND a runtime token is present. */
export function buckyAdviceMode(settings: BuckyLiveSettings): "live" | "fallback" {
  return settings.enabled && settings.token.trim().length > 0 ? "live" : "fallback";
}

/** Why a question was not sent live, or null when it can be. */
export function buckyLiveUnavailableNote(settings: BuckyLiveSettings): string | null {
  if (!settings.enabled) return null;
  if (!settings.token.trim()) {
    return "Live Meta AI is on, but no live test token is entered in Settings → Bucky & Voice, so Bucky answered deterministically and no paid request was made.";
  }
  return null;
}

/**
 * User-facing provenance for an advisor response. A live attempt that
 * fell back is always distinguishable from both a genuine live answer
 * and from plain deterministic mode.
 */
export function describeAdviceSource(res: {
  source: "meta-live" | "deterministic-fallback";
  model: string | null;
  diagnostic?: { category: string; upstreamStatus: number | null; subReason?: string | null };
}): string {
  if (res.source === "meta-live") {
    return `Answered by live Meta AI${res.model ? ` (${res.model})` : ""}, validated server-side against your recorded figures.`;
  }
  if (res.diagnostic) {
    return "Live Meta AI was attempted, but its answer was unavailable or failed validation, so Bucky used a deterministic fallback calculated from your records. No model answer was trusted.";
  }
  return "Answered deterministically from your recorded data. Live Meta AI was not used, so no paid request was made.";
}

/**
 * Single-flight guard: one intentional submission produces at most one
 * live request. A second start attempt while one is pending is refused
 * until finish() runs. Shared by typed and voice submissions, which both
 * flow through the same ask() path.
 */
export function createAdviceSubmissionGuard() {
  let pending = false;
  return {
    isPending: () => pending,
    tryStart: () => {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish: () => {
      pending = false;
    },
  };
}
