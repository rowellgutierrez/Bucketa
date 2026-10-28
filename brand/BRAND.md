# Bucketa — Brand Reference

**Brand message:** Smart Buckets. · **Tagline:** Everything in one bucket.

**Description:** Personal finance, sales, expenses, inventory, and salaries — organized in one calm, clear place.

## Logo

Bucketa has three official branding files. The mark in each is a capital **B** with three ascending bars and an upward curve.

| File | Role | Format | Dimensions | Size | SHA-256 |
|---|---|---|---|---|---|
| `assets/bucketa-logo-primary.png` | Official website and application logo. Navy B on a white background. | PNG, RGB, 8-bit, no transparency | 887 × 887 px | 438,341 bytes | `8FE4277181CCF4730C5BB73C2E1F4ECD6E7BC2EAA8338A300C7EF905160BB880` |
| `assets/bucketa-favicon.png` | Official browser tab favicon. White B on a navy background. No wordmark. | PNG, RGB, 8-bit, no transparency | 887 × 887 px | 472,472 bytes | `5AF57FC801F30562F2520D7E00EF9D8455B9A686F3E4151CE47CAAC4F4E00612` |
| `assets/bucketa-approved-logo.png` | Original approved branding reference (B + "Bucketa" wordmark). Preserved unchanged locally; not used for display; not included in the Git repository. | PNG, RGB, 8-bit, no transparency | 1254 × 1254 px | 1,136,075 bytes | `BD8E4E3B2DECA421B6BE141BE163CBF230323F04B0A58F0C20FA7971567B422E` |

Rules: never stretch, recolour, redraw, rename, resize, crop, overwrite, or replace any of these files. Use the supplied images rather than recreating the logo with CSS or SVG. Do not substitute previous archived logo concepts. The primary logo's white background is baked in, so use it on light backgrounds only. Do not create transparent, SVG, cropped, or resized versions without separate approval.

Colour decision: the official Bucketa brand navy is `#014184`, approved by the project owner (Option A). It was verified by image sampling of the primary logo (dominant `#014184`, cluster `#014083`–`#014185`) and is the canonical navy for tokens, documentation, and future application branding. The preserved approved reference PNG contains an earlier sampled navy (`#01366D`); it remains unchanged as a reference and is not a colour source.

Previous SVG logos, concept proposals, and the comparison page are superseded. They are preserved locally in `archive/`, are excluded from GitHub, and must not be used as official assets.

## Colors

Official brand colour:

| Token | Hex | Role |
|---|---|---|
| Navy 900 | `#014184` | Official brand navy; primary surfaces, active navigation/filter state |

Interface tokens (used by the preview UI only; these blues and surfaces are not colours in the logo):

| Token | Hex | Role |
|---|---|---|
| Navy 950 | `#07182E` | Dark-mode background |
| Navy 800 | `#10365E` | Dark-mode surface 2 |
| Blue 600 | `#2563EB` | Primary buttons / links |
| Blue 700 | `#1D4ED8` | Button hover |
| Sky 400 | `#38BDF8` | Accent |
| Background | `#F4F8FC` | Light app background |
| Surface 2 | `#EDF3F9` | Light panels |
| Text 2 | `#486581` | Secondary text |
| Border | `#D9E4F0` | Dividers, inputs |
| Success / Warning / Danger | `#0E9F6E` / `#D97706` / `#DC2626` | Status only |

Dark mode: bg `#07182E`, surface `#0C2A4D`, surface-2 `#10365E`, text `#F2F7FC`, text-2 `#A9C2DC`, border `#1E4A75`.

## Typography
- **Plus Jakarta Sans** (400/600/700/800) — display and body. Loaded externally from Google Fonts; not bundled locally.
- Fallback if offline: `"Segoe UI", system-ui, sans-serif` (Segoe UI ships with Windows; system-ui covers macOS/Linux).
- Scale: 32/24/19/16/13 px, headings 700–800, body 400, labels 600.

## Generated references
`archive/generated_images/` holds the three generated reference concepts used as direction only. They are not production assets and are excluded from GitHub.
