import assert from "node:assert/strict";
import test from "node:test";
import {
  isLiveScannerAvailable,
  requestExtraction,
  ScannerApiError,
  type ExtractRequest,
  type ScannerHealth,
} from "./scannerApi.ts";

const request: ExtractRequest = {
  imageBase64: "aW1hZ2U=",
  mediaType: "image/png",
  expectedCurrency: "PHP",
  recordType: "sales",
};

const health: ScannerHealth = {
  ok: true,
  mode: "mock",
  defaultMode: "mock",
  modelApiKeyConfigured: true,
  liveMeta: "enabled-gated",
  liveRequestsUsed: 0,
  liveRequestsLimit: 3,
};

function extractionResponse(mode: "mock" | "live") {
  return {
    mode,
    recordType: "sales",
    currency: "PHP",
    entries: [],
    totals: {
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
      countedEntries: 0,
      skippedEntries: 0,
    },
    needsReviewCount: 0,
    ...(mode === "live" ? { liveRequestsUsed: 1 } : {}),
  };
}

async function withMockFetch(
  mode: "mock" | "live",
  run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(extractionResponse(mode)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("live scanner UI requires development mode and gated health", () => {
  assert.equal(isLiveScannerAvailable(true, health), true);
  assert.equal(isLiveScannerAvailable(false, health), false);
  assert.equal(isLiveScannerAvailable(true, { ...health, liveMeta: "disabled" }), false);
  assert.equal(isLiveScannerAvailable(true, null), false);
});

test("default extraction remains mock and sends no live token header", async () => {
  await withMockFetch("mock", async (calls) => {
    const result = await requestExtraction(request);
    assert.equal(result.mode, "mock");
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.mode, "mock");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["x-bucketa-live-test"], undefined);
  });
});

test("explicit mock never sends a supplied token header", async () => {
  await withMockFetch("mock", async (calls) => {
    await requestExtraction(request, { mode: "mock", liveTestToken: "test-token" });
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["x-bucketa-live-test"], undefined);
  });
});

test("live extraction without a non-empty token fails before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  };
  try {
    for (const liveTestToken of [undefined, "", "   "]) {
      await assert.rejects(
        () => requestExtraction(request, { mode: "live", liveTestToken }),
        (error: unknown) =>
          error instanceof ScannerApiError && error.code === "live_token_required",
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live extraction sends the runtime token only as a header", async () => {
  await withMockFetch("live", async (calls) => {
    const result = await requestExtraction(request, {
      mode: "live",
      liveTestToken: "test-token",
    });
    assert.equal(result.mode, "live");
    assert.equal(result.liveRequestsUsed, 1);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["x-bucketa-live-test"], "test-token");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.mode, "live");
    assert.equal("liveTestToken" in body, false);
    assert.equal(JSON.stringify(body).includes("test-token"), false);
  });
});
