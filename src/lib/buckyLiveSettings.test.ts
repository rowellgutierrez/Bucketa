import assert from "node:assert/strict";
import test from "node:test";
import {
  buckyAdviceMode,
  createAdviceSubmissionGuard,
  describeAdviceSource,
  getLiveAvailability,
  refreshLiveAvailability,
} from "./buckyLiveSettings.ts";

test("live mode follows backend health only — no toggle or user token", async () => {
  const liveFetch = (async () => new Response(JSON.stringify({ liveMeta: "enabled" }), { status: 200 })) as typeof fetch;
  const avail = await refreshLiveAvailability(liveFetch);
  assert.equal(avail.liveAvailable, true);
  assert.equal(buckyAdviceMode(avail), "live");
  assert.equal(buckyAdviceMode(getLiveAvailability()), "live");
  const offFetch = (async () => new Response(JSON.stringify({ liveMeta: "disabled" }), { status: 200 })) as typeof fetch;
  assert.equal(buckyAdviceMode(await refreshLiveAvailability(offFetch)), "fallback");
  const downFetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal(buckyAdviceMode(await refreshLiveAvailability(downFetch)), "fallback");
});

test("provenance distinguishes live, attempted-live fallback, and deterministic answers", () => {
  // A genuine live answer carries no visible status/provenance line.
  assert.equal(
    describeAdviceSource({ source: "meta-live", model: "muse-spark-1.3" }),
    "",
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
    /Live Meta AI is not configured/,
  );
});

test("Bucky chat distinguishes local answers from failed live explanations", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../components/BuckyPanel.tsx", import.meta.url), "utf8");
  assert.equal(panel.includes("Asking live Meta AI"), false);
  assert.equal(panel.includes("Answered by live Meta AI"), false);
  assert.equal(panel.includes("describeAdviceSource"), false);
  assert.match(panel, /No Meta request was made/);
  assert.match(panel, /live Meta explanation failed/);
});

test("single-flight guard allows exactly one pending submission (typed or voice)", () => {
  const guard = createAdviceSubmissionGuard();
  assert.equal(guard.isPending(), false);
  assert.equal(guard.tryStart(), true);
  assert.equal(guard.tryStart(), false);
  assert.equal(guard.isPending(), true);
  guard.finish();
  assert.equal(guard.tryStart(), true);
  guard.finish();
});
