import type { Profile, Transaction } from "../data/types.ts";

export interface HistoryScope {
  scope: "all" | "personal" | "business";
  profileId: string;
  from: string;
  to: string;
}
export type HistoryRequest = { context: HistoryScope; error: null } | { context: null; error: string };

export function historyHref(context: HistoryScope): string {
  const query = new URLSearchParams({ history: "1", scope: context.scope });
  if (context.scope === "business") query.set("profileId", context.profileId);
  if (context.from) query.set("from", context.from);
  if (context.to) query.set("to", context.to);
  return `#/transactions?${query}`;
}

/**
 * Link to the manageable Transactions view preselecting one business, by
 * stable profile ID (never by display name). Used after saving records
 * for a specific business (e.g. from the scanner) so the destination shows
 * that business's records in its own currency. This is in-memory view
 * state carried in the hash: it survives refresh and back/forward, and it
 * never changes any persistent default profile.
 */
export function transactionsHrefForProfile(profileId: string): string {
  return `#/transactions?${new URLSearchParams({ profileId })}`;
}

/** Link to Personal Finance preselecting one personal profile, by ID. */
export function personalHrefForProfile(profileId: string): string {
  return `#/personal?${new URLSearchParams({ profileId })}`;
}

/**
 * The `profileId` carried by a `#/transactions?profileId=…` or
 * `#/personal?profileId=…` link, or null when the hash carries none (or
 * carries anything unexpected, in which case callers keep their default
 * selection). Full-history hashes (`history=1`) are handled separately by
 * parseHistoryScope and intentionally return null here.
 */
export function profileIdFromHash(hash: string): string | null {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  if (!query.size || query.has("history")) return null;
  if ([...query.keys()].some((key) => key !== "profileId") || query.getAll("profileId").length !== 1) {
    return null;
  }
  const profileId = (query.get("profileId") ?? "").trim();
  return profileId ? profileId : null;
}

export function parseHistoryScope(hash: string): HistoryRequest | null {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  if (!query.size) return null;
  const invalid = { context: null, error: "This history link is invalid. Return to Home and choose your filters again." } as const;
  const allowed = new Set(["history", "scope", "profileId", "from", "to"]);
  if ([...query.keys()].some(key => !allowed.has(key) || query.getAll(key).length !== 1)) return invalid;
  const scope = query.get("scope");
  if (query.get("history") !== "1" || !["all", "personal", "business"].includes(scope ?? "")) return invalid;
  const profileId = query.get("profileId") ?? "";
  if (scope === "business" ? !profileId.trim() : query.has("profileId")) return invalid;
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const validDate = (day: string) => !day || (/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) return invalid;
  return { context: { scope: scope as HistoryScope["scope"], profileId, from, to }, error: null };
}

// Presentation selection only: no amounts are changed or combined.
export function selectHistory(records: readonly Transaction[], profiles: readonly Profile[], context: HistoryScope): { records: Transaction[]; error: string | null } {
  if (context.scope === "business" && !profiles.some(p => p.id === context.profileId && p.kind === "business")) {
    return { records: [], error: "This business profile is no longer available. Return to Home to select another profile." };
  }
  const ids = new Set(profiles.filter(p => context.scope === "all" || (context.scope === "personal" ? p.kind === "personal" : p.id === context.profileId)).map(p => p.id));
  return {
    records: records.filter(t => ids.has(t.profileId) && (!context.from || t.date.slice(0, 10) >= context.from) && (!context.to || t.date.slice(0, 10) <= context.to))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    error: null,
  };
}
