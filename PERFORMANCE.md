# Performance contract

The map must stay fast **no matter how much content gets added**. These rules are
enforced by `scripts/perf-budget.js`, which runs in the agent publish gate
(`scripts/publish-map-items.js`) and can be run by hand:

    node scripts/perf-budget.js

A budget breach blocks publish like a failing test. Raising a budget is allowed —
but do it in the same commit as the feature, with a comment saying why.

## The structural rules (why the budgets exist)

1. **Content rides existing rails; new content is data, not code.**
   New points of interest, sensors, and facts go through the map-items catalog /
   an existing generic layer + the Hawaiʻi browser. They must NOT add bespoke
   JS, new timers, or new map layers per topic. One new *kind* of thing may
   justify one new layer — one new *instance* never does.

2. **The sidebar renders lazily — keep it that way.**
   `renderHawaiiBrowser()` materializes DOM only for the open tab and open
   categories. The catalog can hold thousands of items at O(open items) DOM
   cost. Never render a hidden tab or a closed category's items eagerly.
   (Before this rule the sidebar held ~23,000 DOM nodes at idle; after, <1,000.)

3. **Symbol layers over DOM markers.**
   MapLibre symbol layers with shared vendored Twemoji sprites
   (`data/twemoji/`, `TWEMOJI` map, `ICON_SIZE` ramps) render thousands of
   icons on the GPU. DOM markers (`new maplibregl.Marker`) cost layout per
   marker per frame — they are reserved for the few hand-animated pieces
   (water wheels, wind turbines, solar suns, observatory rigs). Budgeted.

4. **Timers are shared, not sprouted.**
   New data should piggyback on an existing poll cycle or the SSE channel.
   Every `setInterval` runs forever on every visitor's battery. Budgeted.

5. **Payloads are budgeted and cacheable.**
   API responses get gzip + ETag/304 automatically (`endMaybeGzip`). Keep
   individual payloads under ~2 MB; ship coordinates/polylines compactly;
   never embed images in JSON (URL + lazy `<img loading="lazy">` on demand).

6. **Server bandwidth is metered (Render free tier).**
   Pollers that only serve eye-candy must be idle-gated via `clientsActive()`.
   Backups are incremental shards — see `backup.js`. Details in
   `~/.claude` memory `render-bandwidth` and comments in `heleon-server.js`.

7. **Map gestures shed non-essential work — keep it that way.**
   While the user is panning/zooming (`movestart`/`zoomstart` → `moveend`/`zoomend`),
   the client pauses chevron GeoJSON rebuilds, DOM bus-glide loops, hover hit-tests,
   and hides route pills / trail overlays. **Do not** toggle hillshade/topo visibility
   during gestures — that forces a full DEM recompute. Tiles use `prefetchZoomDelta`
   and `refreshExpiredTiles: false` so panning loads only new tiles, not the whole map.
   New per-frame work must respect `mapGesturing()` the same way hover handlers do.

8. **Every site of interest deserves a photo + history card.**
   Named map pins must be in the agent catalog and enriched per
   `scripts/agent/ENRICHMENT_POLICY.md`. Image URLs + text summaries only — never
   embed binaries in JSON. The agent must not publish photo-less cards when sources
   exist; deeper research retries are preferred over thin placeholders.

## Current measured baseline (2026-07-08, production)

- DOM nodes at idle: ~4,000 (map) + <1,000 (sidebar collapsed lists)
- Map: ~104 layers / 57 sources, 42 DOM markers
- Long tasks: target zero >100 ms in steady state
- Page: 583 KB raw → ~158 KB gzipped, loads in ~1 s
