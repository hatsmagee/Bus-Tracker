#!/usr/bin/env node
// Render Cron Job — keeps the Hele-On Bus Tracker web service warm.
// Render sets the HOST env var (via render.yaml fromService) to the
// web service's hostname (e.g. "heleon-bus-tracker.onrender.com").
// We hit /healthz so Render's health check is the same ping.

const https = require('https');

const host = process.env.HOST;
if (!host) {
  console.error('HOST env var not set');
  process.exit(1);
}

const url = `https://${host}/healthz`;
console.log(`[keepalive] GET ${url}`);

const req = https.get(url, { timeout: 8000 }, (res) => {
  console.log(`[keepalive] status ${res.statusCode}`);
  // Drain body so the socket can close
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
});

req.on('timeout', () => { console.error('[keepalive] timeout'); req.destroy(); process.exit(2); });
req.on('error',   (e) => { console.error(`[keepalive] error: ${e.message}`); process.exit(3); });