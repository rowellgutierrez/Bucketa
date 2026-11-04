import { errors } from "./errors.mjs";

/**
 * Live Meta requests require ALL of:
 * 1. ENABLE_LIVE_META=1 in the server environment (explicit backend
 *    live-mode configuration).
 * 2. A non-empty server-side MODEL_API_KEY (never sent to the browser).
 * 3. A local-development request context: the server binds 127.0.0.1
 *    only, and any browser Origin / Host present must be loopback
 *    (localhost / 127.0.0.1 / ::1). Cross-origin browser requests are
 *    rejected before any paid upstream call.
 *
 * There is no user-entered temporary token. Judges configure only
 * their own Meta API key on the server; the browser never holds a
 * credential for Meta.
 *
 * This is a LOCAL-DEVELOPMENT boundary, not public-internet
 * authentication. CORS alone is not treated as authentication, and
 * this server must not be exposed to a network: a public deployment
 * would need real authentication in front of these endpoints, which
 * Bucketa does not provide. See README "Security".
 *
 * There is NO application-imposed per-session request cap. Repeated
 * live requests are allowed; usage is bounded only by the caller's
 * own Meta API account limits, credits, and provider rate limits.
 * Each handler still makes exactly one upstream attempt per
 * user-initiated request (no automatic retries).
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(String(hostname ?? "").toLowerCase());
}

/** Browser Origin must be loopback when present. Missing Origin (a non-browser local caller) is allowed: loopback binding is the boundary. */
export function isAllowedLiveOrigin(origin) {
  if (origin === undefined || origin === null || origin === "") return true;
  let url;
  try { url = new URL(String(origin)); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHostname(url.hostname);
}

/** Host header must be loopback when present (DNS-rebinding defence). */
export function isAllowedLiveHost(host) {
  if (host === undefined || host === null || host === "") return true;
  const value = String(host).trim().toLowerCase();
  // Strip port; keep bracketed IPv6 intact.
  let hostname;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    hostname = end >= 0 ? value.slice(0, end + 1) : value;
  } else {
    hostname = value.split(":")[0];
  }
  return isLoopbackHostname(hostname);
}

export function assertLiveAllowed({ liveMetaEnabled, modelApiKey, origin, host }) {
  if (!liveMetaEnabled) throw errors.liveDisabled();
  if (!modelApiKey) throw errors.liveDisabled();
  if (!isAllowedLiveOrigin(origin) || !isAllowedLiveHost(host)) {
    throw errors.liveUnauthorized();
  }
}
