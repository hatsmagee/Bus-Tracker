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
| Buses (live GPS) | Syncromatics RTPI + GTFS-RT (`myheleonbus.org`) | `/api/vehicles` | positions snapped to the OSM road graph |
| Route ribbons | GTFS shapes matched to OSM roads | `/api/route-edges`, `/api/route-roads` | 25 routes, colors the actual road via feature-state |
| Aircraft | adsb.lol → airplanes.live → adsb.one (community ADS-B) | `/api/aircraft` | keyless; OpenSky fallback |
| Vessels | aisstream.io AIS websocket | `/api/vessels` | bundled key; sparse mid-ocean coverage is expected |
| Streamflow | USGS NWIS instantaneous values + daily statistics | `/api/streamflow`, `/api/streamflow-stats`, `/api/gauge-history` | animated water wheels, level meters, historical graphs |
| Weather stations | NWS `api.weather.gov` observations | `/api/weather-stations` | User-Agent header only |
| Summit observatories | CFHT weather tower (Maunakea) + NOAA GML CO₂ (Mauna Loa) | `/api/summits` | live summit wind/temp/pressure + the Keeling Curve |
| Ocean | NDBC buoys (incl. Hilo Waverider), NOAA CO-OPS tides, DART 51407 tsunami buoy | `/api/ocean` | wave height/period, next high/low tides, deep-ocean water column |
| Air quality / vog | Open-Meteo air-quality API | `/api/air-quality` | US AQI + PM2.5/PM10/SO₂ for 9 towns |
| Volcano | USGS HVO HANS alerts + live webcams | `/api/volcano` | Kīlauea/Mauna Loa color code + alert level, 8 live cams |
| METARs | NOAA Aviation Weather Center | `/api/metars` | PHTO Hilo, PHKO Kona, PHSF Bradshaw AAF (military) |
| APRS ham radio | APRS-IS TCP feed (`rotate.aprs2.net`) | `/api/aprs` | keyless RX-only login; real vehicles/stations/wx beacons |
| Meshtastic / LoRa | meshtastic.liamcottle.net node map | `/api/meshtastic` | LoRa mesh nodes heard on the island |
| Ham repeaters | hearham.com open repeater list | `/api/repeaters` | 55 repeaters with frequency/offset/tone |
| Earthquakes | USGS FDSN GeoJSON | `/api/earthquakes` | Big Island bbox |
| Wildfire | NASA FIRMS hotspots | `/api/wildfire` | MODIS/VIIRS |
| NWS alerts + radar | api.weather.gov + Iowa State NEXRAD tiles | `/api/alerts` | |
| Traffic controls | OSM (Overpass) signals/stop signs | `/api/controls` | locations only — HDOT publishes no live SPaT for the island |

Things we investigated that **don't** exist publicly (so they're not faked):
live traffic-signal states (no HDOT SPaT feed), observatory/ranger vehicle GPS,
and Tesla/private fleet tracking (owner-account APIs only).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser (heleon-tracker.html)                           │
│   - MapLibre GL map, smooth bus interpolation           │
│   - Sidebar with vehicle cards + scrubber timelines     │
│   - 4 tabs: Buses / Routes / System / Docs              │
└────────────┬────────────────────────────────────────────┘
             │ HTTP /api/* (every 15s)
┌────────────▼────────────────────────────────────────────┐
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

## Deploying to Render.com

The repo includes `render.yaml` (Blueprint). To deploy:

1. Render dashboard → **New** → **Blueprint**
2. Connect this repo (`hatsmagee/Bus-Tracker`)
3. Render reads `render.yaml` and creates the web service.
4. Wait for the first deploy to finish (~2-3 min).
5. Copy the live URL Render gives you (e.g.
   `https://heleon-bus-tracker.onrender.com`).

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

The default URL is `https://heleon-bus-tracker.onrender.com/healthz`.
If Render assigned a different hostname, edit
`~/.config/systemd/user/heleon-keepalive.service` and update the
`Environment=HELEON_RENDER_URL=...` line, then
`systemctl --user daemon-reload && systemctl --user restart heleon-keepalive.timer`.

## Files

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