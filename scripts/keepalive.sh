#!/usr/bin/env bash
# Hele-On Bus Tracker — local keep-alive ping.
# Runs every 10 minutes via systemd user timer (see systemd/heleon-keepalive.*).
# Hits the deployed Render URL's /healthz so the free-tier instance
# never spins down (15-min idle threshold).
set -euo pipefail

URL="${HELEON_RENDER_URL:-https://heleon-bus-tracker.onrender.com/healthz}"

# 8-second timeout — Render's health check responds in <100ms when warm.
# If it's sleeping, Render will refuse the connection rather than hang.
http_code="$(curl --silent --show-error --max-time 8 --output /dev/null \
                 --write-out '%{http_code}' \
                 --retry 0 \
                 "$URL" || echo '000')"

ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "[$ts] GET $URL -> $http_code"

# Non-zero exit on failure so systemd marks the service failed (visible in journalctl)
if [[ "$http_code" != "200" ]]; then
    exit 1
fi