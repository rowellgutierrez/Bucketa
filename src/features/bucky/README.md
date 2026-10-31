# Bucky 3D

Bucketa's 3D mascot runtime: an opaque **Normal** Bucky for general
mascot locations and a translucent **Savings** Bucky with internal 3D
coins, used only for Personal Finance savings goals.

## Files

- `Bucky3D.tsx` — React wrapper. Each mounted instance owns its own
  renderer, scene, and controller; it pauses when off-screen, honours
  `prefers-reduced-motion`, and disposes all WebGL resources on unmount.
- `BuckyController.js` / `BuckyController.d.ts` — DOM-free animation and
  state controller. All 50 GLB clips (emotions, gestures, talking,
  blinking) are reachable through `play`, `setEmotion`, `setGesture`,
  and the confirmed financial-event API.
- `runtime/savings.js` — savings progress state. Percentages are always
  supplied by the application (never calculated here); success reactions
  require confirmed events and are deduplicated by event ID.
- `runtime/savings_surface.js`, `runtime/coin_pile.js` — per-instance
  translucent body treatment and the deterministic internal coin pile
  (one instanced draw call).
- `runtime/accessories.js` — runtime accessory registry (procedural
  geometry, off by default).
- `Bucky3D.css` — canvas container styles.

## Asset

The model lives at `src/assets/bucky.glb` and is bundled through
Vite's asset pipeline (single production asset; 50 animation clips). The 2D SVG mascot
in `src/components/Bucky.tsx` remains only as a loading/WebGL-failure
fallback via `src/components/BuckyMascot.tsx`.

## Licensing

Rendered with Three.js (MIT License, (c) Three.js contributors,
https://threejs.org), installed as the `three` npm dependency. The Bucky
character model is an original Bucketa project asset.
