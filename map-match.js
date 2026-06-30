'use strict';
/**
 * Server-side map-matching: snap a route's sparse GTFS shape onto the real OSM
 * road network so the drawn line FOLLOWS THE ROADS instead of cutting diagonally
 * across blocks. Runs on the server against the free public FOSSGIS Valhalla
 * endpoint, results cached in the DB (and backed up), refreshed when shapes change.
 *
 * Crucially it REJECTS bad matches: if the snapped line strays off the original
 * corridor (Valhalla bridged onto the wrong parallel street) or its length drifts
 * too far, we keep the raw shape rather than draw a wrong road. Better an honest
 * sparse line than a confident wrong one.
 */
const https = require('https');
const http = require('http');

// Local Valhalla (Docker) when available for fast matching; public fallback.
const VALHALLA = process.env.VALHALLA_URL || 'http://localhost:8002/trace_route';

function postJson(url, body, timeoutMs = 25000) {
  const lib = url.startsWith('https') ? https : http;
  const data = Buffer.from(JSON.stringify(body));
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'heleon-tracker' },
      timeout: timeoutMs,
    }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

// ── polyline codec (1e5 GTFS, 1e6 Valhalla) ──
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
function lineLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; }

// Perpendicular distance (m) of p from segment a→b, in local metres.
function perpDist(p, a, b) {
  const mLat = 111320, mLon = mLat * Math.cos(a[0] * Math.PI / 180);
  const ax = a[1] * mLon, ay = a[0] * mLat, bx = b[1] * mLon, by = b[0] * mLat, px = p[1] * mLon, py = p[0] * mLat;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function distToLine(p, line) { let best = Infinity; for (let i = 1; i < line.length; i++) { const d = perpDist(p, line[i - 1], line[i]); if (d < best) best = d; } return best; }

// Drop near-duplicate points (Valhalla chokes on dense GPS); ~25 m spacing.
function downsample(pts, spacing = 25) {
  if (pts.length < 2) return pts;
  const ds = [pts[0]];
  for (const p of pts.slice(1)) if (hav(ds[ds.length - 1], p) >= spacing) ds.push(p);
  if (ds[ds.length - 1] !== pts[pts.length - 1]) ds.push(pts[pts.length - 1]);
  return ds;
}

// Quality of a match vs the raw corridor: length drift + how much strays off it.
function quality(raw, matched) {
  const rawLen = lineLen(raw), matchedLen = lineLen(matched);
  const lenDrift = Math.abs(matchedLen - rawLen) / (rawLen || 1);
  let strayCount = 0, strayMax = 0, n = 0;
  const step = Math.max(1, Math.floor(matched.length / 400));
  for (let i = 0; i < matched.length; i += step) {
    const d = distToLine(matched[i], raw);
    if (d > strayMax) strayMax = d;
    if (d > 40) strayCount++;
    n++;
  }
  return { lenDrift, strayFrac: n ? strayCount / n : 1, strayMax };
}

async function traceRoute(pts, spacing, costing) {
  const ds = downsample(pts, spacing);
  if (ds.length < 2) throw new Error('too few points');
  const body = {
    shape: ds.map(([lat, lon]) => ({ lat, lon })),
    costing: costing || 'bus',           // bus respects one-ways & transit-friendly roads
    shape_match: 'map_snap',
    trace_options: { search_radius: 30, gps_accuracy: 8, turn_penalty_factor: 1, breakage_distance: 2000 },
    directions_options: { units: 'kilometers' },
  };
  const r = await postJson(VALHALLA, body);
  if (r.status !== 200) throw new Error(`valhalla ${r.status}`);
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

// Long routes exceed Valhalla's distance cap → stitch overlapping windows.
async function traceChunked(raw) {
  const ds = downsample(raw, 30);
  const WIN = 90, OVERLAP = 6;
  let out = [];
  for (let start = 0; start < ds.length - 1; start += (WIN - OVERLAP)) {
    const win = ds.slice(start, start + WIN);
    if (win.length < 2) break;
    let seg;
    try { seg = await traceRoute(win, 1, 'bus'); } catch { seg = win; }
    if (out.length && seg.length && hav(out[out.length - 1], seg[0]) < 30) seg.shift();
    out = out.concat(seg);
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

const accept = q => q.lenDrift <= 0.18 && q.strayFrac <= 0.05 && q.strayMax <= 120;

/**
 * Snap one encoded GTFS shape to roads. Returns
 *   { encoded, raw:false, quality }  on a clean snap, or
 *   { encoded:<original>, raw:true, reason }  when no attempt was clean enough.
 */
async function matchShape(encodedShape) {
  const raw = decode(encodedShape, 1e5);
  if (raw.length < 2) return { encoded: encodedShape, raw: true, reason: 'too-few-points' };

  let best = null;
  for (const spacing of [25, 18, 40]) {
    let matched;
    try { matched = await traceRoute(raw, spacing, 'bus'); } catch { continue; }
    if (!matched || matched.length < 2) continue;
    const q = quality(raw, matched);
    if (!best || (q.lenDrift + q.strayFrac * 2) < (best.q.lenDrift + best.q.strayFrac * 2)) best = { matched, q };
    if (accept(q) && q.lenDrift <= 0.08) break;
  }

  if (!best || !accept(best.q)) {
    try {
      const chunked = await traceChunked(raw);
      if (chunked && chunked.length > 1) {
        const cq = quality(raw, chunked);
        if (!best || (cq.lenDrift + cq.strayFrac * 2) < (best.q.lenDrift + best.q.strayFrac * 2)) best = { matched: chunked, q: cq };
      }
    } catch { /* keep best */ }
  }

  if (!best) return { encoded: encodedShape, raw: true, reason: 'no-match' };
  if (!accept(best.q)) {
    const q = best.q;
    return { encoded: encodedShape, raw: true, reason: `drift=${(q.lenDrift*100).toFixed(0)}% stray=${(q.strayFrac*100).toFixed(0)}% max=${q.strayMax.toFixed(0)}m` };
  }
  return { encoded: encode(best.matched, 1e5), raw: false, quality: best.q };
}

module.exports = { matchShape, decode, encode };
