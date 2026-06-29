'use strict';
/**
 * One-time build step: snap each route's GTFS shape to the real road network so
 * the map draws beautiful on-road lines instead of the wobbly raw GPS shape.
 *
 * We send each route's points to a Valhalla `trace_route` (map-matching) server
 * and store the snapped-to-road polyline. This runs offline (routes don't move),
 * and the result is vendored into the repo as data/route-shapes-matched.json —
 * so the app has ZERO runtime dependency on Valhalla, Docker, or any service.
 *
 * Usage:
 *   node scripts/match-routes.js [shapesUrl] [valhallaUrl]
 *   # defaults: http://localhost:8765/api/shapes  and the public OSM Valhalla
 *
 * Re-run only when the agency changes its routes.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SHAPES_URL = process.argv[2] || 'http://localhost:8765/api/shapes';
const VALHALLA = process.argv[3] || 'https://valhalla1.openstreetmap.de/trace_route';
const OUT = path.join(__dirname, '..', 'data', 'route-shapes-matched.json');

function get(url) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((res, rej) => {
    lib.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
  });
}

function postJson(url, body) {
  const lib = url.startsWith('https') ? https : http;
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  return new Promise((res, rej) => {
    const req = lib.request({
      hostname: u.hostname, path: u.pathname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'heleon-shape-matcher' },
      timeout: 60000,
    }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); });
    req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
    req.end(data);
  });
}

// Polyline decode/encode (precision 1e5 for GTFS, 1e6 for Valhalla output).
function decode(str, factor = 1e5) {
  let index = 0, lat = 0, lng = 0; const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
function encode(coords, factor = 1e5) {
  let last = [0, 0], out = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const c of coords) {
    const lat = Math.round(c[0] * factor), lng = Math.round(c[1] * factor);
    out += enc(lat - last[0]) + enc(lng - last[1]); last = [lat, lng];
  }
  return out;
}
function hav(a, b) {
  const R = 6371000, p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
  const dp = (b[0] - a[0]) * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// Downsample to ~`spacing` metres — dense GPS points break Valhalla map-snap.
function downsample(pts, spacing = 40) {
  if (pts.length < 2) return pts;
  const ds = [pts[0]];
  for (const p of pts.slice(1)) if (hav(ds[ds.length - 1], p) >= spacing) ds.push(p);
  if (ds[ds.length - 1] !== pts[pts.length - 1]) ds.push(pts[pts.length - 1]);
  return ds;
}

async function matchAt(pts, spacing, opts, costing) {
  const ds = downsample(pts, spacing);
  const body = {
    shape: ds.map(([lat, lon]) => ({ lat, lon })),
    costing: costing || 'auto',
    shape_match: 'map_snap',
    trace_options: Object.assign({ search_radius: 50, gps_accuracy: 18, turn_penalty_factor: 0, breakage_distance: 4000 }, opts || {}),
    directions_options: { units: 'kilometers' },
  };
  const r = await postJson(VALHALLA, body);
  if (r.status !== 200) throw new Error(`valhalla ${r.status}: ${r.body.slice(0, 120)}`);
  const trip = JSON.parse(r.body).trip;
  if (!trip || !trip.legs || !trip.legs.length) throw new Error('no legs');
  let all = [];
  for (const leg of trip.legs) {
    const seg = decode(leg.shape, 1e6);
    if (all.length && seg.length && hav(all[all.length - 1], seg[0]) < 1) seg.shift();
    all = all.concat(seg);
  }
  return all;
}

async function matchOne(encodedShape) {
  const pts = decode(encodedShape, 1e5);
  const origLen = pts.reduce((s, _, i) => i ? s + hav(pts[i - 1], pts[i]) : 0, 0);
  // Try coarse sampling first (fast, clean in town); if the result drifts too far
  // from the original length, retry denser + tighter — that recovers most long
  // rural routes whose sparse points let Valhalla wander onto the wrong road.
  let best = null, bestDrift = Infinity;
  // auto first (respects one-ways nicely in town); then denser auto; then
  // pedestrian, which ignores access restrictions that truncate auto matches on
  // long rural routes using service/private-tagged roads.
  const attempts = [[40, {}, 'auto'], [25, { search_radius: 35, gps_accuracy: 12 }, 'auto'], [25, { search_radius: 40, gps_accuracy: 15 }, 'pedestrian']];
  for (const [spacing, opts, costing] of attempts) {
    let all;
    try { all = await matchAt(pts, spacing, opts, costing); } catch (e) { if (!best) lastErr = e; continue; }
    const matchedLen = all.reduce((s, _, i) => i ? s + hav(all[i - 1], all[i]) : 0, 0);
    const drift = Math.abs(matchedLen - origLen) / (origLen || 1);
    if (drift < bestDrift) { bestDrift = drift; best = { all, matchedLen }; }
    if (drift <= 0.1) break; // good enough, stop
  }
  // Stubborn long routes (truncated matches, or over Valhalla's 200km cap):
  // split the trace into ~60-point overlapping chunks, match each, and stitch.
  if (!best || bestDrift > 0.4) {
    try {
      const chunkMatched = await matchChunked(pts);
      if (chunkMatched && chunkMatched.length > 1) {
        const ml = chunkMatched.reduce((s, _, i) => i ? s + hav(chunkMatched[i - 1], chunkMatched[i]) : 0, 0);
        const drift = Math.abs(ml - origLen) / (origLen || 1);
        if (!best || drift < bestDrift) { best = { all: chunkMatched, matchedLen: ml }; bestDrift = drift; }
      }
    } catch (e) { if (!best) lastErr = e; }
  }
  if (!best) throw lastErr || new Error('no match');
  return { encoded: encode(best.all, 1e5), points: best.all.length, origLen, matchedLen: best.matchedLen };
}
let lastErr = null;

// Match a long trace in overlapping windows of points, then concatenate. Keeps
// each request well under Valhalla's distance cap and recovers from mid-route
// truncation.
async function matchChunked(pts) {
  const ds = downsample(pts, 30);
  const WIN = 60, OVERLAP = 5;
  let out = [];
  for (let start = 0; start < ds.length - 1; start += (WIN - OVERLAP)) {
    const win = ds.slice(start, start + WIN);
    if (win.length < 2) break;
    let seg;
    try { seg = await matchAt(win, 1, { search_radius: 40, gps_accuracy: 15 }, 'pedestrian'); }
    catch { seg = win; } // if a window fails, fall back to its raw points
    if (out.length && seg.length && hav(out[out.length - 1], seg[0]) < 30) seg.shift();
    out = out.concat(seg);
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

(async () => {
  console.log(`Fetching shapes from ${SHAPES_URL}…`);
  const shapes = JSON.parse(await get(SHAPES_URL));
  // First pattern per route (that's what the map renders).
  const byRoute = {};
  for (const s of shapes) if (s.shape && !byRoute[s.route_id]) byRoute[s.route_id] = s;
  const routes = Object.values(byRoute);
  console.log(`Matching ${routes.length} routes against ${VALHALLA}\n`);

  const out = {};
  let ok = 0, fail = 0;
  for (const s of routes) {
    process.stdout.write(`  route ${s.route_id} ${(s.name || '').slice(0, 30).padEnd(30)} `);
    try {
      const m = await matchOne(s.shape);
      const drift = Math.abs(m.matchedLen - m.origLen) / (m.origLen || 1);
      // Guard against a wildly-wrong match (e.g. snapped onto the wrong road):
      // if the matched length deviates >40% from the original, keep the raw shape.
      if (drift > 0.4) {
        out[s.route_id] = s.shape;
        console.log(`drift ${(drift * 100).toFixed(0)}% — kept raw`);
        fail++;
      } else {
        out[s.route_id] = m.encoded;
        console.log(`ok ${m.points} pts, drift ${(drift * 100).toFixed(1)}%`);
        ok++;
      }
    } catch (e) {
      out[s.route_id] = s.shape; // fall back to raw shape on failure
      console.log(`FAILED (${e.message}) — kept raw`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 400)); // be polite to the public server
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nWrote ${OUT}  (${ok} matched, ${fail} kept raw)`);
})();
