/**
 * Bucky live Meta AI availability — discovered from the backend.
 *
 * Live mode is configured ONLY on the server (ENABLE_LIVE_META=1 plus
 * a server-side MODEL_API_KEY). The browser never holds a Meta
 * credential and never asks the user for a temporary token. This
 * module caches the /api/health result for the current session: when
 * the backend reports liveMeta "enabled", Bucky uses the real Meta
 * model by default; otherwise Bucky answers with a clearly labelled
 * deterministic fallback and no paid request is made.
 */

export interface LiveAvailability {
  /** False until the first health check completes. */
  known: boolean;
  liveAvailable: boolean;
}

let current: LiveAvailability = { known: false, liveAvailable: false };
const listeners = new Set<() => void>();

export function getLiveAvailability(): LiveAvailability {
  return current;
}

export function subscribeLiveAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setAvailability(next: LiveAvailability): LiveAvailability {
  current = next;
  for (const listener of listeners) listener();
  return current;
}

/** Fetch backend health once and cache whether live Meta AI is configured. Never throws. */
export async function refreshLiveAvailability(fetchImpl: typeof fetch = fetch): Promise<LiveAvailability> {
  try {
    const response = await fetchImpl("/api/health");
    if (!response.ok) throw new Error("health");
    const body = (await response.json()) as { liveMeta?: unknown };
    return setAvailability({ known: true, liveAvailable: body.liveMeta === "enabled" });
  } catch {
    return setAvailability({ known: true, liveAvailable: false });
  }
}

/** Live only when the backend reports live Meta AI configured. */
export function buckyAdviceMode(availability: LiveAvailability): "live" | "fallback" {
  return availability.liveAvailable ? "live" : "fallback";
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
    // No visible status line for a genuine live answer: the answer
    // itself is the conversation content. Provenance text is only
    // shown when a fallback was used, so it is never mislabelled.
    return "";
  }
  if (res.diagnostic) {
    return "Live Meta AI was attempted, but its answer was unavailable or failed validation, so Bucky used a deterministic fallback calculated from your records. No model answer was trusted.";
  }
  return "Answered deterministically from your recorded data. Live Meta AI is not configured on the server, so no paid request was made.";
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
