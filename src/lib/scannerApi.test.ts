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
  modelApiKeyConfigured: true,
  liveMeta: "enabled",
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

test("live scanner is available whenever the backend reports live enabled", () => {
  assert.equal(isLiveScannerAvailable(health), true);
  assert.equal(isLiveScannerAvailable({ ...health, liveMeta: "disabled" }), false);
  assert.equal(isLiveScannerAvailable(null), false);
});

test("default extraction is live and sends no token header", async () => {
  await withMockFetch("live", async (calls) => {
    const result = await requestExtraction(request);
    assert.equal(result.mode, "live");
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.mode, "live");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["x-bucketa-live-test"], undefined);
  });
});

test("mock extraction mode is rejected before any request is sent", async () => {
  await withMockFetch("live", async (calls) => {
    await assert.rejects(
      requestExtraction(request, { mode: "mock" as never }),
      /only scanning mode/,
    );
    assert.equal(calls.length, 0);
  });
});

test("live extraction needs no user token and sends none", async () => {
  await withMockFetch("live", async (calls) => {
    const result = await requestExtraction(request, { mode: "live" });
    assert.equal(result.mode, "live");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["x-bucketa-live-test"], undefined);
  });
});

test("live extraction body carries image and mode only — never a credential", async () => {
  await withMockFetch("live", async (calls) => {
    await requestExtraction(request, { mode: "live" });
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.mode, "live");
    assert.equal("liveTestToken" in body, false);
    assert.equal("token" in body, false);
  });
});
