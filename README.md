# Bucketa — Brand Foundation

Smart Buckets. *Everything in one bucket.*

Personal finance, sales, expenses, inventory, and salaries — organized in one calm, clear place.

## What this is (hackathon build)

Bucketa is a local-first small-business finance app with an AI assistant (“Bucky”):

- **Dashboard, Buckets, Transactions, Personal, Employees/payroll, POS, Products** (with barcode labels/scanning), and a **Smart Scan** receipt/record scanner.
- **Bucky assistant** — answers and proposes record actions from your actual local records. By default Bucky is **deterministic and fully offline** (computed in code, labelled `deterministic-fallback` / `deterministic`); it never invents financial data.
- **Optional live Meta AI** — text reasoning (`muse-spark-1.3`) and Creative Studio image editing (`muse-image-1.0`) via the Meta Model API. Live mode is **off by default, triple-gated, capped at 3 requests per server session, and not yet verified against a real account** (see “Live-test blockers” below). No live call is made just by opening the app.
- **Creative Studio** — gated Muse Image editing. There is no mock/fake generation: a non-live request is refused rather than presenting a fake image as AI.

Business data is stored locally in the browser (IndexedDB, plus localStorage/sessionStorage for small preferences/handoffs). There is no hosted database and no Bucketa account. Uploaded scan images exist only in server memory during a request and are never written to disk or logs.

## Architecture

```text
Browser (React + TypeScript + Vite, http://localhost:5173)
  └─ /api/*  ──Vite proxy──▶  Local Node server (http://127.0.0.1:8787, server/server.mjs)
                                ├─ mock / deterministic paths (default, offline, free)
                                └─ gated live path ──▶ https://api.meta.ai/v1/responses
                                     models: muse-spark-1.3 (text/vision), muse-image-1.0 (image edit, unverified)
```

The Meta API key lives **only** on the local Node server. It is never sent to the browser, never put in a `VITE_*` variable, and `/api/health` reports only whether it is configured (yes/no) — never its value.

---

## Judge setup — offline demo (recommended, no key, no cost)

Requires Node.js 20+ (developed on Node 26 / npm 11). No Meta account, API key, or `.env` file is needed for this path, and it makes **zero paid API calls**.

```powershell
# Terminal 1 — local backend (mock/deterministic by default)
npm install
npm run server

# Terminal 2 — frontend
npm run dev
```

Then:

1. Open the URL Vite prints (default **http://localhost:5173/**).
2. Optional sanity check (Terminal 3): `npm run health` — or open http://127.0.0.1:8787/api/health . Expected shape (values of the booleans depend on your local `.env`, which judges do not need):

   ```json
   { "ok": true, "mode": "mock", "defaultMode": "mock",
     "liveMeta": "disabled",
     "liveRequestsUsed": 0, "liveRequestsLimit": 3,
     "buckyAdvise": { "liveCompatibilityVerified": false } }
   ```

3. Use the app: explore the demo/local records, ask Bucky a question (deterministic offline answer), and run Smart Scan in mock mode. Everything in this path works without network access to Meta.

Production build check: `npm run build`, then `npm run preview`.

## Judge setup — optional live Meta test (bring your own key)

> ⚠️ This may incur Meta API charges on **your** account, and live compatibility is **not yet verified** (below). Do not do this unless you explicitly want a controlled live test. **No key is provided with this repository** — never ask for, share, paste into chat, or commit a real key.

1. Copy the example file and edit the copy only: `Copy-Item .env.example .env`
2. In `.env` set, locally and server-side only:
   - `MODEL_API_KEY=` — your own Meta Model API key.
   - `ENABLE_LIVE_META=1` — must be exactly `1`.
   - `LIVE_TEST_TOKEN=` — a separate random local token (not your Meta key). Generate one locally, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, and paste the output only into your local `.env`.
   - `PORT=8787` (default; change only if 8787 is taken).
3. Restart `npm run server`, then run `npm run health`. Live is armed only when it reports `"liveMeta": "enabled-gated"` and `"modelApiKeyConfigured": true` — this still makes **no** Meta call.
4. A live call happens only when, inside the app, you explicitly choose a live/“Try AI” action and type the same `LIVE_TEST_TOKEN` value at runtime (sent as the `x-bucketa-live-test` header; never stored, pre-filled, or logged), or a live Creative Studio generate. Each attempt counts against the shared **3-requests-per-server-session** cap (no automatic retries; restart the server to reset the counter). Expect a safe diagnostic/fallback — not a guaranteed answer — until the blockers below are cleared.

Meta configuration is fixed in server code, not env vars: base URL `https://api.meta.ai/v1`, endpoint `/responses`, text/vision model `muse-spark-1.3` (`server/metaClient.mjs`), image model `muse-image-1.0` (`server/creativeImage.mjs`). There is deliberately no env override for the model or base URL.

## Secret safety

- `.env` (and every `.env.*` except `.env.example`) is git-ignored, as are `*.pem`, `*.key`, `*.p12`, `*.pfx`, and credential JSON files. `.env.example` contains **names and empty values only**.
- Never create `VITE_MODEL_API_KEY` or any browser-visible key — anything `VITE_*` is shipped to every browser.
- `MODEL_API_KEY` and `LIVE_TEST_TOKEN` are distinct: the first authenticates to Meta; the second only authorizes a human-approved live attempt against your local server. Keep both server-side, on localhost only (the server binds `127.0.0.1`; it has no auth of its own and must not be exposed to a network).
- Server logs and health/error responses never contain keys, tokens, request/response bodies, images, or model output — only safe diagnostic categories/statuses. Tests use fictional keys such as `test-key-not-real` and fictional financial records only.
- If a real key was ever committed or shared, rotate it in the Meta dashboard — deleting the file does not revoke it.

## Offline verification (no key, no paid calls)

```powershell
npm test            # server tests + data tests + lib tests + typecheck (all offline, mocked fetch)
npm run typecheck   # TypeScript only
npm run build       # typecheck + production build into dist/
```

Test suites are enumerated by glob (`server/tests/*.test.mjs`, `src/lib/*.test.ts`, `src/lib/*.test.mjs`, `src/data/validation.test.ts`) so new test files are picked up automatically. See `server/README.md` for endpoints, body/image caps, and the live-gate details.

## Live-test blockers (honest status)

1. **Live Meta inference is unverified.** Request builders for `muse-spark-1.3` (extraction, Bucky advice, Bucky interpret, product analysis) are unit-tested against mocked envelopes, but no successful real-account live response has been confirmed (`liveCompatibilityVerified: false` in `/api/health`). A first controlled test may return a safe diagnostic (e.g. auth/endpoint/envelope category) plus the labelled deterministic fallback.
2. **Muse Image account access is unverified.** `muse-image-1.0` support and the exact generated-image field in a real response envelope are unconfirmed for the configured account (`IMAGE_EDITING_VERIFIED = false`); the parser accepts only a genuine PNG from expected shapes and fails safely otherwise.
3. **A judge-supplied key is required for any live test.** None is shipped, and this readiness pass deliberately made **no** paid Meta calls, so blockers 1–2 cannot be cleared offline.
4. **Browser speech is provider-dependent.** Bucky voice uses the browser’s SpeechRecognition/speechSynthesis (not a Meta speech API); Filipino recognition varies by browser.

## Official branding

| File | Role |
|---|---|
| `assets/bucketa-logo-primary.png` | Official website and application logo. Navy B on a white background. |
| `assets/bucketa-favicon.png` | Official browser tab favicon. White B on a navy background. No wordmark. |
| `assets/bucketa-approved-logo.png` | Original approved branding reference (full lockup with wordmark). Preserved unchanged locally; not used for display. |

Do not modify, resize, recolor, overwrite, or regenerate any of these source images. Use the supplied images rather than recreating the logo with CSS or SVG. The primary logo has a baked-in white background and no transparency, so use it on light backgrounds only.

**Asset inclusion (GitHub):** in a future reviewed commit, `bucketa-logo-primary.png` and `bucketa-favicon.png` will be included so a cloned app displays correctly. `bucketa-approved-logo.png` stays local-only and is excluded by `.gitignore`.

## Files
- `index.html` — Vite entry page
- `src/` — React application: shell, navigation, pages, Bucky assistant, `src/lib/currency.ts` (multi-currency integer minor-unit formatting, PHP default)
- `server/` — local Node backend (mock-first, gated live Meta); see `server/README.md`
- `.env.example` — environment variable names only; copy to `.env` for local live testing
- `assets/bucketa-logo-primary.png` — official website/application logo (included in a future commit)
- `assets/bucketa-favicon.png` — official browser favicon (included in a future commit)
- `assets/bucketa-approved-logo.png` — original approved branding reference (preserved locally, excluded from Git)
- `css/tokens.css` — reusable design-system variables (light + dark), used by the app
- `css/preview.css` — original static preview styles, preserved unchanged
- `brand/BRAND.md` — color/typography/logo-usage reference
- `archive/` — previous SVG logos, logo proposals, comparison page, generated reference images, and the archived static branding preview (`archive/brand-preview-v1/`). Preserved locally only; excluded from GitHub by `.gitignore`. Not official assets.

Fonts: Plus Jakarta Sans loads from Google Fonts; offline it falls back to Segoe UI / system-ui.
