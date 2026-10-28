# Bucketa Server (M1A mock + M1B gated live)

Local Node.js backend for the future AI Record Scanner. Mock extraction is the default. **Live Meta calls (M1B) require all three gates:** `ENABLE_LIVE_META=1`, a server-side `MODEL_API_KEY`, and a per-request `x-bucketa-live-test` header matching `LIVE_TEST_TOKEN` — plus a limit of 3 live requests per server session. The frontend never sends that header.

## Run

```text
npm run server
```

Listens on `http://127.0.0.1:8787` (set `PORT` to change). Keep it on localhost only — this proof of concept has no authentication and must not be exposed to a network.

Environment variables (see `.env.example`): `MODEL_API_KEY` (server-only; only reported as configured yes/no), `ENABLE_LIVE_META`, `LIVE_TEST_TOKEN`, `PORT`. Starting `npm run server` loads the project-root `.env` automatically.

## Endpoints

- `GET /api/health` → `{ ok, mode: "mock", modelApiKeyConfigured, liveMeta: "disabled-m1a" }`
- `POST /api/extract` with JSON `{ imageBase64, mediaType, expectedCurrency, recordType }` → validated fictional draft entries with integer minor-unit amounts, app-computed totals, and `needsReview` flags.

## Safety rules

- Uploaded images exist only in memory during the request. Nothing is written to disk or logs; logs hold only method, path, status, duration, and entry count.
- Request bodies are capped while streaming (7.5 MB), and decoded images are capped at 5 MB. Image type is verified from the file bytes, not the declared type.
- The bucket's `expectedCurrency` is authoritative. A conflicting detected currency is flagged, never adopted.
- Missing or uncertain fields are marked `needsReview`. Totals are summed in code from integer minor units; any model-supplied total would be ignored.
- Errors returned to clients are fixed safe strings. Internal errors and secrets are never exposed.
- Tests use fictional financial records only: `npm run test:server` (offline, no API key needed).

Live Muse Spark testing is M1B and requires separate approval.
