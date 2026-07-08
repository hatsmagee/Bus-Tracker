#!/usr/bin/env bash
# Hele-On Bus Tracker — local keep-alive ping.
# Runs every 10 minutes via systemd user timer (see systemd/heleon-keepalive.*).
# Hits the deployed Render URL's /healthz so the free-tier instance
# never spins down (15-min idle threshold).
set -euo pipefail

URL="${HELEON_RENDER_URL:-https://heleon-bus-tracker.onrender.com/healthz}"

# Overnight the instance is allowed to sleep: Hele-On runs ~4:30am-9:30pm HST,
# so between 10pm and 4am there is nothing to track and every awake hour costs
# polling bandwidth. Skipping the ping lets Render spin the free instance down
# (15-min idle; SIGTERM force-uploads a final DB snapshot). The first ping at
# 4am HST wakes it before the first buses roll; boot restores the DB snapshot.
hst_hour=$((10#$(TZ=Pacific/Honolulu date +%H)))
if (( hst_hour >= 22 || hst_hour <= 3 )); then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] night window (HST ${hst_hour}h) — letting the instance sleep"
    exit 0
fi

# 8-second timeout — Render's health check responds in <100ms when warm.
# If it's sleeping, Render will refuse the connection rather than hang.
http_code="$(curl --silent --show-error --max-time 8 --output /dev/null \
                 --write-out '%{http_code}' \
                 --retry 0 \
                 "$URL" || echo '000')"

ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "[$ts] GET $URL -> $http_code"

# A cold instance (first ping after the night window) takes ~30-60s to boot —
# retry once with a timeout long enough to ride through the spin-up.
if [[ "$http_code" != "200" ]]; then
    http_code="$(curl --silent --show-error --max-time 90 --output /dev/null \
                     --write-out '%{http_code}' --retry 0 "$URL" || echo '000')"
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] retry (cold start?) -> $http_code"
fi

# Non-zero exit on failure so systemd marks the service failed (visible in journalctl)
if [[ "$http_code" != "200" ]]; then
    exit 1
fi