#!/usr/bin/env node
/**
 * Probe Hawaiian island transit feeds and confirm which require API keys.
 * Run: node scripts/verify-island-transit-feeds.js
 *
 * Exit 0 when all expectations match (unavailable islands stay blocked).
 */
'use strict';

const https = require('https');
const http = require('http');

const TIMEOUT_MS = 12000;

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'heleon-verify/1.0' }, opts.headers || {}),
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          body: opts.binary ? body : body.toString('utf8'),
          bytes: body.length,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function bodySnippet(body, max = 120) {
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  return String(body || '').replace(/\s+/g, ' ').slice(0, max);
}

function hasTheBusKeyError(body) {
  const s = String(body || '');
  return /Invalid or unspecified API key/i.test(s)
    || /Application key was not found/i.test(s)
    || /"errorMessage"\s*:\s*"Invalid or unspecified API key"/i.test(s);
}

function hasSwiftlyAuthError(status, body) {
  return status === 401 && /Missing Authorization Header/i.test(String(body || ''));
}

const PROBES = [
  {
    island: 'oahu',
    label: 'TheBus arrivals (no key)',
    url: 'https://api.thebus.org/arrivals/?stop=701',
    expect: r => r.status === 200 && hasTheBusKeyError(r.body),
  },
  {
    island: 'oahu',
    label: 'TheBus vehicle fleet (no key)',
    url: 'https://api.thebus.org/vehicle/',
    expect: r => r.status === 200 && hasTheBusKeyError(r.body),
  },
  {
    island: 'oahu',
    label: 'TheBus vehicle fleet with THEBUS_APP_ID (optional live check)',
    url: process.env.THEBUS_APP_ID
      ? `http://api.thebus.org/vehicle/?key=${encodeURIComponent(process.env.THEBUS_APP_ID)}`
      : null,
    skip: !process.env.THEBUS_APP_ID,
    expect: r => r.status === 200 && /<vehicle>|<vehicles>/i.test(r.body) && !hasTheBusKeyError(r.body),
    note: 'Set THEBUS_APP_ID to verify live fleet unlock',
  },
  {
    island: 'oahu',
    label: 'TheBus arrivalsJSON (no key)',
    url: 'https://api.thebus.org/arrivalsJSON/?stop=701',
    expect: r => r.status === 200 && hasTheBusKeyError(r.body),
  },
  {
    island: 'oahu',
    label: 'TheBus routeJSON (no key — empty body, no shapes)',
    url: 'https://api.thebus.org/routeJSON/?route=1',
    expect: r => r.status === 200 && r.bytes === 0,
  },
  {
    island: 'oahu',
    label: 'Swiftly GTFS-RT vehicle positions (no Authorization)',
    url: 'https://api.goswift.ly/real-time/thebus/gtfs-rt-vehicle-positions',
    expect: r => hasSwiftlyAuthError(r.status, r.body),
  },
  {
    island: 'oahu',
    label: 'Syncromatics-style VP (thebus.org — not used by OTS)',
    url: 'https://www.thebus.org/gtfs-rt/vehiclepositions',
    expect: r => r.status === 404,
  },
  {
    island: 'oahu',
    label: 'Static GTFS zip (schedule only — keyless)',
    url: 'https://www.thebus.org/transitdata/production/google_transit.zip',
    expect: r => r.status === 200 && r.bytes > 10000,
  },
  {
    island: 'molokai',
    label: 'MEO / Molokaʻi Syncromatics RTPI (mauibus.org pattern)',
    url: 'https://www.meoinc.org/api/rtpi?path=routes',
    expect: r => r.status === 404 || r.status === 403 || r.bytes < 200,
  },
  {
    island: 'molokai',
    label: 'Molokaʻi on Maui Bus GTFS (island filter)',
    url: 'https://mauibus.org/gtfs',
    expect: r => r.status === 200 && r.bytes > 1000,
    note: 'Maui County GTFS exists but covers Maui island fixed routes only — not MEO Molokaʻi shuttles',
  },
  {
    island: 'lanai',
    label: 'Lānaʻi — no Syncromatics / GTFS-RT host',
    url: 'https://mauibus.org/gtfs-rt/vehiclepositions',
    expect: () => true,
    note: 'Maui Bus GTFS-RT is Maui-only; Lānaʻi has no separate AVL publisher (MEO reservation shuttles)',
  },
  {
    island: 'kauai',
    label: 'Kauaʻi keyless Syncromatics VP (control — should work)',
    url: 'https://thekauaibus.com/gtfs-rt/vehiclepositions',
    expect: r => r.status === 200 && r.bytes > 50,
    binary: true,
  },
  {
    island: 'maui',
    label: 'Maui keyless Syncromatics VP (control — should work)',
    url: 'https://mauibus.org/gtfs-rt/vehiclepositions',
    expect: r => r.status === 200 && r.bytes > 50,
    binary: true,
  },
];

async function main() {
  console.log('Island transit feed verification\n');
  let failed = 0;
  for (const probe of PROBES) {
    if (probe.skip || !probe.url) {
      console.log(`[SKIP] ${probe.island} — ${probe.label}`);
      if (probe.note) console.log(`       note: ${probe.note}`);
      console.log('');
      continue;
    }
    let result;
    try {
      result = await fetchUrl(probe.url, { binary: probe.binary });
    } catch (e) {
      result = { status: 0, body: e.message, bytes: 0, error: true };
    }
    const ok = !result.error && probe.expect(result);
    if (!ok) failed++;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${probe.island} — ${probe.label}`);
    console.log(`       ${probe.url}`);
    console.log(`       HTTP ${result.status}, ${result.bytes} bytes — ${bodySnippet(result.body)}`);
    if (probe.note) console.log(`       note: ${probe.note}`);
    console.log('');
  }
  console.log(failed ? `${failed} probe(s) FAILED` : 'All probes passed — unavailable islands remain blocked without keys.');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
