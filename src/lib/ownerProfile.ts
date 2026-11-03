/**
 * Local owner profile (Phase B). Stored only in localStorage so it never
 * touches IndexedDB business/personal records, currencies, or profiles.
 * Safe on any origin: localhost and 127.0.0.1 keep separate values and are
 * never merged automatically.
 */
export interface OwnerProfile {
  firstName: string;
  lastName: string;
  /** Show the owner greeting on Home. */
  showGreeting: boolean;
}

export const OWNER_PROFILE_KEY = "bucketa.ownerProfile";
export const DEFAULT_OWNER_PROFILE: OwnerProfile = { firstName: "", lastName: "", showGreeting: true };

const CHANGE_EVENT = "bucketa:owner-profile-changed";

function cleanName(value: unknown, max = 40): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

export function parseOwnerProfile(raw: string | null): OwnerProfile {
  if (!raw) return { ...DEFAULT_OWNER_PROFILE };
  try {
    const parsed = JSON.parse(raw) as Partial<OwnerProfile>;
    return {
      firstName: cleanName(parsed.firstName),
      lastName: cleanName(parsed.lastName),
      showGreeting: typeof parsed.showGreeting === "boolean" ? parsed.showGreeting : true,
    };
  } catch {
    return { ...DEFAULT_OWNER_PROFILE };
  }
}

export function loadOwnerProfile(storage?: Pick<Storage, "getItem">): OwnerProfile {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!store) return { ...DEFAULT_OWNER_PROFILE };
    return parseOwnerProfile(store.getItem(OWNER_PROFILE_KEY));
  } catch {
    return { ...DEFAULT_OWNER_PROFILE };
  }
}

export function saveOwnerProfile(profile: OwnerProfile, storage?: Pick<Storage, "setItem">): OwnerProfile {
  const next: OwnerProfile = {
    firstName: cleanName(profile.firstName),
    lastName: cleanName(profile.lastName),
    showGreeting: profile.showGreeting !== false,
  };
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    store?.setItem(OWNER_PROFILE_KEY, JSON.stringify(next));
  } catch { /* private mode: value still applies this session via event */ }
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<OwnerProfile>(CHANGE_EVENT, { detail: next }));
  } catch { /* non-browser */ }
  return next;
}

/** Display name for greetings: first name only, never invented. */
export function ownerFirstName(profile: OwnerProfile): string {
  return profile.firstName.trim();
}

export function onOwnerProfileChanged(listener: (profile: OwnerProfile) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => listener((event as CustomEvent<OwnerProfile>).detail ?? loadOwnerProfile());
  const onStorage = (event: StorageEvent) => { if (event.key === OWNER_PROFILE_KEY) listener(loadOwnerProfile()); };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(CHANGE_EVENT, onCustom); window.removeEventListener("storage", onStorage); };
}
