# Map enrichment policy

Every **named site of interest** on the Hawaiʻi tracker map should carry rich
context — a real photo and a sourced historical narrative — wherever credible
material exists. This is a core product goal, not optional polish.

## What “enriched” means

Each catalog item has two tiers:

### Publishable (minimum bar)

The agent **may publish** an item when it has:

1. **Summary** — at least 40 characters of factual context.
2. **History** — at least **2 dated events** (`year`, `text`, `source` URL).
3. **Photos** — at least **1 verified image** (`url`, `credit`, `caption`).
4. **Links** — pointers to Wikipedia, official sites, or primary sources.

Published items that meet only the minimum are marked **`enrichment.status: partial`**
and **`status: partial`** in `data/map-items.json`. They stay on the research queue.

### Complete (target quality)

An item is **complete** when it also has:

- **Summary** — 120+ characters (1–3 substantive sentences).
- **History** — **4+ dated events** from researched sources.
- **Photos** — **2+ on-topic images** when available.

Shallow one-liners, logo-only images, and empty timelines are **not publishable**.
When a first pass fails the minimum, the item stays on the queue for retry.
When a partial item is published, the agent **cycles back** every ~6 hours
(`AGENT_PARTIAL_RETRY_MS`) with deeper research (more articles, web sources,
extra Commons queries) until complete or sources are exhausted.

## What must be enriched

The agent catalog (`scripts/lib/item-catalog.js`) is the work queue. It must cover
**every layer where a human would tap a pin and expect to learn something**:

| Map layer / source | Catalog prefix | Notes |
|--------------------|----------------|-------|
| Summit observatories | `summit:` | Telescopes, MLO |
| LCO remote sites | `lco:` | |
| Ocean buoys & tides | `ocean:` | |
| Power plants / renewables | `power:` | Also see `asset:` |
| Volcano webcams | `volcano:` | |
| Satellites (named) | `sat:` | |
| Air quality towns | `airquality:` | Town history, not just AQI |
| Neighbor-island landmarks | `maui:`, `oahu:`, `kauai:`, `molokai:`, `lanai:` | |
| Heritage & ancient sites | `heritage:` | All entries in `data/heritage-sites.json` |
| Transit hubs & P&R | `hub:`, `pnr:` | |
| Airports | `airport:` | |
| Traffic sensors (named) | `sensor:` | Road/place history |
| Bikeshare systems | `mobility:` | HIBIKE, Biki + notable docks when feasible |
| Curated asset media | `asset:` | `data/asset-media.json` |
| Category primers | `category:` | Repeaters, cell towers, gas stations |

**Do not** add one map layer per agent topic. New *instances* ride existing generic
layers; new *kinds* may justify one new layer (see `PERFORMANCE.md`).

### Priority order when the queue is long

1. Items with **no entry** (`missing`)
2. **Partial** items already published but below complete quality (`partial`)
3. Items **missing photos** or with fewer than 2 history events (`insufficient`)
4. **Heritage sites** and **neighbor-island landmarks** (highest visitor value)
5. **Stale** entries past `AGENT_STALE_DAYS`
6. Category-level primers last

## Research depth

- Start with Wikipedia + Wikimedia Commons (keyless, reliable).
- If thin: try alternate titles, disambiguation pages, NRHP/NPS pages, university
  archives, state/county historic registers, `.edu` / `.gov` sources.
- For Hawaiian cultural sites: prefer accurate, respectful sourcing; include
  pre-contact and Kingdom-era context when documented.
- For infrastructure (plants, buoys, sensors): cover **why it was built**, major
  incidents, and its role on the island — not only technical specs.
- **Never** fabricate years, quotes, or events. Skip and retry later rather than
  publish guesswork.

## Images

- Every card should show at least one **on-topic photograph** (not a map tile,
  logo, or unrelated stock image).
- Vision verification (`AGENT_VERIFY_IMAGES`) is on by default — a wrong photo is
  worse than no photo, but **no photo is a queue failure** that must be retried.
- Multiple angles or era photos (historic + modern) are welcome when available.

## Client wiring

Enriched entries render via `itemLoreHtml(key)` on map click-cards. When adding a
new clickable layer, add a `loreKey…()` helper and append `itemLoreHtml(...)` to
that layer's card builder.

## Audit & publish

- `npm run audit-map-items` — lists gaps vs. the catalog.
- Research agent stages to `data/map-items.staged.json`.
- Publish gate (`scripts/publish-map-items.js`) runs tests + smoke + perf budget.
- Only merged PRs update production `data/map-items.json`.
