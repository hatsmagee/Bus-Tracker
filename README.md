# 🚌 Hele-On Bus Live Tracker

A live bus tracking dashboard for the Hele-On Bus system (County of Hawai'i),
built on top of the Syncromatics transit management API. Self-hosted, runs
entirely on your own machine — no cloud dependency, no API hammering.

## What it does

- **Whole-fleet live positions** (per-route vehicle endpoint, with real speed +
  heading), on a MapLibre map, color-coded by route. Buses ride their **snapped
  route polyline**, advancing forward at their real pace between polls — smooth,
  never reversing, no drift when stopped. Markers stay upright, fan out when they
  overlap, and fade to a ghost (kept up to 2 days) when their GPS goes quiet.
- **Official predicted arrivals** from the GTFS-realtime TripUpdates feed as the
  headline ETA, with a transformer learning a correction on top
- **Schedule adherence** (ahead/behind) with a sanity guard against bad matches
- **Colored-roadway route lines** — every route is snapped onto a routable
  graph built from a local OpenStreetMap road extract for Hawai'i Island, then
  stitched along real road segments via shortest-path, so a drawn line is
  composed entirely of actual road geometry (it can't diagonal-cut across a
  block — see `road-graph.js` / `scripts/snap-routes-to-roads.js`). Where
  routes share a road, they draw as clean parallel lanes; honest gaps in OSM
  coverage break the line rather than bridging it with a straight one.
- **Animated direction chevrons** streaming ahead of each bus along the real
  road, route-colored, pointing the way it's about to go
- **Official bus stops** + **learned "observed" stops** — places buses repeatedly
  dwell that aren't published (recurrence-filtered, not red lights / yards)
- **Microclimate weather** symbol over each bus (Open-Meteo, free, no API key)
- **Occupancy bar** on each bus icon
- **Fleet tab** — every vehicle the agency knows (live / idle / dormant) with
  full telemetry and a derived status explaining why each is/isn't on the map
- **Boats tab** — live vessel positions via [aisstream.io](https://aisstream.io)
  AIS stream (opt-in via `AISSTREAM_API_KEY`; no fabricated data when off).
  AIS shore-receiver coverage around the island is genuinely sparse, so a
  zero-count is honest, not broken.
- **Aircraft tab** — live ADS-B positions from community aggregators
  ([adsb.lol](https://adsb.lol) → airplanes.live → adsb.one, all keyless), with
  aircraft type + tail number; OpenSky anonymous tier as fallback
- **Every keyless real-time Big Island feed we could find** — see the
  [data sources](#real-time-data-sources) table below: streamflow water wheels,
  NWS weather stations, summit observatories, ocean buoys + tides + DART
  tsunami buoy, air quality / vog, volcano alerts + live webcams, METARs,
  APRS ham radio, Meshtastic LoRa mesh nodes, ham repeaters
- **Transformer ETA correction model** (12-token self-attention, per-rank
  output heads) retrained server-side on every recorded stop arrival
- **Long-term arrival patterns** — 7×24 day-of-week × hour-of-day matrix per
  stop, served from 1 year of stop_arrivals history
- Desktop + mobile (bottom-sheet) responsive UI; polling pauses when hidden

## Real-time data sources

Everything below is free and needs **no signup and no API key** (except AIS,
noted). All of it is polled server-side, cached, and served from `/api/*`.

| Layer | Source | Endpoint | Notes |
|-------|--------|----------|-------|
| Buses — Hawaiʻi Island | Hele-On (`myheleonbus.org`) | `/api/vehicles?island=big-island` | road-snapped routes, transformer ETAs, SQLite history |
| Buses — Kauaʻi | The Kauai Bus (`thekauaibus.com`) | `/api/vehicles?island=kauai` | keyless Syncromatics GTFS-RT + RTPI |
| Buses — Maui | Maui Bus (`mauibus.org`) | `/api/vehicles?island=maui` | keyless Syncromatics GTFS-RT + RTPI |
| Island catalog | all keyless bus systems | `/api/islands` | bbox, map center, API map, live counts |
| Bikeshare (HIBIKE + Biki) | PBSC GBFS v3 — Big Island + Honolulu | `/api/mobility`, `/api/hibike` | keyless; dock bike/dock counts (not per-bike GPS) |
| APRS trackers | aprs2.net (ham radio positions) | `/api/aprs` | keyless RX; vehicles/boats/weather beacons statewide |
| Route ribbons | GTFS shapes matched to OSM roads | `/api/route-edges`, `/api/route-roads` | 25 routes, colors the actual road via feature-state |
| Aircraft | adsb.lol → airplanes.live → adsb.one (community ADS-B) | `/api/aircraft` | keyless; OpenSky fallback |
| Vessels | aisstream.io AIS websocket | `/api/vessels` | bundled key; sparse mid-ocean coverage is expected |
| Streamflow | USGS NWIS instantaneous values + daily statistics | `/api/streamflow`, `/api/streamflow-stats`, `/api/gauge-history` | animated water wheels, level meters, historical graphs |
| Weather stations | NWS `api.weather.gov` observations | `/api/weather-stations` | User-Agent header only |
| Summit observatories | MKWC (Maunakea telescopes) + NOAA GML MLO met & daily CO₂ | `/api/summits` | CFHT, Keck, Subaru, IRTF, JCMT, VLBA, Hale Pōhaku + Mauna Loa Keeling Curve |
| Ocean | NDBC buoys (incl. Hilo Waverider), NOAA CO-OPS tides, DART 51407 tsunami buoy | `/api/ocean` | wave height/period, next high/low tides, deep-ocean water column |
| Marine | Aqualink reef cams + Sofar spotters, NOAA FOSS landings | `/api/marine` | 🐠 reef livestreams (MEGA Lab), 🌡️ sensors, 🎣 commercial catch summaries |
| Grid & telecom | HECO plant list + OSM power lines, PeeringDB colo/IX, OSM cell towers | `/api/infrastructure` | static reference — no live Hawaiʻi Island MW or cell-load API |
| Local & community | AAA fuel averages, OSM gas stations, HDOT AADT, Blyncsy sensors, LCO telescopes, iNaturalist | `/api/local` | monthly gas (not live pumps); AADT static; Blyncsy = dashboard link only |
| Air quality / vog | Open-Meteo air-quality API | `/api/air-quality` | US AQI + PM2.5/PM10/SO₂ for 9 towns |
| Volcano | USGS HVO HANS alerts + live webcams | `/api/volcano` | Kīlauea/Mauna Loa color code + alert level, 8 live cams |
| METARs | NOAA Aviation Weather Center | `/api/metars` | PHTO Hilo, PHKO Kona, PHSF Bradshaw AAF (military) |
| APRS ham radio | APRS-IS TCP feed (`rotate.aprs2.net`) | `/api/aprs` | keyless RX-only login; real vehicles/stations/wx beacons |
| Meshtastic / LoRa | meshtastic.liamcottle.net node map + MQTT text messages | `/api/meshtastic`, `/api/meshtastic-detail`, `/api/meshtastic-feed` | LoRa mesh nodes; click card shows telemetry + live message stream |
| Ham repeaters | hearham.com open repeater list | `/api/repeaters` | 55 repeaters with frequency/offset/tone |
| Earthquakes | USGS FDSN GeoJSON | `/api/earthquakes` | Big Island bbox |
| Wildfire | NASA FIRMS hotspots | `/api/wildfire` | MODIS/VIIRS |
| NWS alerts + radar | api.weather.gov + Iowa State NEXRAD tiles | `/api/alerts` | |
| Traffic controls | OSM (Overpass) signals/stop signs | `/api/controls` | locations only — HDOT publishes no live SPaT for the island |

Things we investigated that **don't** exist publicly (so they're not faked):
live traffic-signal states (no HDOT SPaT feed), observatory/ranger vehicle GPS,
county taxis / paratransit / Uber-Lyft GPS feeds, Tesla/private fleet tracking,
real-time Hawaiʻi Island grid MW / fuel mix (HECO has no keyless feed; islandpulse.org is dead),
live cell-tower load or per-carrier coverage API (FCC maps are propagation models only),
per-pump live gas prices (GasBuddy GraphQL is not a public keyless API; we use AAA monthly regional averages).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser (heleon-tracker.html)                           │
│   - MapLibre GL map, smooth bus interpolation           │
│   - Sidebar with vehicle cards + scrubber timelines     │
│   - Tabs: Buses / Routes / Hawaiʻi / Agent / System / … │
│   - Event-driven self-refresh (SSE): reloads on deploy  │
└──────┬──────────────────────────────────────▲───────────┘
       │ HTTP /api/* (every 15s)     SSE /api/events (push)
┌──────▼──────────────────────────────────────┴───────────┐
│ Node.js server (heleon-server.js)                       │
│   - Positions from routes/{id}/vehicles (per route) —   │
│     real speed + heading + route; resilient last-known  │
│     cache so a bus never blinks out on a hiccup         │
│   - GTFS-realtime: VehiclePositions + TripUpdates for   │
│     active trip + official ETAs (gtfs-rt.js, no dep)    │
│   - Transformer ETA correction model (online SGD)       │
│   - Static GTFS loader (trips/stop_times/stops)         │
│   - Open-Meteo weather (batched, cached)                │
│   - SQLite (sql.js) with periodic prune + VACUUM        │
│   - Self-development agent (research → gate → deploy)   │
└────────────┬────────────────────────────────────────────┘
             │ HTTPS
   myheleonbus.org  (Syncromatics RTPI + GTFS-RT)  ·  open-meteo.com
```

## Quick start

```bash
# Install dependencies (one-time)
cd /path/to/code
npm install

# Run the server
npm start
# (or: node heleon-server.js)

# Open the dashboard
open http://localhost:8765/
```

## Configuration

Set environment variables before starting the server:

| Variable       | Default       | Description                          |
|----------------|---------------|--------------------------------------|
| `PORT`         | 8765 (local) / 10000 (Render) | HTTP port                            |
| `RENDER`       | unset         | When set by Render, the server stores SQLite + GTFS zip under `/tmp` (ephemeral disk) |
| `POLL_INTERVAL`| 15000 (ms)    | How often to poll the realtime feeds |
| `MAPTILER_KEY` | (built-in)    | MapTiler API key for basemap tiles   |

Open tabs **self-refresh on deploy**: the browser holds a Server-Sent Events
stream (`/api/events`) carrying the server's build id. When a new version goes
live the old process exits, the browser's `EventSource` reconnects to the fresh
one, sees a new build id, and reloads — event-driven, no polling. The build id
is the deploy's git commit (falling back to a hash of the HTML + map data, so a
data-only deploy still triggers a refresh).

## Self-development agent

A keyless research agent that keeps the map's item cards (history, photos,
summaries) growing on their own. When enabled it **researches continuously**,
and once it has vetted new material it runs a full test gate and ships a PR that
auto-deploys on Render — so the app keeps evolving with no one at the keyboard.
**Off by default** (`AGENT_ENABLED=false`) until you switch it on.

### The loop

```
always-on research → stage findings → PRE-PUSH GATE → PR → merge → deploy → tabs self-refresh
   (every 10 min)                     unit + smoke + boot
```

1. **Research** — every `AGENT_RESEARCH_INTERVAL` (default 10 min) the server
   audits the item universe, picks what's missing/stale/thin, gathers real
   sourced content (DuckDuckGo, Wikipedia, Wikimedia Commons, Jina Reader) and
   synthesizes a card via AI Horde. Results are *staged*, never live yet.
2. **Gate** — before anything touches `main`, `npm test` (unit suite) → smoke
   test (schema + image liveness + `node --check`) → a real server boot on a
   throwaway port that must serve `/healthz` + `/api/map-items`. Any failure
   aborts the publish and records a circuit-breaker strike.
3. **Publish** — on a green gate it branches, commits `data/map-items.json`,
   opens + squash-merges a PR, and (optionally) pings the Render deploy hook.
4. **Self-refresh** — the new deploy changes the build id; every open tab
   reconnects over SSE and reloads itself.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ENABLED` | `false` | Master kill switch |
| `AGENT_AUTO_PUBLISH` | `true` | After a clean research cycle with staged work, run the gate and publish automatically. Set `false` to only stage (manual/cron publish). |
| `AGENT_RESEARCH_INTERVAL` | `600000` | Always-on research cadence, ms (min 60 000) |
| `AGENT_ITEM_BUDGET` | `3` | Items researched per cycle |
| `AGENT_STALE_DAYS` | `90` | Re-research entries older than this |
| `AGENT_GITHUB_TOKEN` | unset | Fine-grained PAT with `contents:write` on the app repo |
| `AGENT_GITHUB_REPO` | unset | `owner/repo` (e.g. `hatsmagee/Bus-Tracker`) |
| `AGENT_GITHUB_BRANCH` | `main` | Base branch for agent PRs |
| `AIHORDE_API_KEY` | anon | Optional AI Horde key for faster priority |
| `RENDER_DEPLOY_HOOK` | unset | POST after PR merge to force an immediate deploy |

### CLI (local)

```bash
npm run audit-map-items    # list gaps across the fixed/named item universe
npm run agent-research     # research up to AGENT_ITEM_BUDGET items → stage
npm run agent-publish      # full gate → branch → PR → merge → deploy hook
npm test                   # unit suite (also: npm run test:unit)
npm run smoke-test         # schema + image-liveness + syntax gate only
npm run boot-check         # boot the server on the merged data and probe it
```

### Safety

- **No paid keys** — refuses to run if `OPENAI_API_KEY` / `TAVILY_API_KEY` (and
  friends) are present; everything it uses is free and keyless.
- **Nothing unverified reaches `main`** — the three-stage gate (unit → smoke →
  live boot) must pass first; it never commits directly to `main`.
- **Circuit breaker** trips after 3 failures/hour and needs a manual reset.
- **AI Horde** is skipped if the service is down; LLaMA2 models are excluded.
- **Bounded disk** — the activity log is size-capped and rotated, and a daily
  sweep clears stale temp files, so a light/ephemeral host never fills up.

### Watching it work

- **Agent tab** — live status, staged/captured work, and a streaming activity
  log (run / publish / reset-breaker controls).
- **Roaming robot** — a marker that hops around the map to whatever item the
  agent is researching; hover for its current activity, click to open the tab.

## Deploying to Render.com

The repo includes `render.yaml` (Blueprint). To deploy:

1. Render dashboard → **New** → **Blueprint**
2. Connect this repo (`hatsmagee/Bus-Tracker`)
3. Render reads `render.yaml` and creates the web service.
4. Wait for the first deploy to finish (~2-3 min).
5. Copy the live URL Render gives you (this deployment lives at
   `https://bus-tracker-a36o.onrender.com`).

Render automatically sets `PORT=10000` and `RENDER=1`. The server reads
those, binds to `0.0.0.0:10000`, and writes its SQLite DB + GTFS zip to
`/tmp` (the only writable spot on Render's ephemeral filesystem).

**Persistent history (free):** the ephemeral `/tmp` is wiped on every
redeploy, so to keep accumulated history set up a free durable backup
(`backup.js`). Easiest is a GitHub repo — create a fine-grained PAT with
contents read/write and set in the Render dashboard:
- `BACKUP_GITHUB_TOKEN` and `BACKUP_GITHUB_REPO` (`owner/repo`)

The DB is then snapshotted off-box and restored on boot. (Alternatively set
the `BACKUP_S3_*` vars for a Backblaze B2 / Cloudflare R2 bucket.) With none
set the app still runs; history just resets on each deploy.

**Caveats:**
- Free tier spins down after 15 min of no traffic. Set up the local
  keep-alive timer below to prevent that.

## Running locally (systemd)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/heleon-tracker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now heleon-tracker.service
systemctl --user status heleon-tracker.service
```

## Local keep-alive timer (keeps Render free tier awake)

The free tier on Render spins down after 15 min of no traffic. To
prevent that — even when your laptop is closed or you're logged out —
this repo ships a user-level systemd timer that pings the deployed
`/healthz` endpoint every 10 minutes.

```bash
# Install the timer
cp systemd/heleon-keepalive.service systemd/heleon-keepalive.timer \
   ~/.config/systemd/user/
cp scripts/keepalive.sh ~/.local/bin/heleon-keepalive.sh

systemctl --user daemon-reload
systemctl --user enable --now heleon-keepalive.timer

# Verify
systemctl --user list-timers | grep heleon
journalctl --user -u heleon-keepalive.service -f
```

**Will this run when I'm logged out?**

Yes — as long as your account has `Linger=yes` enabled
(`loginctl show-user $USER | grep Linger` should print
`Linger=yes`). When linger is on, systemd user services keep running
after logout and survive reboots.

**Setting the URL**

The default URL is `https://bus-tracker-a36o.onrender.com/healthz`.
If Render assigned a different hostname, edit
`~/.config/systemd/user/heleon-keepalive.service` and update the
`Environment=HELEON_RENDER_URL=...` line, then
`systemctl --user daemon-reload && systemctl --user restart heleon-keepalive.timer`.

## Files

- `island-transit.js` — multi-island Syncromatics polling (Kauaʻi + Maui GTFS-RT + RTPI)
- `heleon-server.js` — main backend (GTFS-RT polling, DB, GTFS, transformer, weather)
- `gtfs-rt.js` — dependency-free GTFS-realtime protobuf decoder
- `heleon-tracker.html` — single-file dashboard
- `road-graph.js` — builds a routable graph from `data/osm/bigisland-roads.json`
  (junction nodes + real road-segment edges) and snaps points onto it
- `scripts/build-osm-roads.js` — one-time: extracts Big Island road geometry from
  a Geofabrik OSM PBF extract → `data/osm/bigisland-roads.json`
- `scripts/snap-routes-to-roads.js` — snaps every GTFS route shape onto the road
  graph → `data/route-shapes-road-snapped.json` (`npm run snap-routes [serverUrl]`)
- `scripts/validate-route-roads.js` — checks route geometry against real OSM
  roads, reports any drift (`npm run validate-routes`)
- `backup.js` — free durable DB backup (GitHub repo or S3-compatible store). Lets
  history survive ephemeral hosts (e.g. Render free tier wiping `/tmp` on deploy):
  restores the latest snapshot on boot, snapshots periodically + on shutdown.
- `data/heleon-reference.json` — route classification (Express/Local/Neighborhood/
  Flex), transit-hub connections, Park-and-Ride/terminals/airports — the data the
  System Map PDF carries but GTFS doesn't. Auto-validated weekly against GTFS.
- `scripts/scrape-reference.js` — weekly: refreshes the reference file's route
  roster/names/colors from live GTFS, preserves curated classification, flags drift.
- `scripts/scrape-schedules.js` — weekly scraper for the agency's schedule PDFs
  (timetables/stops/names) from heleonbus.hawaiicounty.gov → `data/schedules/`.
- `data/map-items.json` — curated item cards (history/photos/summaries) shown on
  the map; the self-development agent's source of truth (staged edits live in
  `data/map-items.staged.json` until a gated PR merges them).
- `scripts/agent/` — agent entrypoints (`run-research.js`, `run-publish.js`) and
  `research-agent.js`, the plan → research → synthesize → validate → stage loop.
- `scripts/audit-map-items.js` — diffs the item universe vs. live data → queue.
- `scripts/publish-map-items.js` — runs the pre-push gate, then branch → PR →
  merge → deploy hook.
- `scripts/smoke-test.js` — schema + image-liveness + syntax validation gate.
- `scripts/check-server-boot.js` — boots the server on the merged data and
  confirms it serves `/healthz` + `/api/map-items` (catches runtime breakage).
- `scripts/test/` — dependency-free unit suite (`npm test`) covering the schema,
  no-keys guard, AI Horde helpers, log rotation, catalog, GitHub, and audit.
- `scripts/lib/` — agent building blocks (`aihorde`, `research-sources`,
  `github`, `agent-state`, `item-catalog`, `map-items-schema`, `no-keys-guard`,
  `log-rotate`, `paths`).
- `scripts/keepalive.sh` — bash script that pings the Render URL
- `render.yaml` — Render Blueprint (web service only)
- `systemd/heleon-tracker.service` — local tracker systemd unit
- `systemd/heleon-keepalive.{service,timer}` — local keep-alive timer
- `public/favicon.svg` — favicon

## Tech stack

- **Backend**: Node.js + sql.js (pure WASM SQLite, no glibc headaches)
- **Frontend**: Vanilla JS + MapLibre GL JS v4.7.1
- **Map tiles**: MapTiler
- **Schedule data**: GTFS feed (downloaded daily, conditional HTTP)
- **Live data**: Syncromatics transit management API (portal 158)

## The transformer model

The headline arrival times come from the agency's official GTFS-realtime
TripUpdates feed. On top of that, a small transformer block learns a
*correction* from recorded arrival history. It runs entirely in Node.js with
hand-written backprop — no ML framework, no GPU needed. Architecture:

- 12 input tokens × 8 dimensions; raw features: speed, distance, and cyclical
  time encoded as sin/cos pairs for both hour-of-day and day-of-week
- Single self-attention head (Q/K/V projections, softmax, weighted sum)
- Residual + LayerNorm + 8→16→8 FFN with ReLU
- Mean pool + 5 output heads (one per future stop)
- Retrained online every time a bus reaches a stop (server-side only)

## License

MIT