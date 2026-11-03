import assert from "node:assert/strict";
import test from "node:test";
import {
  buckyAdviceMode,
  buckyLiveUnavailableNote,
  createAdviceSubmissionGuard,
  describeAdviceSource,
  getBuckyLiveSettings,
  updateBuckyLiveSettings,
} from "./buckyLiveSettings.ts";

test("live mode defaults off and requires both the toggle and a token", () => {
  updateBuckyLiveSettings({ enabled: false, token: "" });
  assert.deepEqual(getBuckyLiveSettings(), { enabled: false, token: "" });
  assert.equal(buckyAdviceMode(getBuckyLiveSettings()), "fallback");
  // Toggle on without a token still cannot send a paid request.
  updateBuckyLiveSettings({ enabled: true });
  assert.equal(buckyAdviceMode(getBuckyLiveSettings()), "fallback");
  assert.match(buckyLiveUnavailableNote(getBuckyLiveSettings()) ?? "", /no live test token/);
  // Toggle + token = live; toggle off always wins.
  updateBuckyLiveSettings({ token: " runtime-only " });
  assert.equal(buckyAdviceMode(getBuckyLiveSettings()), "live");
  assert.equal(buckyLiveUnavailableNote(getBuckyLiveSettings()), null);
  updateBuckyLiveSettings({ enabled: false });
  assert.equal(buckyAdviceMode(getBuckyLiveSettings()), "fallback");
  assert.equal(buckyLiveUnavailableNote(getBuckyLiveSettings()), null);
  updateBuckyLiveSettings({ enabled: false, token: "" });
});

test("provenance distinguishes live, attempted-live fallback, and deterministic answers", () => {
  assert.match(
    describeAdviceSource({ source: "meta-live", model: "muse-spark-1.3" }),
    /Answered by live Meta AI \(muse-spark-1\.3\), validated server-side/,
  );
  const attempted = describeAdviceSource({
    source: "deterministic-fallback",
    model: null,
    diagnostic: { category: "upstream_http", upstreamStatus: 500 },
  });
  assert.match(attempted, /Live Meta AI was attempted/);
  assert.match(attempted, /deterministic fallback/);
  assert.match(
    describeAdviceSource({ source: "deterministic-fallback", model: null }),
    /Live Meta AI was not used, so no paid request was made/,
  );
});

test("single-flight guard allows exactly one pending submission (typed or voice)", () => {
  const guard = createAdviceSubmissionGuard();
  assert.equal(guard.isPending(), false);
  assert.equal(guard.tryStart(), true);
  // A second submission — e.g. a voice transcript landing while a typed
  // question is in flight — is refused, so it cannot spend a second
  // live request.
  assert.equal(guard.tryStart(), false);
  assert.equal(guard.isPending(), true);
  guard.finish();
  assert.equal(guard.tryStart(), true);
  guard.finish();
});
