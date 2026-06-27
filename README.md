# 🚌 Hele-On Bus Live Tracker

A live bus tracking dashboard for the Hele-On Bus system (County of Hawai'i),
built on top of the Syncromatics transit management API. Self-hosted, runs
entirely on your own machine — no cloud dependency, no API hammering.

## What it does

- **Live vehicle positions** on a MapLibre map, color-coded by route
- **Route shape rendering** with parallel-line offset so overlapping routes stay readable
- **Stop markers** with hover popup showing approaching buses, recent arrivals, and historical typical arrival pattern
- **Per-vehicle card** with Predicted / Scheduled / Typical arrival times for the next stop
- **GTFS scheduled times** loaded from the official County GTFS feed and matched to live data
- **Transformer-based ETA predictor** (12-token self-attention, 704 params) that retrains on every bus arrival
- **Systemd user service** for 24/7 background polling

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser (heleon-tracker.html)                           │
│   - MapLibre GL map                                     │
│   - Sidebar with vehicle cards                          │
│   - 5 tabs: Vehicles / Routes / Learn / Status / API    │
└────────────┬────────────────────────────────────────────┘
             │ HTTP /api/* (every 10s)
┌────────────▼────────────────────────────────────────────┐
│ Node.js server (heleon-server.js)                       │
│   - Polls 22 routes every 10s                           │
│   - Stores GPS pings in SQLite (sql.js)                 │
│   - Transformer ETA model (online SGD)                 │
│   - GTFS loader (conditional HTTP, daily refresh)      │
│   - Systemd service on 0.0.0.0:8765                     │
└────────────┬────────────────────────────────────────────┘
             │ HTTPS
       Syncromatics API  ←→  myheleonbus.org/gtfs
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
| `POLL_INTERVAL`| 10000 (ms)    | How often to poll each route         |
| `MAPTILER_KEY` | (built-in)    | MapTiler API key for basemap tiles   |

## Deploying to Render.com

The server is Render-ready as-is. From the Render dashboard:

1. **New → Web Service**, connect this repo (`hatsmagee/Bus-Tracker`).
2. **Environment**: `Node`
3. **Branch**: `main`
4. **Region**: any
5. **Build Command**: `npm install`
6. **Start Command**: `npm start`
7. **Instance Type**: Free is fine for testing (will sleep after 15 min idle)
8. Click **Deploy**.

Render automatically sets `PORT=10000` and `RENDER=1`. The server reads
those, binds to `0.0.0.0:10000`, and writes its SQLite DB + GTFS zip to
`/tmp` (the only writable spot on Render's ephemeral filesystem).

**Caveats:**
- Render's free tier spins down after inactivity. First request after a
  cold start takes ~30 s.
- DB and GTFS feed are reset on every redeploy. Fine for a demo; for
  persistent history wire up a Render Disk (paid) or an external DB.
- The default free instance sleeps after 15 min of no traffic. Keep it
  warm with [UptimeRobot](https://uptimerobot.com) or similar.

## Running locally (systemd)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/heleon-tracker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now heleon-tracker.service
systemctl --user status heleon-tracker.service
```

## Files

- `heleon-server.js` — main backend (polling, DB, GTFS, transformer)
- `heleon-tracker.html` — single-file dashboard (~2,300 lines)
- `heleon-proxy.js` — simple static + CORS proxy (alternative entry)
- `systemd/heleon-tracker.service` — systemd user unit
- `public/favicon.svg` — favicon

## Tech stack

- **Backend**: Node.js + sql.js (pure WASM SQLite, no glibc headaches)
- **Frontend**: Vanilla JS + MapLibre GL JS v4.7.1
- **Map tiles**: MapTiler
- **Schedule data**: GTFS feed (downloaded daily, conditional HTTP)
- **Live data**: Syncromatics transit management API (portal 158)

## The transformer model

The ETA predictor is a small transformer block trained on the bus arrival
history recorded in SQLite. It runs entirely in Node.js with hand-written
backprop — no ML framework, no GPU needed. Architecture:

- 12 input tokens × 8 dimensions (speed, distance, cyclical hour/minute/dow)
- Single self-attention head (Q/K/V projections, softmax, weighted sum)
- Residual + LayerNorm + 8→16→8 FFN with ReLU
- Mean pool + 5 output heads (one per future stop)
- **704 parameters**, retrained online every time a bus reaches a stop

## License

MIT