# Bucketa Server

Local Node.js backend for Bucky Financial Intelligence, the Bucky Record Scanner, product photo analysis, and Bucky Creative Studio.

**Live Meta calls require:** `ENABLE_LIVE_META=1`, a server-side `MODEL_API_KEY`, and a local request context — the server binds `127.0.0.1` only and any browser `Origin`/`Host` must be loopback (`server/liveGate.mjs`). There is **no user-entered temporary token** and **no application-imposed per-session request cap**: repeated live requests are allowed, bounded only by the caller's own Meta API account limits, credits, and provider rate limits. Each request makes exactly one upstream attempt (no automatic retries). When live is not configured, Bucky returns a clearly labelled deterministic fallback and the scanner/creative endpoints refuse before any paid call rather than fabricating results. Mock extraction exists only for automated tests.

## Run

```text
npm run server
```

Listens on `http://127.0.0.1:8787` (set `PORT` to change). Keep it on localhost only — this backend has no public-internet authentication, CORS alone is not authentication, and it must not be exposed to a network. A public deployment would need real authentication in front of these endpoints.

Environment variables (see `.env.example`): `MODEL_API_KEY` (server-only; only reported as configured yes/no), `ENABLE_LIVE_META` (exactly `1` arms live mode), `PORT`. Starting `npm run server` loads the project-root `.env` automatically. No other credential is used; an old `LIVE_TEST_TOKEN` line is ignored.

## Endpoints

- `GET /api/health` → `{ ok, modelApiKeyConfigured, liveMeta: "enabled" | "disabled", buckyAdvise: { endpoint, defaultSource, liveModel, liveCompatibilityVerified: true }, creativeImage }`. `liveCompatibilityVerified` is scoped to the Bucky advice endpoint only: a real live Bucky Financial Intelligence conversation with `muse-spark-1.3` was manually verified by the developer. Health never returns key values and reports no request quota because Bucketa imposes none.
- `GET /api/creative/status` → Muse Image (`muse-image-1.0`) availability. A successful real live generation was reported by the developer on 2026-11-03; other accounts need their own image-model access.
- `POST /api/extract` with JSON `{ imageBase64, mediaType, expectedCurrency, recordType, mode }` → validated draft entries with integer minor-unit amounts, app-computed totals, and `needsReview` flags. `mode` must be `"live"` (the gated Meta path); missing, invalid, or `"mock"` modes are rejected with `invalid_request` and no entries are returned. Mocked Meta responses exist solely inside automated tests, which stub the upstream fetch.
- `POST /api/bucky/advise` with JSON `{ question, mode, summary }` → advice. `summary` is the aggregated summary shape only (raw records/descriptions are rejected); body capped at 16,384 bytes. `mode: "live"` requires the live gate; model output is validated (action allowlist, grounded-numbers check) and evidence is always recomputed server-side. Failures return the labelled deterministic fallback with a safe diagnostic — never a trusted unvalidated answer.
- `POST /api/bucky/interpret` with JSON `{ text, mode, context }` → a strictly validated structured proposal (names-only context), cross-checked again in the browser before any preview. Nothing here writes data.
- `POST /api/products/analyze` with JSON `{ imageBase64, mediaType, mode }` → an editable product draft (visual fields only; never price/stock). Live mode uses the same live gate.
- `POST /api/creative/edit` with JSON `{ imageBase64, mediaType, prompt, history, mode: "live" }` → one Muse Image edit. Only a validated genuine PNG data URL reaches the browser; non-live requests are refused (501) before any Meta call.

## Safety rules

- The Meta API key lives only on this server. It is never sent to the browser, never a `VITE_*` variable, and never logged or returned.
- Uploaded images exist only in memory during the request. Nothing is written to disk or logs; logs hold only method, path, status, duration, and entry count.
- Request bodies are capped while streaming (7.5 MB for scanner uploads; 16,384 bytes for Bucky advice), and decoded images are capped at 5 MB. Image type is verified from the file bytes, not the declared type. Upstream Meta responses are capped by byte length.
- The selected profile/bucket `expectedCurrency` is authoritative. A conflicting detected currency is flagged, never adopted.
- Missing or uncertain fields are marked `needsReview`. Totals are summed in code from integer minor units; model-supplied totals are ignored.
- Errors returned to clients are fixed safe strings. Internal errors, credentials, upstream bodies, and stack detail are never exposed.
- Voice uses the browser's SpeechRecognition/speechSynthesis (not a Meta speech API); every financial write still requires a separate in-app confirmation.
- Tests use fictional records and mocked Meta fetch only: `npm run test:server` (offline, no API key, no paid calls).
