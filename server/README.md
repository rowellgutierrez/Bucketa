# Bucketa Server (M1A mock + M1B gated live)

Local Node.js backend for the AI Record Scanner and the Bucky Agent. Mock extraction is the default. **Live Meta calls (M1B) require all three gates:** `ENABLE_LIVE_META=1`, a server-side `MODEL_API_KEY`, and a per-request `x-bucketa-live-test` header matching `LIVE_TEST_TOKEN` — plus a limit of 3 live requests per server session shared by the scanner and Bucky. The scanner UI never sends that header. The Bucky panel sends it only when the user explicitly opts into a live answer and types the token at runtime; the token is never stored, pre-filled, or logged.

## Run

```text
npm run server
```

Listens on `http://127.0.0.1:8787` (set `PORT` to change). Keep it on localhost only — this proof of concept has no authentication and must not be exposed to a network.

Environment variables (see `.env.example`): `MODEL_API_KEY` (server-only; only reported as configured yes/no), `ENABLE_LIVE_META`, `LIVE_TEST_TOKEN`, `PORT`. Starting `npm run server` loads the project-root `.env` automatically.

## Endpoints

- `GET /api/health` → `{ ok, mode: "mock", defaultMode: "mock", modelApiKeyConfigured, liveMeta: "enabled-gated" | "disabled", liveRequestsUsed, liveRequestsLimit: 3, buckyAdvise: { endpoint, defaultSource: "deterministic-fallback", liveModel, liveCompatibilityVerified: false } }`. Health never returns key or token values.
- `POST /api/extract` with JSON `{ imageBase64, mediaType, expectedCurrency, recordType }` → validated fictional draft entries with integer minor-unit amounts, app-computed totals, and `needsReview` flags.
- `POST /api/bucky/advise` with JSON `{ question, mode, summary }` → Bucky Agent 1.0 advice. `summary` is the aggregated `buildBuckyModelSummary` shape only (per-currency totals/counts; raw records and descriptions are rejected), and the request body is capped at 16,384 bytes while streaming. Default `mode: "fallback"` returns server-computed deterministic advice labelled `source: "deterministic-fallback"`. `mode: "live"` is opt-in and requires the same three live gates plus the shared session limiter; model output (configured Meta model `muse-spark-1.3`, Responses API, strict JSON schema) is validated against an action allowlist and a grounded-numbers check covering the answer, explanation, and limitations. The model is not asked to return evidence: evidence is always recomputed server-side, and any validation/upstream failure returns the labelled deterministic fallback with a safe diagnostic category (and schema sub-reason when applicable). Live text-reasoning compatibility is **not yet verified** against the real API — no live Bucky answer has succeeded yet — and any live call needs separate approval.

## Safety rules

- Uploaded images exist only in memory during the request. Nothing is written to disk or logs; logs hold only method, path, status, duration, and entry count.
- Request bodies are capped while streaming (7.5 MB for scanner uploads; 16,384 bytes for Bucky advice), and decoded images are capped at 5 MB. Image type is verified from the file bytes, not the declared type. Upstream Meta responses are capped by actual UTF-8 byte length.
- The bucket's `expectedCurrency` is authoritative. A conflicting detected currency is flagged, never adopted.
- Missing or uncertain fields are marked `needsReview`. Totals are summed in code from integer minor units; any model-supplied total would be ignored.
- Errors returned to clients are fixed safe strings. Internal errors and secrets are never exposed.
- Tests use fictional financial records only: `npm run test:server` (offline, no API key needed).

Live Muse Spark testing is M1B and requires separate approval.
