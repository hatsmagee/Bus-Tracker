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

The server is Render-ready as-is. Two paths:

### Option A — Blueprint (one click, recommended)

The repo includes `render.yaml` which provisions **both** the web
service and a cron job that keeps it warm.

1. Render dashboard → **New** → **Blueprint**
2. Connect this repo (`hatsmagee/Bus-Tracker`)
3. Render reads `render.yaml` and creates:
   - **heleon-bus-tracker** — Node.js web service on the free plan
   - **heleon-keepalive** — cron job that pings `/healthz` every 10 min
4. Click **Apply**. Done.

The cron job runs `keepalive.js` against the web service's URL every
10 minutes, so the free tier never spins down. Visitors get instant
loads instead of a 30 s cold-start wait.

### Option B — Manual web service

If you'd rather just create the web service by hand:

1. Render dashboard → **New** → **Web Service**
2. Connect this repo
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Health Check Path**: `/healthz`
6. **Instance Type**: Free

Then to keep it warm, either:
- Add the cron job separately (copy the `heleon-keepalive` block from
  `render.yaml`), OR
- Use [UptimeRobot](https://uptimerobot.com) on the free plan to ping
  `/healthz` every 5 minutes.

Render automatically sets `PORT=10000` and `RENDER=1`. The server reads
those, binds to `0.0.0.0:10000`, and writes its SQLite DB + GTFS zip to
`/tmp` (the only writable spot on Render's ephemeral filesystem).

**Caveats:**
- DB and GTFS feed are reset on every redeploy (ephemeral disk).
  Fine for a demo; for persistent history add a Render Disk (paid).
- The cron job itself runs on the free tier and may sleep too if
  Render decides to suspend it during low load — in practice cron
  jobs on the free tier run reliably every 10 min.

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
- `keepalive.js` — Render cron job script (pings `/healthz`)
- `render.yaml` — Render Blueprint (web service + keepalive cron)
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