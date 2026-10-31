import { errors } from "./errors.mjs";

/**
 * Live Meta requests require ALL of:
 * 1. ENABLE_LIVE_META=1 in the server environment.
 * 2. A non-empty server-side MODEL_API_KEY.
 * 3. An explicit per-request authorization: header
 *    `x-bucketa-live-test` matching the server-only LIVE_TEST_TOKEN.
 *    Callers must supply the token at runtime only. The Bucky panel does
 *    so solely when the user explicitly opts into a live answer and types
 *    the token; it is never stored. The scanner UI does not send it.
 */

export const MAX_LIVE_REQUESTS_PER_SESSION = 3;

export function createLiveLimiter(max = MAX_LIVE_REQUESTS_PER_SESSION) {
  let used = 0;
  return {
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, max - used);
    },
    /** Counts one attempt. Throws once the session limit is reached. No retries. */
    consume() {
      if (used >= max) throw errors.liveLimitReached();
      used += 1;
      return used;
    },
  };
}

export function assertLiveAllowed({ liveMetaEnabled, modelApiKey, liveTestToken, requestToken }) {
  if (!liveMetaEnabled) throw errors.liveDisabled();
  if (!modelApiKey) throw errors.liveDisabled();
  if (!liveTestToken || !requestToken || requestToken !== liveTestToken) {
    throw errors.liveUnauthorized();
  }
}
