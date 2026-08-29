# Architecture GIF — generator

Source of the animated architecture diagram used as the README hero image. Edit the scene here and
re-render; [`../architecture-dark.gif`](../architecture-dark.gif) and
[`../architecture-light.gif`](../architecture-light.gif) are build artefacts of these two files.

A GIF cannot respond to `prefers-color-scheme`, so the scene is drawn once per theme and the README
picks between the two files with a `<picture>` element.

- `architecture.html` — the scene. A canvas animation that exposes `window.__render(t)`, drawing
  the frame at loop phase `t` in `[0, 1)`, and `window.__setTheme('dark' | 'light')`. Deterministic:
  the same `t` always draws the same pixels, so re-rendering is byte-reproducible. Open it in a
  browser to watch it live while editing — it follows the browser's colour scheme, and `?theme=light`
  forces one.
- `render.mjs` — captures the frames per theme through headless Chrome and encodes both GIFs
  (global palette shared across the whole loop; pixels equal to the previous frame are written as the
  transparent index with disposal 1, which is what keeps a 1280x768 loop small).
- `package.json` / `package-lock.json` — the two pinned dev dependencies, `puppeteer-core` and
  `gifenc`. `node_modules/` is git-ignored; run `npm install` here once. Rendering needs Google
  Chrome installed (override its path with `CHROME=...`). Nothing in the engine, the Coordinator, or
  `gatewayd` depends on any of this.

## Regenerate

```bash
cd doc/animations/src && npm install      # once
node doc/animations/src/render.mjs        # writes ../architecture-{dark,light}.gif
THEME=light node doc/animations/src/render.mjs      # one theme only
FRAMES=120 DELAY=6 COLORS=160 node doc/animations/src/render.mjs
```

## What the scene shows

One loop is one transaction scope, told in eight phases: `PLAN`, `ADMIT`, `CLAIM`, `TRY`, `BARRIER`,
`PIVOT`, `CONFIRM`, `COMMITTED`. Reading top to bottom, the bands are the planner and the check-rules
gate ([02 §3.4](../../design/02-transaction-model.md)), the append-only event log
([01](../../design/01-jit-dag-and-event-log.md)), the two executors and the split the database
enforces between them ([07 §5](../../design/07-distributed-transaction-coordinator.md)), `gatewayd`
([09](../../design/09-tool-registry-gateway.md)), the four SDK-built tool services, and the
pivot-saga ribbon with its one-way gate ([02 §1](../../design/02-transaction-model.md)).

## Editing the scene

Everything lives in `architecture.html`: `C` (the palette), the band constants (`B1_Y`, `LOG_Y`,
`EX_Y`, `GW_Y`, `SV_Y`, `TX_Y`, and the distributor bars `BAR1_Y`, `BAR2_Y`, `FAN_Y`), `SERVICES`,
`EVENTS` and `APPEND` (the log), `MS` (the ribbon milestones), `TL` (the animation windows in
normalised loop time), and `narration()` (the caption per phase).

Every colour used while drawing must come from `C` (the active theme) — a literal like
`rgba(34,211,238,…)` silently leaks dark-theme values into the light render. Faint overlay fills go
through `veil(a)`, and glow intensity is scaled by `C.glow` so the light theme does not haze.

Three invariants keep the loop seamless:

- the log slides exactly `APPEND.length` pitches over one loop while the head advances exactly that
  many events, and `EVENTS` has the same length, so every tile has the same label and the same
  position at frame 0 and at the end;
- no absolute `stream_seq` is painted on a tile, so nothing visibly resets at the seam — the head
  and the backtrack floor are markers, not numbers;
- everything the ribbon lights up is faded back out by `TL.reset`, which is how the closed one-way
  gate returns to open without ever being animated open.

Keep the background fully static — every animated pixel costs GIF bytes.
