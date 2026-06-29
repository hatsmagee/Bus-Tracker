# 🚌 Hele-On Bus Live Tracker

A live bus tracking dashboard for the Hele-On Bus system (County of Hawai'i),
built on top of the Syncromatics transit management API. Self-hosted, runs
entirely on your own machine — no cloud dependency, no API hammering.

## What it does

- **Whole-fleet live positions** (per-route vehicle endpoint, with real speed +
  heading), on a MapLibre map, color-coded by route, with dead-reckoning motion
  so buses glide along their heading between polls instead of jumping
- **Official predicted arrivals** from the GTFS-realtime TripUpdates feed as the
  headline ETA, with a transformer learning a correction on top
- **Schedule adherence** (ahead/behind) with a sanity guard against bad matches
- **Route shape rendering** with parallel-line offset so overlapping routes stay readable
- **Directional "where it's going" arrows** ahead of each bus
- **Recognizable bus-stop markers** with popups for approaching buses & history
- **Microclimate weather** symbol over each bus (Open-Meteo, free, no API key)
- **Occupancy bar** on each bus icon
- **Transformer ETA correction model** (12-token self-attention) retrained
  server-side on every recorded stop arrival
- Desktop + mobile (bottom-sheet) responsive UI

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

**Caveats:**
- DB and GTFS feed are reset on every redeploy (ephemeral disk).
  Fine for a demo; for persistent history add a Render Disk (paid).
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