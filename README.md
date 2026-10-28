# Bucketa — Brand Foundation

Smart Buckets. *Everything in one bucket.*

Personal finance, sales, expenses, inventory, and salaries — organized in one calm, clear place.

## Status

M0 foundation: a React + TypeScript + Vite application shell with nine navigation placeholders. No financial features, database, or Meta AI connection are implemented yet. Placeholders never present invented financial data.

## Run locally

```text
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173/) in a browser.

Other commands: `npm run typecheck` (TypeScript check), `npm run build` (production build into `dist/`).

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
- `src/` — React application: shell, navigation, placeholder pages, `src/lib/currency.ts` (multi-currency integer minor-unit formatting, PHP default)
- `assets/bucketa-logo-primary.png` — official website/application logo (included in a future commit)
- `assets/bucketa-favicon.png` — official browser favicon (included in a future commit)
- `assets/bucketa-approved-logo.png` — original approved branding reference (preserved locally, excluded from Git)
- `css/tokens.css` — reusable design-system variables (light + dark), used by the app
- `css/preview.css` — original static preview styles, preserved unchanged
- `brand/BRAND.md` — color/typography/logo-usage reference
- `archive/` — previous SVG logos, logo proposals, comparison page, generated reference images, and the archived static branding preview (`archive/brand-preview-v1/`). Preserved locally only; excluded from GitHub by `.gitignore`. Not official assets.

Fonts: Plus Jakarta Sans loads from Google Fonts; offline it falls back to Segoe UI / system-ui.
