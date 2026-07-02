#!/usr/bin/env node
/**
 * Hele-On Bus Tracker — Persistent Backend
 * - Polls all 22 routes every 10s (even with no browser open)
 * - Stores every GPS ping in SQLite (sql.js, pure WASM — no glibc issues)
 * - Persists DB to disk every 30s
 * - Serves dashboard + REST API (vehicles, trails, shapes, stats)
 * - Proxies upstream API calls (CORS bypass)
 * - Listens on 0.0.0.0 — accessible on local network
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const { parseFeedMessage } = require('./gtfs-rt');
const { nearestPointOnGraph } = require('./road-graph.js');

// Big Island bounding box — fleet feed includes parked/relocated buses
// (e.g. on Oʻahu for maintenance); ignore anything outside Hawaiʻi County.
const BBOX = { minLat: 18.8, maxLat: 20.4, minLon: -156.2, maxLon: -154.7 };
const VEHICLE_STALE_MS = 5 * 60 * 1000;        // a bus is "fresh"/live within this window
const VEHICLE_RETAIN_MS = 48 * 60 * 60 * 1000; // keep showing last-known position (faded) up to 2 days
const RT_VP_PATH = '/gtfs-rt/vehiclepositions';
const RT_TU_PATH = '/gtfs-rt/tripupdates';

// Render.com sets PORT=10000 and RENDER=1; on Render the filesystem is
// ephemeral so we keep SQLite + GTFS zip under /tmp. Locally we keep them
// next to the source tree.
const PORT = parseInt(process.env.PORT, 10) || 8765;
const IS_RENDER = !!process.env.RENDER;
const DATA_DIR = IS_RENDER ? '/tmp' : __dirname;
const DB_PATH = path.join(DATA_DIR, IS_RENDER ? 'heleon.db' : 'heleon.db');
const GTFS_ZIP_PATH = path.join(DATA_DIR, 'heleon-gtfs.zip');
// Bundled "seed" GTFS in the repo — used as a geometry fallback for routes the
// live feed has dropped but the agency still runs (401/301/204 in Puna/Waimea/
// S. Kona). path is fixed to __dirname so it works on ephemeral hosts too.
const SEED_GTFS_PATH = path.join(__dirname, 'Sources', 'General Transit Feed Specifications (GTFS) 2026.zip');
const HTML_PATH = path.join(__dirname, 'heleon-tracker.html');
// Reference data the System Map PDF carries but GTFS does NOT: route class
// (Express/Local/Neighborhood/Flex), transit-hub connections, Park-and-Ride /
// terminal / airport points. Curated in data/heleon-reference.json and kept
// current automatically by scripts/scrape-reference.js (run weekly). Reloaded
// from disk after each scrape so updates take effect without a restart.
const REFERENCE_PATH = path.join(__dirname, 'data', 'heleon-reference.json');
let REFERENCE = {};
function loadReference() {
  try { REFERENCE = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8')); }
  catch { REFERENCE = {}; }
}
loadReference();

// Server-side road-snapping (Valhalla map-matching, cached + auto-refreshing).
const { matchShape, isLocal: VALHALLA_LOCAL } = require('./map-match');
const matchCrypto = require('crypto');
const shapeHash = s => matchCrypto.createHash('sha1').update(s || '').digest('hex').slice(0, 16);

// Durable off-box DB backup (free; restores history on boot so it survives
// ephemeral hosts like Render's free tier wiping /tmp on each deploy).
const backup = require('./backup');
const POLL_INTERVAL = 15000; // GTFS-RT refreshes ~every 15-30s; lighter on bandwidth
const DB_SAVE_INTERVAL = 30000;
const UPSTREAM = 'myheleonbus.org';

// Colors chosen to be dark and saturated enough to read on the light basemap,
// and mutually distinct (no two routes share a hue). The old palette was full
// of pale pastels (lavender, peach, pale green/blue) that vanished on the map
// and several near-duplicates. These are a hand-tuned dark categorical set.
const ROUTES = [
  // Hand-tuned categorical palette spread around the color wheel. Routes that
  // overlap in the SAME town are given maximally-different hues so parallel lanes
  // read clearly. Hilo cluster (1,2,10,11,12,40,80,90,101-104) + Kona cluster
  // (70,75,76,201-204,502,504) each span the wheel; no two share a hue.
  { id: 5600, name: '10 KAU HILO',              short: '10',  color: '#E8731C' }, // orange
  { id: 5602, name: '102 INTRA HILO KAUMANA',   short: '102', color: '#7B2FBE' }, // violet
  { id: 5603, name: '103 INTRA HILO WAIAKEA UKA',short:'103', color: '#0E9E9E' }, // teal
  { id: 5604, name: '101 INTRA HILO KEAUKAHA',  short: '101', color: '#D81B8C' }, // magenta
  { id: 5606, name: '70 NORTH KOHALA S. KOHALA', short: '70', color: '#2E7D32' }, // green
  { id: 5613, name: '1 HILO KONA',               short: '1',  color: '#1565C0' }, // blue
  { id: 5615, name: '201 KONA TROLLEY',          short: '201',color: '#D81B8C' }, // magenta (Kona — no Hilo overlap)
  { id: 5704, name: '2 BLUELINE HILO KONA',      short: '2',  color: '#0B3DCB' }, // deep blue
  { id: 5709, name: '11 REDLINE HILO VOLCANO',   short: '11', color: '#E11D1D' }, // red
  { id: 5724, name: '40 PAHOA',                  short: '40', color: '#00897B' }, // teal-green
  { id: 5725, name: '60 HILO WAIMEA',            short: '60', color: '#8D6E00' }, // dark gold
  { id: 5728, name: '75 N. KOHALA WAIKOLOA KONA',short: '75', color: '#00838F' }, // cyan
  { id: 5729, name: '76 GREENLINE HONOKAA KONA', short: '76', color: '#2E7D32' }, // green (Kona)
  { id: 5730, name: '80 HILO S. KOHALA RESORTS', short: '80', color: '#5D4037' }, // brown
  { id: 5745, name: '90 PAHALA S. KOHALA RESORTS',short:'90', color: '#AD1457' }, // raspberry
  { id: 5748, name: '104 INTRA HILO MOHOULI',   short: '104', color: '#C0A000' }, // goldenrod
  { id: 5750, name: '202 CENTRAL KAILUA-KONA',  short: '202', color: '#E8731C' }, // orange (Kona)
  { id: 5756, name: '402 HAWAIIAN PARADISE PARK',short:'402', color: '#1565C0' }, // blue (Puna)
  { id: 5759, name: '403 FERN ACRES',           short: '403', color: '#5E35B1' }, // indigo (Puna)
  { id: 5821, name: '12 VOLCANO TO OCEANVIEW',  short: '12',  color: '#C2185B' }, // pink-red
  { id: 5824, name: '203 NORTH KAILUA-KONA',    short: '203', color: '#6D4C41' }, // brown (Kona)
  { id: 5982, name: '504 KEALAKEKUA KONA TRIPPER',short:'504',color: '#558B2F' }, // olive-green (Kona)
  // Schedule-only routes: on the printed System Map and in the GTFS feed, but the
  // live RTPI API serves no live shape for them (reduced / call-ahead service with
  // no GPS-tracked vehicles). We load their geometry from GTFS shapes.txt — see
  // loadGtfsShapesForMissing(), which falls back to the bundled seed GTFS for the
  // routes (401/301/204) the CURRENT live feed has dropped but still operates.
  // App id = GTFS short number (1–504 never collide with the 5600+ live ids).
  { id: 5981, name: '502 WAIKOLOA VILLAGE TRIPPER',          short: '502', color: '#6B5B00', scheduleOnly: true }, // dark yellow
  { id: 401,  name: '401 HAWAIIAN BEACHES NANAWALE KALAPANA', short: '401', color: '#B02A8F', scheduleOnly: true }, // orchid
  { id: 301,  name: '301 WAIMEA SHUTTLE',                     short: '301', color: '#0B6E99', scheduleOnly: true }, // cyan-blue
  { id: 204,  name: '204 SOUTH KONA CAPTAIN COOK',            short: '204', color: '#7A2E8E', scheduleOnly: true }, // grape
];
const ROUTE_MAP = Object.fromEntries(ROUTES.map(r => [r.id, r]));

// ─── DATABASE (sql.js) ────────────────────────────────────────────────────────
let db;
const initSql = require('sql.js');

async function openDb() {
  const SQL = await initSql();
  // On an ephemeral host the local file is gone after a deploy/restart — pull the
  // last durable snapshot so accumulated history isn't lost. Only when there's no
  // local DB (a present local file is newer/authoritative for this run).
  if (!fs.existsSync(DB_PATH) && backup.isEnabled()) {
    try {
      const buf = await backup.restore();
      if (buf && buf.length) { fs.writeFileSync(DB_PATH, buf); }
    } catch (e) { console.error('[db] restore error:', e.message); }
  }
  if (fs.existsSync(DB_PATH)) {
    const filebuf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuf);
    console.log(`[db] Loaded existing DB (${Math.round(filebuf.length/1024)} KB)`);
  } else {
    db = new SQL.Database();
    console.log('[db] Created new DB');
  }

  db.run(`CREATE TABLE IF NOT EXISTS pings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    vehicle_id    INTEGER NOT NULL,
    vehicle_name  TEXT,
    route_id      INTEGER,
    pattern_id    INTEGER,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    speed         REAL,
    heading       TEXT,
    heading_deg   REAL,
    passenger_load REAL,
    capacity      INTEGER,
    shape_dist    REAL,
    last_updated  TEXT,
    occupancy_status INTEGER,
    gtfs_current_status INTEGER,
    congestion_level INTEGER
  )`);
  // Columns added after initial release — ALTER for DBs created before this change.
  ['occupancy_status', 'gtfs_current_status', 'congestion_level'].forEach(col => {
    try { db.run(`ALTER TABLE pings ADD COLUMN ${col} INTEGER`); } catch {}
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_pings_v_ts ON pings(vehicle_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pings_ts ON pings(ts)`);

  db.run(`CREATE TABLE IF NOT EXISTS route_shapes (
    route_id    INTEGER NOT NULL,
    pattern_id  INTEGER PRIMARY KEY,
    name        TEXT,
    direction   TEXT,
    color       TEXT,
    shape       TEXT,
    fetched_at  INTEGER
  )`);

  // Road-snapped route geometry, cached so each pattern is map-matched ONCE (via
  // the public Valhalla API) and then served from here. Keyed by the raw shape's
  // hash so a shape change auto-invalidates and re-snaps. Persists with the DB
  // (and its backup), so on Render we don't re-match on every reboot.
  db.run(`CREATE TABLE IF NOT EXISTS route_shapes_matched (
    pattern_id  INTEGER PRIMARY KEY,
    route_id    INTEGER,
    src_hash    TEXT,
    shape       TEXT,
    is_raw      INTEGER,
    note        TEXT,
    matched_at  INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS poll_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    route_id INTEGER,
    status   INTEGER,
    latency  INTEGER,
    count    INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stops (
    id          INTEGER PRIMARY KEY,
    route_id    INTEGER NOT NULL,
    lat         REAL,
    lon         REAL,
    name        TEXT,
    stop_code   TEXT,
    seq         INTEGER,
    fetched_at  INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id)`);

  // Tracks actual arrival times when a bus reaches a stop
  db.run(`CREATE TABLE IF NOT EXISTS stop_arrivals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    vehicle_id  INTEGER NOT NULL,
    route_id    INTEGER NOT NULL,
    stop_id     INTEGER NOT NULL,
    stop_seq    INTEGER,
    eta_speed   REAL,
    eta_hist    REAL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_arrivals_stop ON stop_arrivals(stop_id, ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_arrivals_vehicle ON stop_arrivals(vehicle_id, ts)`);

  // GTFS official stop metadata (names, coords, accessibility)
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id       INTEGER PRIMARY KEY,
    stop_code     TEXT,
    stop_name     TEXT,
    stop_lat      REAL,
    stop_lon      REAL,
    wheelchair    INTEGER DEFAULT 0
  )`);

  // GTFS scheduled stop times from official county feed
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_stop_times (
    route_id    INTEGER NOT NULL,
    trip_id     TEXT NOT NULL,
    service_id  TEXT NOT NULL,
    direction   INTEGER NOT NULL DEFAULT 0,
    stop_id     INTEGER NOT NULL,
    stop_seq    INTEGER NOT NULL,
    arrival_sec INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gtfs_route_stop ON gtfs_stop_times(route_id, stop_id)`);

  // GTFS trips — maps the realtime feed's trip_id to route / direction / shape
  db.run(`CREATE TABLE IF NOT EXISTS gtfs_trips (
    trip_id     TEXT PRIMARY KEY,
    route_id    INTEGER,
    service_id  TEXT,
    direction   INTEGER,
    shape_id    TEXT,
    headsign    TEXT
  )`);

  // Persist DB to disk periodically (the actual interval is set in boot)
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    // Push a durable off-box snapshot (throttled internally to ~5 min) so history
    // survives a redeploy on ephemeral hosts. No-op when backup isn't configured.
    if (backup.isEnabled()) backup.snapshot(Buffer.from(data)).catch(() => {});
  } catch(e) { console.error('[db] Save error:', e.message); }
}

// Keep the DB lean: raw GPS pings and poll logs are only useful for recent
// history and short-term training. Long-term signal lives in stop_arrivals,
// which we keep. Prunes then VACUUMs to actually reclaim disk.
const PINGS_RETAIN_MS    = 14 * 86400000; // 2 weeks of raw GPS
const POLLLOG_RETAIN_MS  = 6 * 3600000;   // 6h of poll telemetry (/api/stats only reads the last 1h)
const ARRIVALS_RETAIN_MS = 365 * 86400000; // 1 year of arrivals — long enough to surface weekly/seasonal patterns, small in absolute terms (~1k rows/active stop)
function pruneDb() {
  if (!db) return;
  try {
    const now = Date.now();
    db.run(`DELETE FROM pings WHERE ts < ?`, [now - PINGS_RETAIN_MS]);
    db.run(`DELETE FROM poll_log WHERE ts < ?`, [now - POLLLOG_RETAIN_MS]);
    db.run(`DELETE FROM stop_arrivals WHERE ts < ?`, [now - ARRIVALS_RETAIN_MS]);
    db.run('VACUUM');
    saveDb();
    const sz = fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1024) : 0;
    console.log(`[db] Pruned + vacuumed (${sz} KB)`);
  } catch(e) { console.error('[db] Prune error:', e.message); }
}

// ─── GTFS LOADER ─────────────────────────────────────────────────────────────
function parseTimeToSec(t) {
  // GTFS times can be >24:00:00 for next-day runs
  const parts = t.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function splitCsvLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = splitCsvLine(lines[0].replace(/\r/g, ''));
  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line.replace(/\r/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

const GTFS_META_PATH = path.join(DATA_DIR, 'heleon-gtfs-meta.json');

function gtfsMeta() {
  try { return JSON.parse(fs.readFileSync(GTFS_META_PATH, 'utf8')); } catch { return {}; }
}
function saveGtfsMeta(meta) {
  fs.writeFileSync(GTFS_META_PATH, JSON.stringify(meta));
}

async function downloadGtfsIfUpdated() {
  const meta = gtfsMeta();
  const tmpPath = GTFS_ZIP_PATH + '.tmp';

  return new Promise((resolve, reject) => {
    const reqHeaders = { 'Referer': 'https://myheleonbus.org/', 'User-Agent': 'Mozilla/5.0' };
    if (meta.lastModified) reqHeaders['If-Modified-Since'] = meta.lastModified;
    if (meta.etag) reqHeaders['If-None-Match'] = meta.etag;

    const req = https.get({ hostname: 'myheleonbus.org', path: '/gtfs', headers: reqHeaders }, res => {
      if (res.statusCode === 304) {
        console.log('[gtfs] Feed unchanged (304), using cached copy');
        resolve(false); // not updated
        return;
      }
      if (res.statusCode !== 200) {
        console.error(`[gtfs] Download failed: HTTP ${res.statusCode}`);
        res.resume();
        resolve(false);
        return;
      }
      const file = fs.createWriteStream(tmpPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            // Atomic replace
            fs.renameSync(tmpPath, GTFS_ZIP_PATH);
            const newMeta = {};
            if (res.headers['last-modified']) newMeta.lastModified = res.headers['last-modified'];
            if (res.headers['etag']) newMeta.etag = res.headers['etag'];
            newMeta.downloadedAt = Date.now();
            saveGtfsMeta(newMeta);
            console.log('[gtfs] Downloaded fresh feed');
            resolve(true); // updated
          } catch(e) { reject(e); }
        });
      });
      file.on('error', e => { try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
    });
    req.on('error', e => { try { fs.unlinkSync(tmpPath); } catch {} reject(e); });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseGtfsZip() {
  const tripsText = execSync(`unzip -p "${GTFS_ZIP_PATH}" trips.txt`).toString();
  const stText = execSync(`unzip -p "${GTFS_ZIP_PATH}" stop_times.txt`).toString();
  const stopsText = execSync(`unzip -p "${GTFS_ZIP_PATH}" stops.txt`).toString();
  const trips = parseCsv(tripsText);
  const stopTimes = parseCsv(stText);
  const gtfsStops = parseCsv(stopsText);

  const tripMap = {};
  const tripRows = [];
  trips.forEach(t => {
    tripMap[t.trip_id] = {
      route_id: parseInt(t.route_id),
      service_id: t.service_id,
      direction_id: parseInt(t.direction_id) || 0,
    };
    tripRows.push([t.trip_id, parseInt(t.route_id), t.service_id,
                   parseInt(t.direction_id) || 0, t.shape_id || '', t.trip_headsign || '']);
  });

  const stRows = [];
  stopTimes.forEach(st => {
    const trip = tripMap[st.trip_id];
    if (!trip) return;
    const arrSec = parseTimeToSec(st.arrival_time || st.departure_time);
    stRows.push([trip.route_id, st.trip_id, trip.service_id, trip.direction_id,
                 parseInt(st.stop_id), parseInt(st.stop_sequence), arrSec]);
  });

  const stopRows = gtfsStops.map(s => [
    parseInt(s.stop_id), s.stop_code, s.stop_name,
    parseFloat(s.stop_lat), parseFloat(s.stop_lon),
    parseInt(s.wheelchair_boarding) || 0
  ]).filter(r => !isNaN(r[0]));

  return { stRows, stopRows, tripRows };
}

// Encode [[lat,lon],…] as a Google-format polyline (precision 1e5) — same format
// the upstream pattern shapes use, so the frontend decodes both identically.
function encodePolyline(coords) {
  let last = [0, 0], out = '';
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const c of coords) {
    const lat = Math.round(c[0] * 1e5), lng = Math.round(c[1] * 1e5);
    out += enc(lat - last[0]) + enc(lng - last[1]); last = [lat, lng];
  }
  return out;
}

// Load route geometry from a GTFS zip's shapes.txt for routes that have no shape
// yet (schedule-only Neighborhood/Flex/shuttle routes the live API doesn't serve).
// `shortToApp` maps a GTFS route_id (short number) to the app id we store under.
// Returns count added. Used twice: the LIVE zip, then the bundled SEED zip — the
// seed still carries 401/301/204 geometry that the current live feed dropped.
function loadShapesFromZip(zipPath, shortToApp) {
  let shapesText, tripsText;
  try {
    const opts = { maxBuffer: 64 * 1024 * 1024 }; // shapes.txt ~2MB
    shapesText = execSync(`unzip -p "${zipPath}" shapes.txt`, opts).toString();
    tripsText  = execSync(`unzip -p "${zipPath}" trips.txt`,  opts).toString();
  } catch (e) { console.error(`[gtfs-shapes] read error (${path.basename(zipPath)}):`, e.message); return 0; }

  const shapeToRoute = {};
  parseCsv(tripsText).forEach(t => { if (t.shape_id) shapeToRoute[t.shape_id] = String(t.route_id); });

  const byShape = {};
  parseCsv(shapesText).forEach(r => {
    const sid = r.shape_id; if (!sid) return;
    const lat = parseFloat(r.shape_pt_lat), lon = parseFloat(r.shape_pt_lon);
    const seq = parseInt(r.shape_pt_sequence) || 0;
    if (isNaN(lat) || isNaN(lon)) return;
    (byShape[sid] = byShape[sid] || []).push([seq, lat, lon]);
  });

  // Group shapes by route, keeping EVERY distinct variant (a route like 401 has
  // a northern AND a southern loop — drawing only the longest one drops half the
  // route). De-dup near-identical variants so we don't stack the same line twice.
  const shapesByRoute = {};
  for (const [sid, raw] of Object.entries(byShape)) {
    const rid = shapeToRoute[sid]; if (!rid) continue;
    const pts = raw.sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
    if (pts.length < 2) continue;
    (shapesByRoute[rid] = shapesByRoute[rid] || []).push({ sid, pts });
  }

  let added = 0;
  for (const [gtfsRid, variants] of Object.entries(shapesByRoute)) {
    const appId = shortToApp[gtfsRid] != null ? shortToApp[gtfsRid] : parseInt(gtfsRid);
    const existing = dbGet(`SELECT COUNT(*) as n FROM route_shapes WHERE route_id=?`, [appId]);
    if (existing && existing.n > 0) continue; // already have shapes (upstream or prior load)
    const meta = ROUTE_MAP[appId] || {};

    // Keep distinct variants: drop one if its endpoints + length closely match an
    // already-kept variant (same pattern, opposite direction or duplicate).
    const kept = [];
    variants.sort((a, b) => b.pts.length - a.pts.length); // longest first
    for (const v of variants) {
      const sig = `${v.pts[0].map(n=>n.toFixed(3))}|${v.pts[v.pts.length-1].map(n=>n.toFixed(3))}|${Math.round(v.pts.length/20)}`;
      if (kept.some(k => k.sig === sig)) continue;
      kept.push({ ...v, sig });
    }

    kept.forEach((v, i) => {
      dbRun(`INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
             VALUES(?,?,?,?,?,?,?)`,
        // Synthetic pattern id per variant (appId, appId+1000*i) so all variants coexist.
        [appId, appId + i * 100000, meta.name || `Route ${gtfsRid}`, i, meta.color || '#888', encodePolyline(v.pts), Date.now()]);
      added++;
    });
    console.log(`[gtfs-shapes] route ${gtfsRid} (app id ${appId}) loaded ${kept.length} variant(s) from ${path.basename(zipPath)}`);
  }
  return added;
}

// ─── AUTHORITATIVE ROUTE REGISTRY ─────────────────────────────────────────────
// One canonical list of every route the system knows about, unioned across ALL
// sources so nothing slips through the cracks: the curated ROUTES config, the
// live RTPI API, the live GTFS feed, the bundled seed GTFS, the reference file,
// and routes inferred purely from observed GPS history. Each entry records where
// its data came from (provenance) and whether it has a drawn shape, a live
// vehicle, and a classification. Served at /api/registry; logged at boot so any
// route lacking geometry is visible immediately instead of being silently missing.
let ROUTE_REGISTRY = [];
function buildRouteRegistry() {
  const reg = {}; // short -> entry
  const touch = short => (reg[short] = reg[short] || {
    short, appId: null, name: null, color: null, class: null,
    hasShape: false, hasLiveVehicle: false, sources: [],
  });
  const addSrc = (e, s) => { if (!e.sources.includes(s)) e.sources.push(s); };

  // 1) Curated ROUTES config (incl. scheduleOnly).
  ROUTES.forEach(r => {
    const e = touch(String(r.short));
    e.appId = r.id; e.name = r.name; e.color = r.color;
    if (r.scheduleOnly) addSrc(e, 'config:scheduleOnly'); else addSrc(e, 'config');
  });

  // 2) Reference file (classification + GTFS-derived roster).
  const refClass = (REFERENCE && REFERENCE.routeClass) || {};
  const refRoutes = (REFERENCE && REFERENCE.routes) || {};
  Object.keys(refClass).forEach(short => { const e = touch(short); e.class = refClass[short]; addSrc(e, 'reference'); });
  Object.entries(refRoutes).forEach(([short, r]) => {
    const e = touch(short);
    if (!e.name && r.name) e.name = r.name;
    if (!e.color && r.color) e.color = r.color;
    addSrc(e, 'gtfs');
  });

  // 3) Which routes actually have a drawn shape in the DB.
  const shapeRows = dbAll(`SELECT DISTINCT route_id FROM route_shapes`);
  const shapeAppIds = new Set(shapeRows.map(r => String(r.route_id)));
  // 4) Which routes have a live vehicle right now.
  const liveRows = dbAll(`SELECT DISTINCT route_id FROM pings WHERE ts > ?`, [Date.now() - 3600000]);
  const liveAppIds = new Set(liveRows.map(r => String(r.route_id)));

  // Resolve appId per entry (config gives it; else fall back to the short number),
  // then flag shape/live presence.
  Object.values(reg).forEach(e => {
    if (e.appId == null) e.appId = parseInt(e.short) || e.short;
    if (shapeAppIds.has(String(e.appId))) e.hasShape = true;
    if (liveAppIds.has(String(e.appId))) { e.hasLiveVehicle = true; addSrc(e, 'live'); }
  });

  ROUTE_REGISTRY = Object.values(reg).sort((a, b) => (parseInt(a.short) || 0) - (parseInt(b.short) || 0));

  // Loudly surface any route with NO geometry so it can't be silently missing.
  const noShape = ROUTE_REGISTRY.filter(e => !e.hasShape);
  console.log(`[registry] ${ROUTE_REGISTRY.length} routes known; ${ROUTE_REGISTRY.filter(e=>e.hasShape).length} have shapes`);
  if (noShape.length) console.warn(`[registry] NO SHAPE for: ${noShape.map(e => e.short).join(', ')} — investigate (live API? GTFS? seed?)`);
  return ROUTE_REGISTRY;
}

// Fill in geometry for every schedule-only route that still has no drawn shape.
function loadGtfsShapesForMissing() {
  // App ids for schedule-only routes are their GTFS short number; live routes
  // keep their 5600+ id. Build the short→app map so both zips store consistently.
  const shortToApp = {};
  ROUTES.forEach(r => { shortToApp[String(r.short)] = r.id; });

  let added = 0;
  // 1) The live feed first (current, authoritative for routes it carries).
  if (fs.existsSync(GTFS_ZIP_PATH)) added += loadShapesFromZip(GTFS_ZIP_PATH, shortToApp);
  // 2) The bundled seed feed for routes the live one dropped (401/301/204) but
  //    that the agency still operates (e.g. you can watch a bus drive the 401 loop).
  if (fs.existsSync(SEED_GTFS_PATH)) added += loadShapesFromZip(SEED_GTFS_PATH, shortToApp);
  if (added) { saveDb(); console.log(`[gtfs-shapes] added ${added} schedule-only route shapes`); }
}

async function loadGtfs(forceRefresh = false) {
  const n = dbGet(`SELECT COUNT(*) as n FROM gtfs_stop_times`);
  const hasData = n && n.n > 0;

  // If we have data and aren't forcing refresh, just check if feed changed
  if (hasData && !forceRefresh) {
    console.log(`[gtfs] ${n.n} scheduled stop times cached`);
    return;
  }

  // Download feed (conditional request — skips if unchanged)
  let downloaded = false;
  if (!fs.existsSync(GTFS_ZIP_PATH) || forceRefresh) {
    try {
      downloaded = await downloadGtfsIfUpdated();
    } catch(e) {
      console.error('[gtfs] Download error:', e.message);
      if (!hasData) console.error('[gtfs] No cached data — scheduled times unavailable');
      return; // keep existing data intact
    }
  } else {
    downloaded = true; // zip exists but DB is empty — parse it
  }

  if (!downloaded && hasData) return; // feed unchanged, keep existing data

  // Parse zip — keep old data in DB until new data is ready
  console.log('[gtfs] Parsing GTFS feed…');
  let parsed;
  try {
    parsed = parseGtfsZip();
  } catch(e) {
    console.error('[gtfs] Parse error:', e.message);
    return; // keep existing data
  }

  const { stRows, stopRows, tripRows } = parsed;
  if (stRows.length < 100) {
    console.error(`[gtfs] Suspiciously few rows (${stRows.length}) — aborting reload to protect existing data`);
    return;
  }

  // Atomic swap: insert all new rows, then delete old ones in one transaction
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM gtfs_stop_times');
    stRows.forEach(r => {
      db.run(`INSERT INTO gtfs_stop_times(route_id,trip_id,service_id,direction,stop_id,stop_seq,arrival_sec) VALUES(?,?,?,?,?,?,?)`, r);
    });
    db.run('DELETE FROM gtfs_stops');
    stopRows.forEach(r => {
      db.run(`INSERT INTO gtfs_stops(stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair) VALUES(?,?,?,?,?,?)`, r);
    });
    db.run('DELETE FROM gtfs_trips');
    (tripRows || []).forEach(r => {
      db.run(`INSERT OR REPLACE INTO gtfs_trips(trip_id,route_id,service_id,direction,shape_id,headsign) VALUES(?,?,?,?,?,?)`, r);
    });
    db.run('COMMIT');
    saveDb();
    buildTripIndex();
    console.log(`[gtfs] Loaded ${stRows.length} stop times, ${stopRows.length} stops, ${(tripRows||[]).length} trips`);
  } catch(e) {
    db.run('ROLLBACK');
    console.error('[gtfs] DB insert error:', e.message);
  }
}

function dbRun(sql, params = []) {
  db.run(sql, params);
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

// ─── UPSTREAM FETCH ───────────────────────────────────────────────────────────
function upstreamFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: UPSTREAM,
      path: `/api/rtpi?path=${encodeURIComponent(apiPath)}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://myheleonbus.org/' },
      timeout: 8000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, latency: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── WEATHER (Open-Meteo — free, no API key) ───────────────────────────────
// Big Island microclimates vary wildly (rainy Hilo vs sunny Kona), so we fetch
// current conditions at each active bus's location. Done server-side and cached
// ~10 min so it's one shared request, not per-client (saves mobile battery/data).
let weatherByVehicle = {}; // vehicleId -> { tempF, code, isDay, ts }
let weatherLastFetch = 0;
const WEATHER_TTL_MS = 10 * 60 * 1000;

function fetchJson(host, reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'heleon-tracker' }, timeout: 10000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function refreshWeather() {
  const now = Date.now();
  if (now - weatherLastFetch < WEATHER_TTL_MS) return;
  const buses = latestVehicles.filter(v => v.lat != null && v.lon != null);
  if (!buses.length) return;
  weatherLastFetch = now;
  const lats = buses.map(v => v.lat.toFixed(3)).join(',');
  const lons = buses.map(v => v.lon.toFixed(3)).join(',');
  try {
    const path = `/v1/forecast?latitude=${lats}&longitude=${lons}` +
                 `&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit`;
    let data = await fetchJson('api.open-meteo.com', path);
    if (!Array.isArray(data)) data = [data]; // single point isn't wrapped in an array
    const next = {};
    buses.forEach((v, i) => {
      const cur = data[i] && data[i].current;
      if (cur) next[v.id] = { tempF: Math.round(cur.temperature_2m), code: cur.weather_code, isDay: !!cur.is_day, ts: now };
    });
    weatherByVehicle = next;
  } catch (e) { /* weather is best-effort; keep last good values */ }
}

// Per-stop weather — same idea as per-bus, but for every official stop, so a
// rider can see current conditions at a stop before a bus is even nearby.
// Stops don't move, so this refreshes on a much slower cadence than buses.
let weatherByStop = {}; // stop_id -> { tempF, code, isDay, ts }
let weatherStopLastFetch = 0;
const WEATHER_STOP_TTL_MS = 20 * 60 * 1000;
async function refreshStopWeather() {
  const now = Date.now();
  if (now - weatherStopLastFetch < WEATHER_STOP_TTL_MS) return;
  const rows = dbAll(`SELECT stop_id, stop_lat, stop_lon FROM gtfs_stops WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL`);
  if (!rows.length) return;
  weatherStopLastFetch = now;
  // Open-Meteo accepts up to 1000 locations per call — comfortably above our
  // ~350 stops, so one request covers the whole island in one shot.
  const lats = rows.map(r => r.stop_lat.toFixed(3)).join(',');
  const lons = rows.map(r => r.stop_lon.toFixed(3)).join(',');
  try {
    const path = `/v1/forecast?latitude=${lats}&longitude=${lons}` +
                 `&current=temperature_2m,weather_code,is_day&temperature_unit=fahrenheit`;
    let data = await fetchJson('api.open-meteo.com', path);
    if (!Array.isArray(data)) data = [data];
    const next = {};
    rows.forEach((r, i) => {
      const cur = data[i] && data[i].current;
      if (cur) next[r.stop_id] = { tempF: Math.round(cur.temperature_2m), code: cur.weather_code, isDay: !!cur.is_day, ts: now };
    });
    weatherByStop = next;
  } catch (e) { /* best-effort; keep last good values */ }
}

// Fetch a binary body (GTFS-RT protobuf) from the upstream host.
function fetchBinary(reqPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: UPSTREAM, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `https://${UPSTREAM}/` },
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), latency: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
let latestVehicles = [];
let tripUpdateIndex = {};   // tripId -> { stopId: predictedArrivalMs }
let vehicleTripMap = {};    // vehicleId -> tripId  (merged from both RT feeds)
let lastPollStats = { ts: null, total: 0 };
const startTime = new Date().toISOString();

// trip_id -> { routeId, direction, shapeId, headsign } built from GTFS trips.txt.
// Lets us attach full route context to each live vehicle from the realtime feed.
let tripRouteIndex = {};
let tripLastBuilt = 0;

// Track last known closest-stop index per vehicle for arrival detection
const vehicleLastStopIdx = {}; // vehicleId -> { stopIdx, stopId, ts }
const vehicleRecentArrival = {}; // vehicleId -> { stopId, ts } — debounce dup arrivals

function buildTripIndex() {
  const rows = dbAll(`SELECT trip_id, route_id, direction, shape_id, headsign FROM gtfs_trips`);
  const idx = {};
  rows.forEach(r => { idx[r.trip_id] = { routeId: r.route_id, direction: r.direction, shapeId: r.shape_id, headsign: r.headsign }; });
  tripRouteIndex = idx;
  tripLastBuilt = Date.now();
  return rows.length;
}

// We do NOT infer a bus's route from geometry. A bus's route comes only from the
// agency feed (its per-route endpoint, remembered briefly across dropouts). If we
// don't know it, we show no route rather than a guess.

// Token-level feature vector dimensions. Hoisted to module scope so the TX
// object below can read them during init.
const TX_TOKEN_DIM = 7;
const TX_RANK_HEADS = 5;

// ─── TRANSFORMER PREDICTOR (tiny single-block, single-head attention) ──────
// Architecture:
//   1. Input embedding (12 tokens × 8-dim) — each token is one feature
//      (speed, distance, hour, minute, dow, sched_delta, route) with positional
//      encoding baked in
//   2. Single self-attention head over all 12 tokens
//      Q = X·Wq, K = X·Wk, V = X·Wv  (8×8 projections)
//      attn = softmax(Q·Kᵀ / √d)
//      out = attn·V
//   3. LayerNorm + residual
//   4. FFN: 8→16 (ReLU) → 8
//   5. Mean pool over tokens → 5 output heads (one per future stop)
// Total params: ~280
const TX = {
  _routeIds: null,
  get routeIds() {
    if (!this._routeIds) this._routeIds = ROUTES.map(r => r.id);
    return this._routeIds;
  },
  dModel: 8,            // token embedding dim
  nTokens: 12,          // sequence length
  rawDim: TX_TOKEN_DIM, // updated when init() runs
  nHeads: 1,
  ffnDim: 16,
  outDim: TX_RANK_HEADS, // one head per "stop rank ahead" — 1st..5th
  // weights
  embedW: [],           // inputProj (raw feature) → dModel  [dModel × rawDim]
  posW: [],             // positional encoding [dModel × nTokens]
  Wq: [], Wk: [], Wv: [], // [dModel × dModel]
  Wo: [],               // out projection after attention [dModel × dModel]
  ffnW1: [], ffnB1: [], // [ffnDim × dModel]
  ffnW2: [], ffnB2: [], // [dModel × ffnDim]
  // Per-rank projection: outW[r][d] is head for the r-th stop ahead. We project
  // the r-th token's FFN output directly to its rank-r prediction, so token i
  // maps to head i (clamped to outDim-1 for further-out stops).
  outW: [], outB: [],   // [outDim × dModel]
  lnGamma: [], lnBeta: [],// [dModel]
  lr: 0.005,
  decay: 0.9999,
  trained: false,
  trainedCount: 0,

  init() {
    const r = (rows, cols) => Array.from({length: rows}, () =>
      Array.from({length: cols}, () => (Math.random() - 0.5) * 0.3));
    this.rawDim = TX_TOKEN_DIM;
    this.embedW = r(this.dModel, this.rawDim);
    this.posW = r(this.dModel, this.nTokens);
    this.Wq = r(this.dModel, this.dModel);
    this.Wk = r(this.dModel, this.dModel);
    this.Wv = r(this.dModel, this.dModel);
    this.Wo = r(this.dModel, this.dModel);
    this.ffnW1 = r(this.ffnDim, this.dModel);
    this.ffnB1 = Array(this.ffnDim).fill(0);
    this.ffnW2 = r(this.dModel, this.ffnDim);
    this.ffnB2 = Array(this.dModel).fill(0);
    this.outW = r(this.outDim, this.dModel);
    this.outB = Array(this.outDim).fill(0);
    this.lnGamma = Array(this.dModel).fill(1);
    this.lnBeta = Array(this.dModel).fill(0);
    this.trained = true;
  },

  // Forward pass — returns full intermediate state for backprop
  forward(tokens) {
    // tokens: array of nTokens × rawDim (e.g. 12 × 5)
    // Step 1: embed each token + add positional encoding
    //   x[i] = tokens[i] · embedWᵀ  (dModel)
    //   x[i] += posW[:, i]
    const x = []; // nTokens × dModel
    for (let i = 0; i < this.nTokens; i++) {
      const tok = tokens[i];
      const vec = Array(this.dModel).fill(0);
      for (let d = 0; d < this.dModel; d++) {
        let s = 0;
        for (let k = 0; k < tok.length; k++) s += this.embedW[d][k] * tok[k];
        s += this.posW[d][i];
        vec[d] = s;
      }
      x.push(vec);
    }
    // Step 2: QKV projections
    const Q = x.map(v => matVec(this.Wq, v));
    const K = x.map(v => matVec(this.Wk, v));
    const V = x.map(v => matVec(this.Wv, v));
    // Step 3: attention scores = Q·Kᵀ / sqrt(d)
    const scale = 1 / Math.sqrt(this.dModel);
    const scores = [];
    for (let i = 0; i < this.nTokens; i++) {
      const row = [];
      for (let j = 0; j < this.nTokens; j++) {
        row.push(dot(Q[i], K[j]) * scale);
      }
      scores.push(row);
    }
    // Step 4: softmax per row
    const attn = scores.map(row => softmax(row));
    // Step 5: weighted sum of V
    const ctx = [];
    for (let i = 0; i < this.nTokens; i++) {
      const v = Array(this.dModel).fill(0);
      for (let j = 0; j < this.nTokens; j++) {
        for (let d = 0; d < this.dModel; d++) {
          v[d] += attn[i][j] * V[j][d];
        }
      }
      ctx.push(v);
    }
    // Step 6: output projection
    const attnOut = ctx.map(v => matVec(this.Wo, v));
    // Step 7: residual + LayerNorm
    const postAttn = x.map((v, i) => {
      const sum = v.map((xi, d) => xi + attnOut[i][d]);
      return layerNorm(sum, this.lnGamma, this.lnBeta);
    });
    // Step 8: FFN
    const ffnOut = postAttn.map(v => {
      const h = this.ffnW1.map((row, i) => {
        let s = this.ffnB1[i];
        for (let j = 0; j < v.length; j++) s += row[j] * v[j];
        return Math.max(0, s);
      });
      const out = Array(this.dModel).fill(0);
      for (let d = 0; d < this.dModel; d++) {
        let s = this.ffnB2[d];
        for (let i = 0; i < this.ffnDim; i++) s += this.ffnW2[d][i] * h[i];
        out[d] = s;
      }
      // Residual
      return v.map((xi, d) => xi + out[d]);
    });
    // Step 9: mean pool over tokens (kept for API compatibility / introspection)
    const pooled = Array(this.dModel).fill(0);
    for (const v of ffnOut) for (let d = 0; d < this.dModel; d++) pooled[d] += v[d] / this.nTokens;
    // Step 10: per-token output heads. Head r projects token r (clamped to
    // outDim-1). For tokens beyond outDim-1 we still emit a head value (we
    // reuse outW[outDim-1]) so the API has a token per token, but only the
    // first outDim tokens carry distinct signal.
    const tokenOut = ffnOut.map((tokFFN, i) => {
      const head = Math.min(i, this.outDim - 1);
      const row = this.outW[head];
      let s = this.outB[head];
      for (let j = 0; j < tokFFN.length; j++) s += row[j] * tokFFN[j];
      return s;
    });
    // Step 11: also expose a pooled head (mean of per-token outputs) — kept
    // for any caller that wants a single scalar per bus.
    let out = 0;
    for (const v of tokenOut) out += v;
    out /= this.nTokens;

    return { tokens, x, Q, K, V, scores, attn, ctx, attnOut, postAttn, ffnOut, pooled, tokenOut, out };
  },

  // Backprop via truncated SGD on the output layer + FFN-output (proxy training).
  // For a true transformer we'd backprop through attention, but a partial
  // gradient on outW + ffnW2 captures most of the signal and stays fast.
  // Targets map to specific tokens: target k (the residual for the k-th stop
  // ahead) is trained against tokenOut[k]. Tokens beyond outDim-1 contribute
  // no target and are skipped.
  train(tokens, targets) {
    if (!this.trained) this.init();
    const fwd = this.forward(tokens);
    const errs = [];
    let nValid = 0;
    for (let k = 0; k < this.outDim; k++) {
      const t = targets[k];
      if (t == null) { errs.push(0); continue; }
      errs.push(t - fwd.tokenOut[k]);
      nValid++;
    }
    if (nValid === 0) return 0;
    const scaledErrs = errs.map(e => e / nValid);
    // Per-token gradient: head k uses token k's ffn output (not the mean pool).
    for (let k = 0; k < this.outDim; k++) {
      if (scaledErrs[k] === 0) continue;
      const tokVec = fwd.ffnOut[k];
      for (let j = 0; j < this.dModel; j++) {
        this.outW[k][j] += this.lr * scaledErrs[k] * tokVec[j];
      }
      this.outB[k] += this.lr * scaledErrs[k];
    }
    // Approximate FFN backprop: distribute d_out/k → ffnOut[k] → ffnW2. For
    // tokens beyond outDim-1 we have no direct signal, but their ffn outputs
    // still contribute through the mean pool residual (so we add a small
    // scaled signal there too — keeps the network from drifting on un-trained
    // heads but doesn't dominate).
    for (let d = 0; d < this.dModel; d++) {
      for (let k = 0; k < this.nTokens; k++) {
        let dToFfn = 0;
        if (k < this.outDim && scaledErrs[k] !== 0) {
          for (let j = 0; j < this.dModel; j++) dToFfn += scaledErrs[k] * this.outW[Math.min(k, this.outDim - 1)][j];
        }
        // approximate ffn activations for token k
        const h = this.ffnW1.map((row, i) => {
          let s = this.ffnB1[i];
          for (let m = 0; m < fwd.postAttn[k].length; m++) s += row[m] * fwd.postAttn[k][m];
          return Math.max(0, s);
        });
        for (let i = 0; i < this.ffnDim; i++) {
          this.ffnW2[d][i] += this.lr * dToFfn * h[i];
        }
        this.ffnB2[d] += this.lr * dToFfn;
      }
    }
    this.lr *= this.decay;
    this.trainedCount++;
    return Math.abs(errs.reduce((a, b) => a + b, 0));
  },
};
TX.init();

function matVec(W, v) {
  const out = Array(W.length).fill(0);
  for (let i = 0; i < W.length; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += W[i][j] * v[j];
    out[i] = s;
  }
  return out;
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function softmax(row) {
  const m = Math.max(...row);
  const exps = row.map(v => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}
function layerNorm(x, gamma, beta) {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const variance = x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length;
  const std = Math.sqrt(variance + 1e-6);
  return x.map((xi, i) => gamma[i] * (xi - mean) / std + beta[i]);
}

// Build token sequence from bus state. Each token is a 7-dim vector that
// varies along the sequence — the same model must predict different
// corrections for the 1st..5th stops ahead, so the *n*-th token encodes
// "what's true for the n-th stop ahead":
//
//   [ speedNorm, distNormRankN, schedDeltaNormRankN, hourSin, hourCos, dowSin, dowCos ]
//
//   distNormRankN     = dist to stop N (extrapolated from current dist / ETA), clamped to [0,1]
//   schedDeltaNormRankN = how far ahead/behind schedule stop N is (signed)
//
// Time-of-day and day-of-week are sin/cos pairs so 23:59 sits next to 00:01
// and Sunday next to Monday (true cyclical continuity). The "rank-ahead"
// horizon dim is baked into the token *value*, and we additionally apply a
// positional encoding (posW) so the model also knows which token is which.
//
// Token-to-head mapping: token i corresponds to "the i-th stop ahead" — so
// the forward-pass output for token i is a good predictor for the head that
// targets "i stops ahead". Forward returns token-level outputs (not just the
// mean-pooled one) and we map head k to token k.

// Build token sequence from bus state. Each token is a 7-dim vector that
// varies along the sequence — the same model must predict different
// corrections for the 1st..5th stops ahead, so the *n*-th token encodes
// "what's true for the n-th stop ahead":
//
//   distNormRankN     = dist to stop N (extrapolated from current dist / ETA), clamped to [0,1]
//   schedDeltaNormRankN = how far ahead/behind schedule stop N is (signed)
//
// Time-of-day and day-of-week are sin/cos pairs so 23:59 sits next to 00:01
// and Sunday next to Monday (true cyclical continuity). The "rank-ahead"
// horizon dim is baked into the token *value*, and we additionally apply a
// positional encoding (posW) so the model also knows which token is which.
//
// Token-to-head mapping: token i corresponds to "the i-th stop ahead" — so
// the forward-pass output for token i is a good predictor for the head that
// targets "i stops ahead". Forward returns token-level outputs (not just the
// mean-pooled one) and we map head k to token k.
function buildTokenSequence(vehicle, distanceKm, schedDeltaSec, routeId, atMs) {
  // atMs lets a caller build the token sequence for a HISTORICAL moment (e.g.
  // training on a stop_arrivals row from 3 weeks ago) instead of always "now".
  // Defaulting to Date.now() keeps the live-prediction call sites unchanged.
  const now = new Date(atMs ?? Date.now());
  const hour = now.getHours() + now.getMinutes() / 60;
  const dow = now.getDay();
  const hourSin = Math.sin(2 * Math.PI * hour / 24);
  const hourCos = Math.cos(2 * Math.PI * hour / 24);
  const dowSin  = Math.sin(2 * Math.PI * dow / 7);
  const dowCos  = Math.cos(2 * Math.PI * dow / 7);
  const speedNorm = Math.min((vehicle.speed || 0) / 60, 1);
  const baseDist = Math.min((distanceKm || 0) / 30, 1);
  // Schedule delta: signed seconds / 600s (so ±10 min normalises to ±1)
  const schedDelta = schedDeltaSec != null
    ? Math.max(-1, Math.min(1, schedDeltaSec / 600))
    : 0;
  // Route id: one-hot-ish via single hashed scalar in [-1, 1] — gives the
  // model a per-route bias without exploding the embedding size.
  const routeScalar = routeId
    ? ((routeId * 2654435761) % 1024) / 512 - 1
    : 0;
  const tokens = [];
  for (let i = 0; i < 12; i++) {
    // Rank-ahead signal: token i encodes stop (i+1) ahead. Dist grows with
    // horizon (linearly extrap the bus's current speed over expected minutes
    // per stop), and we mix in schedule delta at diminishing weight so further
    // stops inherit less timing pressure.
    const horizonMin = (i + 1) * 1.5;                       // ~1.5 min per stop on average
    const horizonDist = Math.min(1, baseDist + speedNorm * horizonMin * 0.06);
    const horizonSched = schedDelta * (1 / (1 + i * 0.4));   // decays with rank
    tokens.push([
      speedNorm,
      horizonDist,
      horizonSched,
      hourSin,
      hourCos,
      dowSin,
      dowCos,
    ]);
  }
  return tokens;
}

// How far ahead/behind schedule a HISTORICAL arrival was, in signed seconds
// (positive = late), by matching it to the GTFS trip whose scheduled
// time-of-day is closest to when it actually happened (±2h tolerance — outside
// that there's no scheduled service to compare against, e.g. an off-hours
// deadhead). Mirrors the live "nearest scheduled trip to now" lookup used for
// the on-screen schedule-adherence badge, just evaluated at an arbitrary past
// timestamp instead of always "now" — this is what makes the schedule-delta
// token feature meaningful during training instead of always reading zero.
function scheduleDeltaAt(routeId, stopId, atMs) {
  const d = new Date(atMs);
  const daySec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  const candidates = dbAll(
    `SELECT arrival_sec FROM gtfs_stop_times WHERE route_id=? AND stop_id=?`,
    [routeId, stopId]
  );
  if (!candidates.length) return null;
  let best = null, bestDiff = Infinity;
  for (const c of candidates) {
    const sec = c.arrival_sec % 86400;
    const diff = Math.min(Math.abs(sec - daySec), 86400 - Math.abs(sec - daySec));
    if (diff < bestDiff) { bestDiff = diff; best = sec; }
  }
  if (best == null || bestDiff > 7200) return null; // no plausible scheduled trip
  // Signed delta: actual minus scheduled, wrapped the short way around midnight.
  let delta = daySec - best;
  if (delta > 43200) delta -= 86400; else if (delta < -43200) delta += 86400;
  return delta;
}

async function trainFromHistory() {
  console.log('[learn] Training transformer on stop_arrivals history…');
  // Pull from the FULL retained history (now up to 365 days — see
  // ARRIVALS_RETAIN_MS) so the model actually sees enough distinct
  // hour-of-day/day-of-week combinations to learn real patterns, not just
  // whatever happened in the last week. Capped at a few thousand rows per
  // training pass to keep this fast; trainFromHistory re-runs periodically
  // (see boot) so it cycles through history over time rather than needing it
  // all in one pass.
  const rows = dbAll(`
    SELECT sa.ts as actual_ts, sa.stop_id, sa.route_id, sa.vehicle_id,
           p.speed, p.lat, p.lon, s.lat as stop_lat, s.lon as stop_lon
    FROM stop_arrivals sa
    JOIN pings p ON p.vehicle_id = sa.vehicle_id AND ABS(sa.ts - p.ts) < 300000
    JOIN stops s ON s.id = sa.stop_id AND s.route_id = sa.route_id
    WHERE sa.ts > ?
    ORDER BY sa.ts DESC LIMIT 4000
  `, [Date.now() - ARRIVALS_RETAIN_MS]);
  console.log(`[learn] Got ${rows.length} training rows`);

  let totalLoss = 0, n = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = rows[i];
      if (!r.stop_lat) continue;
      const dist = haversineKm(r.lat, r.lon, r.stop_lat, r.stop_lon);
      if ((r.speed || 0) < 1 || dist < 0.05) continue;
      const naiveEta = (dist / (r.speed * 1.60934)) * 60;

      // rows is DESC by ts. We want arrivals that happened AFTER r — they
      // are at LOWER indices (earlier in DESC ordering). Slice i+1..end gives
      // earlier rows (negative ts delta), slice 0..i gives later rows (positive
      // ts delta = future). Sort by ts ASC so target k is the k-th future
      // arrival in time order.
      const later = rows.slice(0, i).filter(f =>
        f.vehicle_id === r.vehicle_id &&
        (f.actual_ts - r.actual_ts) > 0 &&
        (f.actual_ts - r.actual_ts) <= 60 * 60000
      ).sort((a, b) => a.actual_ts - b.actual_ts).slice(0, 5);
      const future = later;

      const targets = future.map(f => (f.actual_ts - r.actual_ts) / 60000 - naiveEta);
      while (targets.length < 5) targets.push(null);

      const schedDeltaSec = scheduleDeltaAt(r.route_id, r.stop_id, r.actual_ts);
      // Use the row's OWN arrival time for hour/day-of-week, not "now" — every
      // training example was previously stamped with whatever moment the
      // server happened to be training at, which collapsed the entire
      // time-of-day/day-of-week embedding to a single point and made it
      // impossible to learn rush-hour vs. midday patterns.
      const tokens = buildTokenSequence({ speed: r.speed }, dist, schedDeltaSec, r.route_id, r.actual_ts);
      const loss = TX.train(tokens, targets);
      totalLoss += loss; n++;
    } catch(e) { /* skip bad row */ }
  }
  console.log(`[learn] Trained transformer on ${n} examples, total loss: ${totalLoss.toFixed(1)}, lr=${TX.lr.toFixed(5)}`);
}

// Pull the TripUpdates feed → tripId -> { stopId: predictedArrivalMs, _seq }.
// These are the agency's official predicted arrival times (headline ETA).
async function pollTripUpdates() {
  let res;
  try { res = await fetchBinary(RT_TU_PATH); } catch { return; }
  if (res.status !== 200 || !res.buf.length) return;
  let feed;
  try { feed = parseFeedMessage(res.buf); } catch { return; }
  const idx = {};
  const now = Date.now();
  const tripMap = {}; // rebuilt fresh each poll so stale trips don't linger
  feed.forEach(e => {
    const tu = e.tripUpdate;
    if (!tu || !tu.trip || !tu.trip.tripId) return;
    const byStop = {};
    tu.stopTimeUpdates.forEach(s => {
      const t = (s.arrival && s.arrival.time) || (s.departure && s.departure.time);
      if (t && s.stopId) byStop[s.stopId] = { ms: t * 1000, seq: s.stopSeq };
    });
    idx[tu.trip.tripId] = byStop;
    // Map this vehicle to the trip it's *currently operating*. A vehicle appears
    // in the feed on several consecutive trips (its block); the active one is the
    // trip whose predicted-stop time window contains "now" (or starts soonest).
    if (tu.vehicleId) {
      const id = parseInt(tu.vehicleId) || tu.vehicleId;
      const times = tu.stopTimeUpdates.map(s => s.arrival && s.arrival.time).filter(Boolean).map(t => t * 1000);
      if (times.length) {
        const firstMs = Math.min(...times), lastMs = Math.max(...times);
        // Score: 0 if now is within the trip's window (active), else distance to it.
        const score = now >= firstMs && now <= lastMs ? 0 : Math.min(Math.abs(firstMs - now), Math.abs(lastMs - now));
        const prev = tripMap[id];
        if (!prev || score < prev._score) {
          tripMap[id] = { tripId: tu.trip.tripId, _score: score };
        }
      }
    }
  });
  tripUpdateIndex = idx;
  vehicleTripMap = tripMap; // TripUpdates is authoritative for active trip
}

// Merge the VehiclePositions feed's vehicle→trip and bearing into shared maps.
// VP is sometimes laggy/incomplete on this feed, so it augments rather than
// drives the vehicle list (the fleet JSON below is the authoritative source).
const vpBearing = {};  // vehicleId -> { bearing, ts }
let vpTripMap = {};     // vehicleId -> tripId, used only when TripUpdates lacks the bus
const vpStatus = {};   // vehicleId -> { occupancyStatus, currentStatus, congestionLevel, ts }
async function pollVehiclePositions() {
  let res;
  try { res = await fetchBinary(RT_VP_PATH); } catch { return; }
  if (res.status !== 200 || !res.buf.length) return;
  let feed;
  try { feed = parseFeedMessage(res.buf); } catch { return; }
  const now = Date.now();
  const nextTrip = {};
  feed.forEach(e => {
    const vp = e.vehicle;
    if (!vp || !vp.vehicleId) return;
    const id = parseInt(vp.vehicleId) || vp.vehicleId;
    const tripId = vp.trip && vp.trip.tripId;
    if (tripId) nextTrip[id] = tripId;
    if (vp.bearing != null && vp.timestamp && (now - vp.timestamp * 1000) < VEHICLE_STALE_MS) {
      vpBearing[id] = { bearing: Math.round(vp.bearing), ts: vp.timestamp * 1000 };
    }
    if (vp.timestamp && (now - vp.timestamp * 1000) < VEHICLE_STALE_MS) {
      vpStatus[id] = {
        occupancyStatus: vp.occupancyStatus != null ? vp.occupancyStatus : null,
        currentStatus: vp.currentStatus != null ? vp.currentStatus : null,
        congestionLevel: vp.congestionLevel != null ? vp.congestionLevel : null,
        ts: vp.timestamp * 1000,
      };
    }
  });
  vpTripMap = nextTrip;
}

// Authoritative position source: routes/{id}/vehicles, polled per active route.
// Unlike the bare /vehicles roster (which carries NO speed/heading and is full
// of years-stale entries), this endpoint returns real motion data — speed,
// headingDegrees, patternId — and tells us the route for free. We poll every
// route in parallel and dedupe; a bus reported on multiple routes keeps the
// freshest reading. GTFS-RT feeds then enrich each bus with its active trip and
// official stop predictions. This is what makes arrows point the right way,
// ETAs work, and every running bus (e.g. route 2) actually appear.
// Last good per-vehicle reading, so a single failed/empty upstream poll never
// makes a bus vanish from the page (the rider in the rain keeps seeing it, just
// aging). Kept until the GPS itself goes stale (VEHICLE_STALE_MS).
const lastGoodVehicle = {}; // vehicleId -> built vehicle object
// Remember each bus's last KNOWN route (from a real per-route endpoint) so the
// roster fallback doesn't flip a bus onto a wrong nearest-shape guess when it
// briefly drops out of its route list. vehicleId -> { routeId, ts }.
const lastKnownRoute = {};
const ROUTE_MEMORY_MS = 6 * 60 * 60 * 1000; // trust a remembered route for 6 h

async function pollFleet() {
  const ts = Date.now();
  const byId = {}; // vehicleId -> raw reading (freshest wins)

  const results = await Promise.all(ROUTES.map(async route => {
    let res;
    try { res = await upstreamFetch(`routes/${route.id}/vehicles`); }
    catch { return { rid: route.id, status: 0, latency: 0, count: 0 }; }
    let arr = [];
    if (res.status === 200) { try { arr = JSON.parse(res.body); } catch {} }
    if (!Array.isArray(arr)) arr = [];
    return { rid: route.id, status: res.status, latency: res.latency, list: arr };
  }));

  results.forEach(r => {
    const list = r.list || [];
    list.forEach(raw => {
      if (raw.lat == null || raw.lon == null) return;
      if (raw.lat < BBOX.minLat || raw.lat > BBOX.maxLat || raw.lon < BBOX.minLon || raw.lon > BBOX.maxLon) return;
      const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
      if ((ts - luMs) > VEHICLE_RETAIN_MS) return; // keep last-known up to the retain window
      const prev = byId[raw.id];
      // Keep the reading from the route this bus is most freshly on; prefer one
      // with real speed/heading if timestamps tie.
      if (!prev || luMs > prev._luMs || (luMs === prev._luMs && (raw.speed || 0) > (prev.speed || 0))) {
        byId[raw.id] = Object.assign({}, raw, { _routeId: r.rid, _luMs: luMs });
      }
      // Remember this real route assignment (only from fresh readings) so the
      // roster fallback won't flip the bus onto a nearest-shape guess later.
      if ((ts - luMs) < VEHICLE_STALE_MS) lastKnownRoute[raw.id] = { routeId: r.rid, ts };
    });
    dbRun(`INSERT INTO poll_log(ts,route_id,status,latency,count) VALUES(?,?,?,?,?)`,
      [ts, r.rid, r.status, r.latency || 0, list.length]);
  });

  // Also sweep the full roster for buses that are reporting fresh GPS but aren't
  // assigned to any route's vehicle list (idle / between-runs). They'd otherwise
  // be invisible even though they're clearly out. We infer their route from the
  // nearest route shape so they still show in context.
  try {
    const roster = JSON.parse((await upstreamFetch('vehicles')).body);
    if (Array.isArray(roster)) roster.forEach(raw => {
      if (byId[raw.id]) return;                  // already have a per-route reading
      if (raw.lat == null || raw.lon == null) return;
      if (raw.lat < BBOX.minLat || raw.lat > BBOX.maxLat || raw.lon < BBOX.minLon || raw.lon > BBOX.maxLon) return;
      const luMs = raw.lastUpdated ? parseFleetTs(raw.lastUpdated) : ts;
      if ((ts - luMs) > VEHICLE_RETAIN_MS) return;
      // Use the bus's last KNOWN route from the real feed if we have a recent one
      // (so it keeps its real route through a brief dropout). We do NOT guess a
      // route from geometry — showing a fabricated route is worse than none.
      // A bus with no known route shows as route-less (not in service).
      const mem = lastKnownRoute[raw.id];
      const routeId = mem && (ts - mem.ts) < ROUTE_MEMORY_MS ? mem.routeId : null;
      byId[raw.id] = Object.assign({}, raw, { _routeId: routeId, _luMs: luMs, _unassigned: true });
    });
  } catch {}

  const vehicles = [];
  Object.values(byId).forEach(raw => {
    const id = raw.id;
    const luMs = raw._luMs;
    // Route is authoritative from the endpoint we found the bus on.
    const routeId = raw._routeId;
    const route = ROUTE_MAP[routeId];
    // Active trip + official predictions come from the RT feeds (best-effort).
    const tripId = (vehicleTripMap[id] && vehicleTripMap[id].tripId) || vpTripMap[id] || null;
    const ti = tripId ? tripRouteIndex[tripId] : null;
    // Heading: prefer the GTFS-RT bearing (smoothed), else the endpoint's value.
    const brg = vpBearing[id] && (ts - vpBearing[id].ts) < VEHICLE_STALE_MS ? vpBearing[id].bearing
              : (raw.headingDegrees != null ? Math.round(raw.headingDegrees) : null);
    const st = vpStatus[id] && (ts - vpStatus[id].ts) < VEHICLE_STALE_MS ? vpStatus[id] : null;
    const v = {
      id, name: raw.name || String(id),
      lat: raw.lat, lon: raw.lon,
      speed: raw.speed != null ? raw.speed : null,   // mph
      headingDegrees: brg,
      heading: raw.heading || null,                  // cardinal label (N/NE/…)
      passengerLoad: raw.passengerLoad != null ? raw.passengerLoad : 0,
      capacity: raw.capacity != null ? raw.capacity : null,
      shapeDistanceTraveled: raw.shapeDistanceTraveled || 0,
      patternId: raw.patternId || null,
      tripId,
      headsign: ti ? ti.headsign : null,
      direction: ti ? ti.direction : null,
      shapeId: ti ? ti.shapeId : null,
      vehicleTs: luMs,
      // The bare roster clock is skewed, so a roster-only age can come out
      // slightly negative — clamp sub-3h skew to "just now" rather than show a
      // bogus negative/stale age.
      ageMin: (() => { let a = (ts - luMs) / 60000; if (a < 0) a = a > -180 ? 0 : a; return Math.round(a * 10) / 10; })(),
      stale: (ts - luMs) > VEHICLE_STALE_MS && (ts - luMs) > 0,
      lastUpdated: new Date(luMs).toISOString(),
      routeId,
      unassigned: !!raw._unassigned,    // reporting GPS but not on a route's vehicle list now
      routeName: route ? route.name : 'Not in service',
      routeShort: route ? route.short : '—',
      routeColor: route ? route.color : '#8b949e',
      occupancyStatus: st ? st.occupancyStatus : null,   // GTFS-rt enum 0 EMPTY..8 NOT_BOARDABLE
      gtfsCurrentStatus: st ? st.currentStatus : null,   // 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO
      congestionLevel: st ? st.congestionLevel : null,   // 0 UNKNOWN..4 SEVERE_CONGESTION
    };
    // Buses drive on ROADS, not free GPS coordinates. Snap the reported point
    // onto the nearest real road-graph edge (within SNAP_RADIUS_M) so the dot
    // sits on the street it's actually on instead of floating in a yard or
    // between two parallel roads. Raw lat/lon are kept for the DB/telemetry;
    // snapLat/snapLon (+ how far it moved) are what the map draws.
    try {
      ensureTrailGraph();
      if (TRAIL_GRAPH && v.lat != null && v.lon != null) {
        const SNAP_RADIUS_M = 45;
        const snap = nearestPointOnGraph(TRAIL_GRAPH, TRAIL_EDGE_INDEX, [v.lon, v.lat], SNAP_RADIUS_M);
        if (snap) {
          v.snapLon = snap.point[0];
          v.snapLat = snap.point[1];
          v.snapDist = Math.round(snap.dist);
        }
      }
    } catch (e) { /* snapping is best-effort; fall back to raw GPS */ }
    vehicles.push(v);

    dbRun(`INSERT INTO pings (ts,vehicle_id,vehicle_name,route_id,pattern_id,lat,lon,speed,heading,heading_deg,passenger_load,capacity,shape_dist,last_updated,occupancy_status,gtfs_current_status,congestion_level)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, v.id, v.name, routeId, v.patternId, v.lat, v.lon, v.speed,
       v.heading, v.headingDegrees, v.passengerLoad, v.capacity, v.shapeDistanceTraveled, tripId,
       v.occupancyStatus, v.gtfsCurrentStatus, v.congestionLevel]);

    lastGoodVehicle[id] = v;
  });

  // Keep showing each bus's last-known position even after it stops reporting,
  // up to the retain window, so buses fade out gracefully instead of flickering
  // off and back on. The client renders opacity by ageMin.
  const seen = new Set(vehicles.map(v => v.id));
  Object.values(lastGoodVehicle).forEach(v => {
    if (seen.has(v.id)) return;
    if ((ts - v.vehicleTs) > VEHICLE_RETAIN_MS) { delete lastGoodVehicle[v.id]; return; }
    vehicles.push(Object.assign({}, v, {
      stale: true,
      ageMin: Math.round(((ts - v.vehicleTs) / 60000) * 10) / 10,
    }));
  });

  return vehicles;
}

// Two timestamp shapes from the agency: routes/{id}/vehicles gives ISO-8601 with
// a "Z" (UTC); the bare /vehicles roster gives no suffix and runs on Hawaiʻi
// local time (HST, UTC-10). Detect which and parse accordingly.
function parseFleetTs(s) {
  if (!s) return null;
  // Has an explicit zone (Z or ±hh:mm)? Then it's absolute — trust Date.parse.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  // Bare local time → interpret as HST (UTC-10).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 10, +m[5], +m[6]);
}

// Called after each poll — detect when a bus has moved past a stop
function detectArrivals(vehicle, routeId) {
  const stops = stopsCache[routeId];
  if (!stops || !stops.length) return;

  // Find closest stop index
  let minDist = Infinity, closestIdx = 0;
  stops.forEach((s, i) => {
    const d = haversineKm(vehicle.lat, vehicle.lon, s.lat, s.lon);
    if (d < minDist) { minDist = d; closestIdx = i; }
  });

  // Only record arrival if bus is within 200m of the stop
  if (minDist > 0.2) {
    // Update tracking but don't record arrival yet
    vehicleLastStopIdx[vehicle.id] = vehicleLastStopIdx[vehicle.id] || {};
    vehicleLastStopIdx[vehicle.id].pendingIdx = closestIdx;
    return;
  }

  const prev = vehicleLastStopIdx[vehicle.id];
  const stop = stops[closestIdx];

  // Debounce: don't re-record the same stop for this vehicle within 3 min. The
  // nearest stop can briefly flip away and back when a bus lingers near the 200 m
  // boundary (at a light / slow approach), which otherwise double-counts the
  // arrival — corrupting the predictor's training pairs and learned-stop dwell
  // counts. A genuine revisit on a loop takes far longer than 3 min.
  const recent = vehicleRecentArrival[vehicle.id];
  if (recent && recent.stopId === stop.id && (Date.now() - recent.ts) < 3 * 60000) return;

  // Record arrival if this is a new stop (advanced forward on route)
  if (!prev || prev.stopId !== stop.id) {
    const speedKmh = (vehicle.speed || 0) * 1.60934;

    // Get historical avg speed for this route over last hour
    const histRows = dbAll(
      `SELECT speed FROM pings WHERE route_id=? AND ts > ? AND speed > 0`,
      [routeId, Date.now() - 3600000]
    );
    const histAvgMph = histRows.length
      ? histRows.reduce((s, r) => s + r.speed, 0) / histRows.length
      : vehicle.speed || 0;

    dbRun(
      `INSERT INTO stop_arrivals(ts,vehicle_id,route_id,stop_id,stop_seq,eta_speed,eta_hist) VALUES(?,?,?,?,?,?,?)`,
      [Date.now(), vehicle.id, routeId, stop.id, closestIdx,
       vehicle.speed > 0 ? Math.round(minDist / (speedKmh / 60) * 10) / 10 : null,
       histAvgMph > 0 ? Math.round(minDist / ((histAvgMph * 1.60934) / 60) * 10) / 10 : null]
    );

    // Live online learning: feed this arrival into the transformer
    try {
      const prevArr = dbGet(
        `SELECT stop_seq, ts FROM stop_arrivals WHERE vehicle_id=? AND ts<? ORDER BY ts DESC LIMIT 1`,
        [vehicle.id]
      );
      if (prevArr) {
        const timeSince = (Date.now() - prevArr.ts) / 60000;
        if (timeSince > 0.5 && timeSince <= 60) {
          // Train on (state_at_prev_stop, arrival_at_this_stop) pair
          const prevState = dbGet(
            `SELECT p.speed, p.lat, p.lon FROM pings p WHERE p.vehicle_id=? AND ABS(p.ts - ?) < 300000 ORDER BY ABS(p.ts - ?) LIMIT 1`,
            [vehicle.id, prevArr.ts, prevArr.ts]
          );
          if (prevState) {
            const prevStop = stops.find(s => s.seq === prevArr.stop_seq);
            if (prevStop) {
              const dist = haversineKm(prevState.lat, prevState.lon, prevStop.lat, prevStop.lon);
              if ((prevState.speed || 0) > 1 && dist > 0.05) {
                const naiveEta = (dist / (prevState.speed * 1.60934)) * 60;
                const residual = timeSince - naiveEta;
                const schedDeltaSec = scheduleDeltaAt(routeId, prevStop.id, prevArr.ts);
                const tokens = buildTokenSequence({ speed: prevState.speed }, dist, schedDeltaSec, routeId, prevArr.ts);
                const targets = [residual, null, null, null, null];
                TX.train(tokens, targets);
              }
            }
          }
        }
      }
    } catch (e) { /* skip live training errors */ }

    vehicleLastStopIdx[vehicle.id] = { stopId: stop.id, stopIdx: closestIdx, stopSeq: stop.seq, ts: Date.now() };
    vehicleRecentArrival[vehicle.id] = { stopId: stop.id, ts: Date.now() };
  }
}

async function pollAll() {
  // Build the vehicle→trip + ETA maps from both RT feeds first, then read the
  // authoritative fleet list. Three cheap requests replace 22 per-route polls.
  await Promise.all([
    pollTripUpdates().catch(() => {}),
    pollVehiclePositions().catch(() => {}),
  ]);
  const vehicles = await pollFleet().catch(() => []);
  latestVehicles = vehicles;
  // Attach cached microclimate weather + refresh it in the background.
  latestVehicles.forEach(v => { v.weather = weatherByVehicle[v.id] || null; });
  refreshWeather().catch(() => {});
  refreshStopWeather().catch(() => {});
  // Detect stop arrivals for each active vehicle
  latestVehicles.forEach(v => {
    if (v.routeId) { try { detectArrivals(v, v.routeId); } catch(e) {} }
  });
  lastPollStats = { ts: Date.now(), total: latestVehicles.length };
  process.stdout.write(`\r[${new Date().toLocaleTimeString()}] ${latestVehicles.length} vehicles  `);
}

// ─── AUTO-DISCOVERY ───────────────────────────────────────────────────────────
async function discoverNewRoutes() {
  try {
    const r = await upstreamFetch('routes');
    if (r.status !== 200) return;
    const routes = JSON.parse(r.body);
    if (!Array.isArray(routes)) return;
    let added = 0;
    for (const route of routes) {
      const id = route.id;
      if (!ROUTE_MAP[id]) {
        const short = route.shortName || route.name || String(id);
        const name = route.name || short;
        const color = route.color ? `#${route.color}` : '#999999';
        const newRoute = { id, name, short, color };
        ROUTES.push(newRoute);
        ROUTE_MAP[id] = newRoute;
        console.log(`\n[discovery] New route found: ${name} (id=${id})`);
        // Fetch stops AND the route's shape so it draws immediately (was missing
        // the shape fetch before, so newly-discovered routes had no line until the
        // daily fetchShapes ran).
        fetchStopsForRoute(id).then(stops => { stopsCache[id] = stops; });
        (async () => {
          try {
            const pr = await upstreamFetch(`routes/${id}/patterns`);
            if (pr.status === 200) {
              const patterns = JSON.parse(pr.body);
              if (Array.isArray(patterns)) {
                patterns.forEach(pp => dbRun(
                  `INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
                   VALUES(?,?,?,?,?,?,?)`,
                  [id, pp.id, pp.name, pp.directionType, pp.color || color, pp.shape, Date.now()]));
                saveDb();
              }
            }
          } catch (e) { console.error(`[discovery] shape fetch ${id}:`, e.message); }
        })();
        added++;
      }
    }
    if (added > 0) saveDb();
  } catch(e) {
    console.error('\n[discovery] Error:', e.message);
  }
}

// ─── SHAPES ───────────────────────────────────────────────────────────────────
async function fetchShapes() {
  console.log('\n[shapes] Fetching route shapes…');
  for (const route of ROUTES) {
    try {
      const r = await upstreamFetch(`routes/${route.id}/patterns`);
      if (r.status !== 200) continue;
      const patterns = JSON.parse(r.body);
      if (!Array.isArray(patterns)) continue;
      patterns.forEach(p => {
        dbRun(`INSERT OR REPLACE INTO route_shapes(route_id,pattern_id,name,direction,color,shape,fetched_at)
          VALUES(?,?,?,?,?,?,?)`,
          [route.id, p.id, p.name, p.directionType, p.color || route.color, p.shape, Date.now()]);
      });
      process.stdout.write(`[shapes] ${route.short} ✓  `);
    } catch(e) { console.error(`\n[shapes] Error ${route.short}:`, e.message); }
    await new Promise(r => setTimeout(r, 250));
  }
  saveDb();
  console.log('\n[shapes] Done.');
}

// ─── ROAD-SNAP ALL ROUTE SHAPES (Valhalla map-matching, cached) ────────────────
// Snap every route PATTERN's GTFS shape onto real roads, ONCE, caching the result
// keyed by the raw shape's hash. Bad snaps are rejected by map-match.js (we keep
// raw for those). Runs in the background so it never blocks boot; the map upgrades
// to road-following lines as each pattern finishes. Cached in the DB → backed up →
// survives Render reboots, and only re-snaps a pattern whose shape actually changed.
let matchingInProgress = false;
async function matchAllShapes() {
  if (matchingInProgress) return;
  matchingInProgress = true;
  try {
    const rows = dbAll(`SELECT pattern_id, route_id, shape FROM route_shapes WHERE shape IS NOT NULL`);
    let snapped = 0, kept = 0, skipped = 0;
    const RETRY_RAW_MS = 24 * 60 * 60 * 1000; // re-attempt a kept-raw pattern after a day
    for (const row of rows) {
      // Vendored geometry is authoritative — never re-match a pattern we already
      // have a committed clean shape for (avoids any runtime Valhalla dependency).
      if (VENDORED_SHAPES[String(row.pattern_id)]) { skipped++; continue; }
      const h = shapeHash(row.shape);
      const cached = dbGet(`SELECT src_hash, is_raw, matched_at FROM route_shapes_matched WHERE pattern_id=?`, [row.pattern_id]);
      if (cached && cached.src_hash === h) {
        // A clean snap is cached forever (until the shape changes). A kept-raw
        // result is RETRIED periodically — Valhalla / OSM may have been having a
        // transient problem, so we self-heal rather than stay raw forever.
        if (!cached.is_raw) { skipped++; continue; }
        if (Date.now() - (cached.matched_at || 0) < RETRY_RAW_MS) { skipped++; continue; }
      }

      let result;
      try { result = await matchShape(row.shape); }
      catch (e) { console.error(`[match] pattern ${row.pattern_id} (route ${row.route_id}) error: ${e.message}`); continue; }

      dbRun(`INSERT OR REPLACE INTO route_shapes_matched(pattern_id,route_id,src_hash,shape,is_raw,note,matched_at)
             VALUES(?,?,?,?,?,?,?)`,
        [row.pattern_id, row.route_id, h, result.encoded, result.raw ? 1 : 0, result.reason || '', Date.now()]);
      if (result.raw) { kept++; }
      else { snapped++; }
      saveDb();
      if (!VALHALLA_LOCAL) await new Promise(r => setTimeout(r, 500)); // throttle only the public server
    }
    if (snapped + kept > 0) { console.log(`[match] done — ${snapped} snapped to roads, ${kept} kept raw, ${skipped} cached`); exportMatchedShapes(); }
  } finally {
    matchingInProgress = false;
  }
}

// Vendor the matched shapes to a repo file so a FRESH deploy (e.g. Render with no
// DB backup yet) loads pre-computed road geometry instantly instead of re-running
// Valhalla. Written after each matching pass; committed to the repo. "Run once,
// reuse forever" — even across cold reboots with no persistent disk.
const MATCHED_VENDOR_PATH = path.join(__dirname, 'data', 'route-shapes-matched.json');
function exportMatchedShapes() {
  try {
    const rows = dbAll(`SELECT pattern_id, route_id, src_hash, shape, is_raw FROM route_shapes_matched WHERE is_raw=0`);
    if (!rows.length) return;
    const out = {};
    for (const r of rows) out[r.pattern_id] = { route_id: r.route_id, src_hash: r.src_hash, shape: r.shape };
    fs.writeFileSync(MATCHED_VENDOR_PATH, JSON.stringify(out));
    console.log(`[match] vendored ${rows.length} matched shapes → ${path.basename(MATCHED_VENDOR_PATH)}`);
  } catch (e) { console.error('[match] vendor export:', e.message); }
}
// Vendored road-snapped geometry is AUTHORITATIVE. It's the committed result of
// map-matching every route, so we serve it directly and UNCONDITIONALLY — no hash
// gate, no fallback to raw, no dependency on Valhalla at runtime. This is what
// guarantees the deployed site (Render) shows the clean road-following lines that
// were matched locally — exactly, every time. Loaded once at boot.
//   pattern_id (string) -> { route_id, shape }
let VENDORED_SHAPES = {};
function loadVendoredShapes() {
  try {
    VENDORED_SHAPES = JSON.parse(fs.readFileSync(MATCHED_VENDOR_PATH, 'utf8')) || {};
    console.log(`[match] loaded ${Object.keys(VENDORED_SHAPES).length} vendored road-snapped shapes (authoritative)`);
  } catch { VENDORED_SHAPES = {}; console.warn('[match] no vendored shapes file — run matching once to generate it'); }
}
function seedMatchedFromVendor() { loadVendoredShapes(); }

// Road-graph-snapped geometry (scripts/snap-routes-to-roads.js) — every point is
// drawn from a real local OSM road segment by construction, so it can't drift,
// diagonal-cut across blocks, or visually diverge the way an independently-traced
// (and possibly Valhalla-rejected) polyline can. Where present for a pattern,
// this is preferred over VENDORED_SHAPES; routes without a snapped result yet
// fall back the same way the old pipeline did. Stored as { route_id, segments }
// (segments, not a single shape, because honest gaps in OSM coverage are kept
// as real breaks rather than bridged with a straight line).
const ROAD_SNAPPED_PATH = path.join(__dirname, 'data', 'route-shapes-road-snapped.json');
let ROAD_SNAPPED = {};
function loadRoadSnappedShapes() {
  try {
    ROAD_SNAPPED = JSON.parse(fs.readFileSync(ROAD_SNAPPED_PATH, 'utf8')) || {};
    console.log(`[road-snap] loaded ${Object.keys(ROAD_SNAPPED).length} road-graph-snapped patterns`);
  } catch { ROAD_SNAPPED = {}; }
}

// Per-real-road-edge route membership (scripts/build-route-edges.js) — for
// the "ribbon" renderer: a road used by N routes draws as N thin parallel
// stripes using this EXACT edge's own coordinates (never synthesized), so a
// shared road can show every route's color at once (like a printed transit
// map), not just one via basemap recoloring.
const ROUTE_EDGES_PATH = path.join(__dirname, 'data', 'route-edges.json');
let ROUTE_EDGES = { edges: [] };
function loadRouteEdges() {
  try {
    ROUTE_EDGES = JSON.parse(fs.readFileSync(ROUTE_EDGES_PATH, 'utf8')) || { edges: [] };
    console.log(`[route-edges] loaded ${ROUTE_EDGES.edges.length} real road edges for ribbon rendering`);
  } catch { ROUTE_EDGES = { edges: [] }; }
}

// Real OSM traffic-control nodes (signals, stop signs, crossings). Locations
// only — live red/green states are not publicly available for the Big Island
// (no HDOT SPaT feed). Served as a map layer and used to attach per-route-edge
// counts (nControls) so a segment "knows" it has N signals/stops — an ETA
// feature. See scripts/build-osm-controls.js.
const CONTROLS_PATH = path.join(__dirname, 'data', 'osm', 'bigisland-controls.json');
let TRAFFIC_CONTROLS = { controls: [] };
function loadTrafficControls() {
  try {
    TRAFFIC_CONTROLS = JSON.parse(fs.readFileSync(CONTROLS_PATH, 'utf8')) || { controls: [] };
    const c = TRAFFIC_CONTROLS.controls.length;
    console.log(`[controls] loaded ${c} OSM traffic-control nodes (signals/stops/crossings)`);
  } catch { TRAFFIC_CONTROLS = { controls: [] }; }
}

// For every route-edge, count how many signals/stops sit ON it (within
// CONTROL_ON_EDGE_M of the edge polyline). This is the per-segment feature the
// ETA model consumes: {signals, stops} per edge id. Computed once at boot
// (edges + controls are both static) using a coarse lon/lat bucket so we only
// test controls near each edge, not all 1195 against all 4867.
let EDGE_CONTROLS = new Map(); // edgeId -> { signals, stops }
function ensureTrafficControlIndex() {
  EDGE_CONTROLS = new Map();
  const controls = (TRAFFIC_CONTROLS.controls || []).filter(c => c.type === 'signal' || c.type === 'stop');
  if (!controls.length || !ROUTE_EDGES.edges.length) return;
  const CONTROL_ON_EDGE_M = 25;
  const CELL = 0.003; // ~330m buckets
  const bkey = (lon, lat) => `${Math.round(lon / CELL)},${Math.round(lat / CELL)}`;
  const grid = new Map();
  for (const c of controls) {
    const k = bkey(c.lon, c.lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  const distToSegM = (p, a, b) => {
    const mLat = 111320, mLon = mLat * Math.cos(p[1] * Math.PI / 180);
    const px = p[0]*mLon, py = p[1]*mLat, ax = a[0]*mLon, ay = a[1]*mLat, bx = b[0]*mLon, by = b[1]*mLat;
    const dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy || 1;
    let t = ((px-ax)*dx+(py-ay)*dy)/len2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px-(ax+dx*t), py-(ay+dy*t));
  };
  let matched = 0;
  for (const e of ROUTE_EDGES.edges) {
    let signals = 0, stops = 0;
    const near = new Set();
    for (const pt of e.coords) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${Math.round(pt[0]/CELL)+dx},${Math.round(pt[1]/CELL)+dy}`);
      if (list) for (const c of list) near.add(c);
    }
    for (const c of near) {
      let on = false;
      for (let i = 0; i < e.coords.length - 1 && !on; i++) {
        if (distToSegM([c.lon, c.lat], e.coords[i], e.coords[i+1]) <= CONTROL_ON_EDGE_M) on = true;
      }
      if (on) { if (c.type === 'signal') signals++; else stops++; }
    }
    if (signals || stops) { EDGE_CONTROLS.set(e.id, { signals, stops }); matched++; }
  }
  console.log(`[controls] indexed onto ${matched} route edges`);
}

// Road graph + spatial index, lazily built once and reused to snap historical
// GPS trails onto real road edges the same way routes are snapped (see
// scripts/build-route-edges.js) — so trails ribbon (parallel dashed stripes)
// wherever multiple vehicles/routes share a road, instead of drawing each
// vehicle's own possibly-noisy GPS line, which can diagonal-cut across blocks.
let TRAIL_GRAPH = null, TRAIL_EDGE_INDEX = null;
function ensureTrailGraph() {
  if (TRAIL_GRAPH) return;
  try {
    const { loadRoadGraph, buildEdgeIndex } = require('./road-graph.js');
    TRAIL_GRAPH = loadRoadGraph();
    TRAIL_EDGE_INDEX = buildEdgeIndex(TRAIL_GRAPH);
    console.log(`[trail-graph] loaded road graph for trail snapping (${TRAIL_GRAPH.edges.length} edges)`);
  } catch (e) {
    console.error('[trail-graph] load failed:', e.message);
  }
}

// Self-healing scheduler: keep retrying until every pattern has a snap result,
// then settle to a daily refresh. If Valhalla was down at boot, this recovers on
// its own within the hour instead of waiting a full day — zero manual steps.
function scheduleMatching() {
  const tick = async () => {
    await matchAllShapes().catch(e => console.error('[match] run:', e.message));
    const total = (dbGet(`SELECT COUNT(*) n FROM route_shapes WHERE shape IS NOT NULL`) || {}).n || 0;
    const done = (dbGet(`SELECT COUNT(*) n FROM route_shapes_matched`) || {}).n || 0;
    // Not everything attempted yet (e.g. Valhalla flaky) → retry in 30 min.
    // Otherwise everything has a result → relax to a daily refresh.
    const next = done < total ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
    setTimeout(tick, next);
  };
  setTimeout(tick, 3000); // first run shortly after boot (non-blocking)
}

// Geometry for a pattern, in priority order:
//   1. Road-graph-snapped wayIds + segments (every point/way is real OSM road
//      data by construction — see ROAD_SNAPPED above). `wayIds` are real OSM
//      way IDs — MapTiler's basemap "transportation" layer's own feature.id
//      IS the OSM way id (verified directly against vector tiles), so the
//      client can recolor the BASEMAP's existing road pixels via
//      map.setFeatureState instead of drawing any overlay line at all.
//      `segments` (the same real-road coordinates) ride along as a fallback
//      for any client/basemap combination where that isn't possible.
//   2. Vendored Valhalla-matched single shape (older pipeline, still authoritative
//      where a route hasn't been re-run through the road-graph snapper yet).
//   3. A freshly-matched DB result for a pattern with no vendored entry at all
//      (e.g. a brand-new route discovered after the vendored file was generated).
//   4. Raw GTFS shape as the final fallback — an honest sparse line, never bridged.
function bestPatternShape(patternId, rawShape) {
  const rs = ROAD_SNAPPED[String(patternId)];
  if (rs && rs.wayIds && rs.wayIds.length) return { wayIds: rs.wayIds, segments: rs.segments || [] };
  const v = VENDORED_SHAPES[String(patternId)];
  if (v && v.shape) return { shape: v.shape };
  const m = dbGet(`SELECT shape, is_raw FROM route_shapes_matched WHERE pattern_id=?`, [patternId]);
  if (m && m.shape && !m.is_raw) return { shape: m.shape };
  return { shape: rawShape };
}

// Run the schedule-PDF scraper as a child process, weekly. Kept out-of-process
// so its network work (and any hang behind the agency's Akamai protection) can't
// stall the main server. Logs are streamed to our console.
function runScript(rel, onDone) {
  try {
    const { spawn } = require('child_process');
    const script = path.join(__dirname, rel);
    if (!fs.existsSync(script)) return;
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', e => console.error(`[scrape] spawn error (${rel}):`, e.message));
    if (onDone) child.on('exit', () => onDone());
  } catch (e) { console.error(`[scrape] error (${rel}):`, e.message); }
}
function runScrape() {
  // Refresh the reference data (route class/hubs/roster) from GTFS, then reload
  // it in-process so /api/reference is current without a restart.
  console.log('[scrape] starting weekly reference + schedule scrape…');
  runScript(path.join('scripts', 'scrape-reference.js'), loadReference);
  // And mirror the human-readable schedule PDFs (cosmetic; may be Akamai-blocked).
  runScript(path.join('scripts', 'scrape-schedules.js'));
}
function scheduleWeeklyScrape() {
  setTimeout(runScrape, 60 * 1000);                 // ~1 min after boot
  setInterval(runScrape, 7 * 24 * 60 * 60 * 1000);  // then weekly
}

// ─── STOPS ───────────────────────────────────────────────────────────────────
const stopsCache = {}; // routeId -> [{ id, lat, lon, name, stopCode, seq }]

async function fetchStopsForRoute(routeId) {
  try {
    const r = await upstreamFetch(`routes/${routeId}/stops`);
    if (r.status !== 200) return [];
    const stops = JSON.parse(r.body);
    if (!Array.isArray(stops)) return [];
    // Deduplicate by id, assign sequence by array order
    const seen = new Set();
    const unique = stops.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
    const mapped = unique.map((s, i) => ({ id: s.id, lat: s.lat, lon: s.lon, name: s.name, stopCode: s.stopCode || '', seq: i }));
    // Persist to DB
    mapped.forEach(s => {
      dbRun(`INSERT OR REPLACE INTO stops(id,route_id,lat,lon,name,stop_code,seq,fetched_at) VALUES(?,?,?,?,?,?,?,?)`,
        [s.id, routeId, s.lat, s.lon, s.name, s.stopCode, s.seq, Date.now()]);
    });
    return mapped;
  } catch { return []; }
}

async function ensureStops(routeId) {
  if (stopsCache[routeId]) return stopsCache[routeId];
  // Try DB first
  const rows = dbAll(`SELECT id,lat,lon,name,stop_code as stopCode,seq FROM stops WHERE route_id=? ORDER BY seq`, [routeId]);
  if (rows.length) { stopsCache[routeId] = rows; return rows; }
  const stops = await fetchStopsForRoute(routeId);
  stopsCache[routeId] = stops;
  return stops;
}

async function fetchAllStops() {
  console.log('\n[stops] Fetching stops for all routes…');
  for (const route of ROUTES) {
    const existing = dbGet(`SELECT COUNT(*) as n FROM stops WHERE route_id=?`, [route.id]);
    if (existing && existing.n > 0) { process.stdout.write(`[stops] ${route.short} cached  `); stopsCache[route.id] = dbAll(`SELECT id,lat,lon,name,stop_code as stopCode,seq FROM stops WHERE route_id=? ORDER BY seq`, [route.id]); continue; }
    const stops = await fetchStopsForRoute(route.id);
    stopsCache[route.id] = stops;
    process.stdout.write(`[stops] ${route.short}(${stops.length})  `);
    await new Promise(r => setTimeout(r, 200));
  }
  saveDb();
  console.log('\n[stops] Done.');
}

// ─── ETA CALCULATION ─────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Hele-On's own (Syncromatics RTPI) arrival predictions for a stop, so riders
// can compare our GPS-derived ETA against the agency's native one. Keyed by
// route short name since a stop can be served by several routes and the
// caller only wants the prediction for its own vehicle's route.
async function fetchHeleOnArrivals(stopId, routeShort) {
  try {
    const r = await upstreamFetch(`stops/${stopId}/arrivals`);
    if (r.status !== 200) return null;
    const arr = JSON.parse(r.body);
    if (!Array.isArray(arr)) return null;
    const hit = arr.find(a => a.route && String(a.route.shortName) === String(routeShort));
    if (!hit || hit.secondsToArrival == null) return null;
    return {
      etaMin: Math.round((hit.secondsToArrival / 60) * 10) / 10,
      scheduleBased: !!hit.schedulePrediction,  // true = timetable guess, not live GPS
      vehicleId: hit.vehicle ? hit.vehicle.id : null,
    };
  } catch { return null; }
}

function calcETAs(vehicle, stops) {
  if (!stops || !stops.length || vehicle.speed === undefined) return [];
  const speedKmh = (vehicle.speed || 0) * 1.60934; // mph → km/h
  return stops.map(stop => {
    const distKm = haversineKm(vehicle.lat, vehicle.lon, stop.lat, stop.lon);
    const etaMin = speedKmh > 2 ? (distKm / speedKmh) * 60 : null;
    return { stopId: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon,
             distKm: Math.round(distKm * 1000) / 1000, etaMin: etaMin !== null ? Math.round(etaMin * 10) / 10 : null };
  }).sort((a, b) => a.distKm - b.distKm).slice(0, 8);
}

// ─── LEARNED ROUTE / STOPS (from observed GPS) ──────────────────────────────
// Snap a lat/lon to a ~`m`-metre grid cell key.
function cellKey(lat, lon, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
  return `${Math.round(lat / dLat)},${Math.round(lon / dLon)}`;
}
function cellCenter(key, m) {
  const [a, b] = key.split(',').map(Number);
  const lat = a * (m / 111320);
  const lon = b * (m / (111320 * Math.cos(lat * Math.PI / 180)));
  return [lon, lat];
}

// De-facto stops: cells where buses repeatedly DWELL across many distinct runs.
// A single red-light pause is one run at that cell; a real stop recurs across
// many runs (different vehicle-days). We also require it be away from any
// official stop (>80 m) so we only surface stops riders don't already see.
const LEARN_STOP_CELL_M = 35;
const LEARN_STOP_MIN_DAYS = 3;        // must recur on ≥3 distinct calendar days
const LEARN_STOP_MIN_RUNS = 4;        // …across ≥4 vehicle-days (runs)
const OFFICIAL_NEAR_M = 80;
function learnStops(routeId) {
  const since = Date.now() - PINGS_RETAIN_MS;
  const where = routeId ? `route_id=? AND` : '';
  const params = routeId ? [routeId, since] : [since];
  // Stopped (or crawling) pings only.
  const rows = dbAll(
    `SELECT vehicle_id, ts, lat, lon, route_id FROM pings
     WHERE ${where} speed <= 2 AND ts > ?`, params);
  const cells = {}; // cellKey -> { runs:Set, days:Set, perVeh:{}, route_id, n }
  rows.forEach(r => {
    const day = Math.floor(r.ts / 86400000);
    const key = cellKey(r.lat, r.lon, LEARN_STOP_CELL_M);
    const c = cells[key] || (cells[key] = { runs: new Set(), days: new Set(), perVeh: {}, route_id: r.route_id, n: 0 });
    c.runs.add(r.vehicle_id + '|' + day);
    c.days.add(day);
    c.perVeh[r.vehicle_id] = (c.perVeh[r.vehicle_id] || 0) + 1;
    c.n++;
  });
  const officials = dbAll(`SELECT lat, lon FROM stops`);
  const out = [];
  for (const key in cells) {
    const c = cells[key];
    // Recurrence gates: many separate runs AND across several distinct days, so
    // a one-off pause or a single bad-luck red light never qualifies.
    if (c.runs.size < LEARN_STOP_MIN_RUNS || c.days.size < LEARN_STOP_MIN_DAYS) continue;
    // Yard filter: a real rider stop is a BRIEF dwell (bus pauses, then goes).
    // A yard / transit center is a long park — huge sample counts per run. If the
    // average dwell per run is very high (≫ a normal stop), it's parking, skip it.
    const avgPerRun = c.n / c.runs.size;
    if (avgPerRun > 40) continue; // ~40 polls ≈ 10 min sitting → not a stop
    if (c.n > 2000) continue;     // absolute guard against the big yards
    const [lon, lat] = cellCenter(key, LEARN_STOP_CELL_M);
    if (officials.some(o => haversineKm(lat, lon, o.lat, o.lon) * 1000 < OFFICIAL_NEAR_M)) continue;
    out.push({ lat, lon, runs: c.runs.size, days: c.days.size, samples: c.n, route_id: c.route_id });
  }
  out.sort((a, b) => b.runs - a.runs);
  return out.slice(0, 300);
}

// Learned travel corridor for a route: the set of grid cells its buses actually
// drive through often (incl. detours the GTFS shape omits), as point centers the
// frontend can use to aim the direction chevrons along the real path.
const LEARN_PATH_CELL_M = 30;
const LEARN_PATH_MIN_RUNS = 3;
function learnCorridor(routeId) {
  if (!routeId) return [];
  const since = Date.now() - PINGS_RETAIN_MS;
  const rows = dbAll(
    `SELECT vehicle_id, ts, lat, lon FROM pings WHERE route_id=? AND ts > ?`, [routeId, since]);
  const cellRuns = {};
  rows.forEach(r => {
    const key = cellKey(r.lat, r.lon, LEARN_PATH_CELL_M);
    const runId = r.vehicle_id + '|' + Math.floor(r.ts / 86400000);
    (cellRuns[key] = cellRuns[key] || new Set()).add(runId);
  });
  const cells = [];
  for (const key in cellRuns) {
    if (cellRuns[key].size < LEARN_PATH_MIN_RUNS) continue;
    const [lon, lat] = cellCenter(key, LEARN_PATH_CELL_M);
    cells.push({ lat, lon, runs: cellRuns[key].size });
  }
  return cells;
}

// Short-lived memo for the heavy /api/stopline computation (see handler).
const stoplineMemo = new Map();

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ico':'image/x-icon', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json' };

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}

async function handleApi(url, res) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/vehicles') {
    return json(res, { ts: lastPollStats.ts, vehicles: latestVehicles, stats: lastPollStats });
  }

  // Everything we can scrape about the WHOLE fleet — every vehicle the agency
  // API knows about, live or not, with all telemetry and a derived status that
  // explains why a bus is or isn't on the map. Powers the Fleet tab.
  if (p === '/api/fleet') {
    const now = Date.now();
    // Full roster (every vehicle ever registered) …
    let roster = [];
    try { roster = JSON.parse((await upstreamFetch('vehicles')).body); } catch {}
    if (!Array.isArray(roster)) roster = [];
    // … plus the per-route endpoint, which carries the live speed/heading/route
    // for the ones currently reporting.
    const liveByRoute = {}; // id -> { ...raw, routeId }
    await Promise.all(ROUTES.map(async route => {
      let vs = [];
      try { vs = JSON.parse((await upstreamFetch(`routes/${route.id}/vehicles`)).body); } catch {}
      if (Array.isArray(vs)) vs.forEach(v => {
        const t = parseFleetTs(v.lastUpdated);
        const prev = liveByRoute[v.id];
        if (!prev || t > prev._t) liveByRoute[v.id] = Object.assign({}, v, { routeId: route.id, _t: t });
      });
    }));

    const fleet = roster.map(r => {
      const live = liveByRoute[r.id];
      const src = live || r;                       // prefer the richer per-route record
      const luMs = parseFleetTs(src.lastUpdated);
      // The per-route feed timestamps (live) are reliable (zoned). The bare
      // roster clock is skewed, so a roster-only age can come out slightly
      // negative — clamp to 0 and treat sub-hour skew as "just now".
      let ageMin = luMs ? (now - luMs) / 60000 : null;
      if (ageMin != null && ageMin < 0) ageMin = ageMin > -180 ? 0 : null;
      const inBox = src.lat != null && src.lat >= BBOX.minLat && src.lat <= BBOX.maxLat &&
                    src.lon >= BBOX.minLon && src.lon <= BBOX.maxLon;
      const routeId = live ? live.routeId : null;
      const route = ROUTE_MAP[routeId];
      const tripId = (vehicleTripMap[r.id] && vehicleTripMap[r.id].tripId) || vpTripMap[r.id] || null;
      // Derived status: why it is / isn't on the map.
      let status, reason;
      if (ageMin == null)            { status = 'unknown';  reason = 'No GPS timestamp'; }
      else if (ageMin < 5 && live)   { status = 'live';     reason = 'Reporting now'; }
      else if (ageMin < 5)           { status = 'idle';     reason = 'Fresh GPS but not assigned to a route'; }
      else if (ageMin < 60)          { status = 'recent';   reason = `Last seen ${Math.round(ageMin)} min ago`; }
      else if (ageMin < 1440)        { status = 'offshift'; reason = `Last seen ${Math.round(ageMin/60)} h ago`; }
      else                           { status = 'dormant';  reason = `Last seen ${Math.round(ageMin/1440)} d ago`; }
      if (!inBox && src.lat != null) reason = 'Outside Hawaiʻi County';
      return {
        id: r.id,
        name: r.name || String(r.id),
        status, reason,
        onMap: status === 'live',
        lat: src.lat ?? null, lon: src.lon ?? null,
        speed: src.speed ?? null,
        heading: src.heading ?? null,
        headingDegrees: src.headingDegrees ?? null,
        passengerLoad: src.passengerLoad ?? null,
        capacity: src.capacity ?? null,
        patternId: src.patternId ?? null,
        shapeDistanceTraveled: src.shapeDistanceTraveled ?? null,
        routeId,
        routeShort: route ? route.short : null,
        routeName: route ? route.name : null,
        tripId,
        lastUpdated: src.lastUpdated || null,
        ageMin: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        weather: weatherByVehicle[r.id] || null,
      };
    });
    // Sort: live first, then by recency.
    const rank = { live: 0, idle: 1, recent: 2, offshift: 3, dormant: 4, unknown: 5 };
    fleet.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.ageMin ?? 1e9) - (b.ageMin ?? 1e9)));
    const counts = fleet.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m; }, {});
    return json(res, { ts: now, total: fleet.length, counts, fleet });
  }

  // ── Learned, real-world data from observed GPS history ───────────────────
  // De-facto stops: places a route's buses REPEATEDLY dwell, across many
  // separate runs (so a one-off pause or a red light doesn't count), and that
  // aren't already an official stop. Returned for a distinct "observed stop"
  // marker on the map.
  if (p === '/api/learned-stops') {
    return json(res, learnStops(q.get('route_id') ? parseInt(q.get('route_id')) : null));
  }
  // Learned travel corridor: the high-traffic grid cells a route's buses
  // actually drive through (incl. neighborhood detours not in the GTFS shape).
  // The frontend uses this to aim the direction chevrons the way buses really go.
  if (p === '/api/learned-path') {
    return json(res, learnCorridor(q.get('route_id') ? parseInt(q.get('route_id')) : null));
  }

  if (p === '/api/trails') {
    const minutes = Math.min(parseInt(q.get('minutes') || '60'), 1440);
    const since = Date.now() - minutes * 60000;
    const rows = dbAll(
      `SELECT vehicle_id, vehicle_name, route_id, ts, lat, lon, speed, heading_deg
       FROM pings WHERE ts>=? ORDER BY vehicle_id, ts ASC`, [since]);
    const byV = {};
    rows.forEach(r => {
      if (!byV[r.vehicle_id]) byV[r.vehicle_id] = { vehicle_id: r.vehicle_id, name: r.vehicle_name, route_id: r.route_id, _pts: [] };
      byV[r.vehicle_id]._pts.push([r.lon, r.lat, r.ts, r.speed, r.heading_deg]);
    });
    // De-spaghetti: a parked bus jitters a few metres every poll, which draws a
    // tangled scribble. Keep a point only when the bus has actually moved >25 m
    // from the last kept point, so stationary buses collapse to a single dot and
    // only real travel forms a line.
    const out = Object.values(byV).map(v => {
      const pts = [];
      for (const p of v._pts) {
        if (!pts.length) { pts.push(p); continue; }
        const last = pts[pts.length - 1];
        if (haversineKm(last[1], last[0], p[1], p[0]) * 1000 >= 25) pts.push(p);
      }
      // Always include the most recent fix so the trail reaches the live marker.
      const lastRaw = v._pts[v._pts.length - 1];
      if (lastRaw && pts[pts.length - 1] !== lastRaw) pts.push(lastRaw);
      return { vehicle_id: v.vehicle_id, name: v.name, route_id: v.route_id, points: pts };
    });

    // Snap each vehicle's de-spaghettied trail onto real road-graph edges (the
    // exact same graph/matcher the live-route ribbons use) and key the result
    // by edge, so the client can draw overlapping trails as parallel dashed
    // stripes instead of independent GPS lines that can diagonal-cut across a
    // block whenever a raw fix drifts. Splits into separate runs on genuine
    // gaps (time/distance jumps already applied above, plus unsnappable
    // stretches) so a trail with a real off-road excursion doesn't get bridged
    // through unrelated roads.
    const edgeTrails = new Map(); // edgeIdx -> Map(vehicle_id -> {route_id, color-relevant info})
    if (TRAIL_GRAPH) {
      const { connectedEdgePathForCli } = require('./scripts/snap-routes-to-roads.js');
      for (const v of out) {
        if (!v.points || v.points.length < 2) continue;
        if (v.route_id == null) continue; // no route to ribbon/color — leave off this layer entirely
        const rawCoords = v.points.map(p => [p[0], p[1]]);
        let edgeSeq;
        try {
          // Same connected-path builder the live route ribbons use, so a
          // vehicle's historical trail is one unbroken road-snapped chain
          // (dashed on the client) instead of scattered edge fragments.
          edgeSeq = connectedEdgePathForCli(TRAIL_GRAPH, TRAIL_EDGE_INDEX, rawCoords);
        } catch (e) { continue; }
        for (const edgeIdx of edgeSeq) {
          if (edgeIdx == null) continue;
          if (!edgeTrails.has(edgeIdx)) edgeTrails.set(edgeIdx, new Map());
          edgeTrails.get(edgeIdx).set(v.vehicle_id, v.route_id);
        }
      }
    }
    const edges = [];
    for (const [edgeIdx, vehicleMap] of edgeTrails) {
      const e = TRAIL_GRAPH.edges[edgeIdx];
      const routeIds = [...new Set([...vehicleMap.values()])];
      edges.push({
        id: edgeIdx,
        coords: e.coords,
        routes: routeIds.map(rid => ({ routeId: rid, color: (ROUTE_MAP[rid] && ROUTE_MAP[rid].color) || '#888' })),
      });
    }

    return json(res, { vehicles: out, edges });
  }

  // Reference data (route classification, hub connections, P&R/terminals/airports)
  // distilled from the System Map PDF + auto-derived route roster from GTFS.
  if (p === '/api/reference') {
    return json(res, REFERENCE);
  }

  // Authoritative route registry — every route known across all sources, with
  // provenance and whether it has a shape / live vehicle. The single source of
  // truth for "do we have all the routes?".
  if (p === '/api/registry') {
    return json(res, { count: ROUTE_REGISTRY.length, routes: ROUTE_REGISTRY, builtAt: Date.now() });
  }

  // Per-real-road-edge route membership for the "ribbon" renderer — see
  // ROUTE_EDGES above. Route colors are resolved here (not baked into the
  // static file) so a route-color change takes effect without regenerating it.
  if (p === '/api/route-edges') {
    const edges = ROUTE_EDGES.edges.map(e => {
      const ctl = EDGE_CONTROLS.get(e.id);
      return {
        id: e.id,
        wayId: e.wayId,   // join key to the self-hosted road source (feature-state recolor)
        coords: e.coords,
        routes: e.routeIds.map(rid => ({
          routeId: rid,
          color: (ROUTE_MAP[rid] && ROUTE_MAP[rid].color) || '#888',
          short: (ROUTE_MAP[rid] && ROUTE_MAP[rid].short) || String(rid),
          name: (ROUTE_MAP[rid] && ROUTE_MAP[rid].name) || ('Route ' + rid),
        })),
        ...(ctl ? { signals: ctl.signals, stops: ctl.stops } : {}),
      };
    });
    return json(res, { edges });
  }

  // The real OSM road ways every route travels, feature id = OSM way id. The
  // client colors these actual road lines via feature-state (see build-route-
  // roads-geojson.js). Cached hard — it only changes when routes/roads rebuild.
  if (p === '/api/route-roads') {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'data', 'osm', 'route-roads.geojson'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    } catch { return json(res, { type: 'FeatureCollection', features: [] }); }
  }

  // Real traffic-control locations (signals, stop signs, crossings). Locations
  // only; no live states exist for this island.
  if (p === '/api/controls') {
    return json(res, { generated: TRAFFIC_CONTROLS.generated || null, controls: TRAFFIC_CONTROLS.controls });
  }

  if (p === '/api/shapes') {
    const rows = dbAll(`SELECT route_id, pattern_id, name, direction, color, shape FROM route_shapes ORDER BY route_id, pattern_id`);
    rows.forEach(r => {
      // Curated dark/distinct palette over the upstream pattern colors (those
      // include pale pastels and #FFFFFF that vanish on the map).
      if (ROUTE_MAP[r.route_id]) r.color = ROUTE_MAP[r.route_id].color;
      // Prefer road-graph-snapped geometry — see bestPatternShape(). A pattern
      // either gets `wayIds` (+ `segments` as a fallback) or a single `shape`
      // (older Valhalla-matched or raw GTFS fallback); the client handles
      // both. Drop the raw `shape` key when we're returning wayIds/segments
      // instead, so old client code can't accidentally draw the raw
      // unsnapped line on top of the snapped one.
      const best = bestPatternShape(r.pattern_id, r.shape);
      if (best.wayIds) { delete r.shape; r.wayIds = best.wayIds; r.segments = best.segments; r.matched = true; }
      else if (best.shape !== r.shape) { r.shape = best.shape; r.matched = true; }
    });
    return json(res, rows);
  }

  if (p === '/api/routes') {
    return json(res, ROUTES);
  }

  if (p === '/api/stats') {
    const poll = dbAll(
      `SELECT route_id, COUNT(*) as polls, AVG(latency) as avg_latency, SUM(CASE WHEN status=200 THEN 1 ELSE 0 END) as ok
       FROM poll_log WHERE ts > ? GROUP BY route_id`, [Date.now() - 3600000]);
    const pingCount = dbGet(`SELECT COUNT(*) as n FROM pings WHERE ts > ?`, [Date.now() - 86400000]);
    return json(res, { uptime_since: startTime, poll_stats: poll, ping_count_today: pingCount?.n || 0 });
  }

  if (p === '/api/debug/feeds') {
    const feed = (count, ts, err) => ({ count, lastPollTs: ts, lastError: err || null });
    return json(res, {
      ts: Date.now(),
      uptimeMs: Date.now() - startTime,
      vehicles: latestVehicles.length,
      feeds: {
        aircraft: feed(aircraftCache.length, aircraftLastPollTs, aircraftLastError),
        vessels: feed(vesselCache?.size || 0, vesselLastConnectTs, vesselLastError),
        summits: feed(summitCache.length, summitLastPollTs, summitLastError),
        repeaters: feed(repeaterCache.length, repeaterLastPollTs, repeaterLastError),
        aprs: feed(aprsCache.size, aprsLastRxTs, aprsLastError),
        meshtastic: feed(meshtasticCache.length, meshtasticLastPollTs, meshtasticLastError),
        weather: feed(weatherStationsCache?.features?.length || 0, weatherStationsLastPollTs, weatherStationsLastError),
        streamflow: feed(streamflowCache?.features?.length || 0, streamflowLastPollTs, streamflowLastError),
        ocean: feed(oceanCache.length, oceanLastPollTs, oceanLastError),
        airquality: feed(airQualityCache.length, airQualityLastPollTs, airQualityLastError),
        solar: feed(solarCache.length, solarLastPollTs, solarLastError),
        satellites: feed(satelliteCache.length, satelliteLastPollTs, satelliteLastError),
      },
    });
  }

  if (p === '/api/eta') {
    const vid = parseInt(q.get('vehicle_id'));
    const v = latestVehicles.find(x => x.id === vid);
    if (!v) return json(res, { error: 'vehicle not found' }, 404);
    const stops = await ensureStops(v.routeId);
    const etas = calcETAs(v, stops);
    // Enrich each of our ETAs with Hele-On's own (Syncromatics) prediction for
    // the same stop, so the two can be shown side by side in the UI.
    await Promise.all(etas.map(async e => {
      const heleon = await fetchHeleOnArrivals(e.stopId, v.routeShort);
      if (heleon) e.heleon = heleon;
    }));
    return json(res, { vehicle_id: vid, route: v.routeName, speed_mph: v.speed, etas });
  }

  if (p === '/api/stops') {
    const rid = parseInt(q.get('route_id'));
    if (!rid) return json(res, { error: 'route_id required' }, 400);
    const stops = await ensureStops(rid);
    return json(res, stops);
  }

  // All stops for all routes (for map rendering)
  if (p === '/api/stops/all') {
    const rows = dbAll(`SELECT id,route_id,lat,lon,name,stop_code as stopCode,seq FROM stops ORDER BY route_id,seq`);
    return json(res, rows);
  }

  // Full stop arrival data: current ETAs, rolling 60-min history, and long-term typical patterns
  if (p === '/api/stop_arrivals') {
    const stopId = parseInt(q.get('stop_id'));
    const routeId = parseInt(q.get('route_id'));
    const stop = (stopsCache[routeId] || []).find(s => s.id === stopId);

    // ── Approaching buses (live) ──────────────────────────────────────────────
    const activeVehicles = latestVehicles.filter(v => v.routeId === routeId);
    const approaching = activeVehicles.map(v => {
      if (!stop) return null;
      const distKm = haversineKm(v.lat, v.lon, stop.lat, stop.lon);
      const speedKmh = (v.speed || 0) * 1.60934;
      const etaCurrent = speedKmh > 2 ? Math.round((distKm / speedKmh) * 60 * 10) / 10 : null;

      // Historical avg speed for this route over last hour
      const histRows = dbAll(
        `SELECT speed FROM pings WHERE route_id=? AND ts > ? AND speed > 0`,
        [routeId, Date.now() - 3600000]
      );
      const histAvgKmh = histRows.length
        ? (histRows.reduce((s, r) => s + r.speed, 0) / histRows.length) * 1.60934
        : speedKmh;
      const etaHist = histAvgKmh > 2 ? Math.round((distKm / histAvgKmh) * 60 * 10) / 10 : null;

      return {
        vehicleId: v.id, vehicleName: v.name,
        distKm: Math.round(distKm * 100) / 100,
        etaCurrent, etaHist,
        speed: v.speed, heading: v.heading
      };
    }).filter(Boolean).sort((a, b) => a.distKm - b.distKm);

    // ── Recent arrivals (last 60 min) ─────────────────────────────────────────
    const recent = dbAll(
      `SELECT ts, vehicle_id FROM stop_arrivals WHERE stop_id=? AND route_id=? AND ts>? ORDER BY ts DESC LIMIT 10`,
      [stopId, routeId, Date.now() - 3600000]
    );
    const lastArrival = recent[0] || null;
    const minutesSinceLast = lastArrival ? Math.round((Date.now() - lastArrival.ts) / 60000) : null;

    let avgGapMin = null;
    if (recent.length >= 2) {
      const gaps = [];
      for (let i = 0; i < recent.length - 1; i++)
        gaps.push((recent[i].ts - recent[i+1].ts) / 60000);
      avgGapMin = Math.round(gaps.reduce((a,b) => a+b, 0) / gaps.length * 10) / 10;
    }

    // ── Long-term typical: all arrivals for this stop, grouped by hour-of-day ─
    // Gives "usually arrives at HH:XX ± N min" for the current hour window
    const allArrivals = dbAll(
      `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 500`,
      [stopId, routeId]
    );

    // Group by hour-of-day, compute arrival minute-of-hour stats
    const byHour = {};
    allArrivals.forEach(row => {
      const d = new Date(row.ts);
      const h = d.getHours();
      const minOfHour = d.getMinutes() + d.getSeconds() / 60;
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(minOfHour);
    });

    // For each hour, compute mean and stddev of minute-of-hour
    const typicalByHour = {};
    Object.entries(byHour).forEach(([h, mins]) => {
      const mean = mins.reduce((a,b) => a+b, 0) / mins.length;
      const variance = mins.reduce((a,b) => a + (b-mean)**2, 0) / mins.length;
      const stddev = Math.sqrt(variance);
      typicalByHour[h] = { mean: Math.round(mean * 10) / 10, stddev: Math.round(stddev * 10) / 10, n: mins.length };
    });

    // Current hour typical
    const nowHour = new Date().getHours();
    const typicalNow = typicalByHour[nowHour] || null;

    return json(res, {
      stopId, routeId,
      approaching,
      minutesSinceLast, avgGapMin,
      recentCount: recent.length,
      totalArrivals: allArrivals.length,
      typicalNow,   // { mean, stddev, n } — typical minute-of-hour arrivals at this stop
      typicalByHour // all hours for sparkline
    });
  }

  // Long-term arrival pattern by (day-of-week, hour-of-day). Answers
  // "what time does this bus usually stop here on a Tuesday afternoon?"
  // Returns a 7×24 matrix of { mean, stddev, n } keyed by dow/hod so the
  // UI can render a heatmap. We use the long retention window so weekly
  // patterns are visible (commute peaks, weekend lulls, etc).
  if (p === '/api/stop_patterns') {
    const stopId = parseInt(q.get('stop_id'));
    const routeId = parseInt(q.get('route_id'));
    if (!stopId || !routeId) return json(res, { error: 'stop_id and route_id required' }, 400);
    // Pull up to 5000 recent arrivals (well within the 90-day retention
    // for busy stops; for quiet stops we get all of them).
    const rows = dbAll(
      `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 5000`,
      [stopId, routeId]
    );
    // Bucket: bucket[dow][hod] = [minutes-of-day list]
    const bucket = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
    rows.forEach(r => {
      const d = new Date(r.ts);
      bucket[d.getDay()][d.getHours()].push(d.getMinutes() + d.getSeconds() / 60);
    });
    // Reduce to { mean, stddev, n } per cell. Skip cells with too few samples
    // to avoid noise; we report n so the UI can show confidence.
    const matrix = bucket.map((dayBuckets, dow) =>
      dayBuckets.map((mins, hod) => {
        if (mins.length < 2) return { mean: null, stddev: null, n: mins.length };
        const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
        const variance = mins.reduce((a, b) => a + (b - mean) ** 2, 0) / mins.length;
        return { mean: Math.round(mean * 10) / 10, stddev: Math.round(Math.sqrt(variance) * 10) / 10, n: mins.length };
      })
    );
    return json(res, {
      stopId, routeId,
      totalArrivals: rows.length,
      daysCovered: 90,
      matrix, // matrix[dow][hod] = { mean (minute of hour), stddev, n }
    });
  }

  // Rich ETA with historical performance
  // Returns stops in order, each with: distKm, etaMinSpeed (pure speed), etaMinHistorical (avg from pings)
  if (p === '/api/stopline') {
    const vid = parseInt(q.get('vehicle_id'));
    // Memoize the (fairly heavy) stopline result briefly — many clients ask for
    // the same vehicle every 30 s, and a bus's stop predictions don't change
    // meaningfully within ~8 s. Keyed by vehicle + the latest poll timestamp.
    const memoKey = vid + ':' + lastPollStats.ts;
    const cached = stoplineMemo.get(memoKey);
    if (cached && Date.now() - cached.t < 8000) return json(res, cached.data);

    const v = latestVehicles.find(x => x.id === vid);
    if (!v) return json(res, { error: 'vehicle not found' }, 404);
    const stops = await ensureStops(v.routeId);
    if (!stops.length) return json(res, { stops: [], vehicle: v });

    const speedKmh = (v.speed || 0) * 1.60934;

    // Historical: avg seconds this vehicle (or all on route) takes to reach each stop distance band
    // We look at pings for this vehicle over last 7 days and compute avg speed by distance-from-stop
    const histRows = dbAll(
      `SELECT lat, lon, speed, ts FROM pings WHERE route_id=? AND ts > ? AND speed > 0 ORDER BY ts`,
      [v.routeId, Date.now() - 7 * 86400000]
    );

    // Compute average speed from history
    const histAvgSpeed = histRows.length
      ? (histRows.reduce((s, r) => s + r.speed, 0) / histRows.length) * 1.60934
      : speedKmh;

    // Official agency predictions for this vehicle's trip (GTFS-RT TripUpdates),
    // keyed by stop_id → { ms, seq }. This is the headline ETA when present.
    const officialStops = (v.tripId && tripUpdateIndex[v.tripId]) || {};
    const nowMsEta = Date.now();

    // The transformer's input depends only on the bus (speed) + route, not the
    // individual stop, so run the forward pass ONCE here rather than per stop.
    // Each of its 12 tokens encodes "the k-th stop ahead" (k = token index + 1),
    // and each token has its own output head — so the residual for the k-th
    // stop ahead is `seqOut[k]`. The stop's rank-ahead is determined by
    // distance (clamped to the 5 trained heads).
    // Schedule delta uses the NEAREST stop (the one the bus is currently
    // approaching) as the reference for "ahead/behind schedule right now" —
    // matches the same feature trainFromHistory now actually populates.
    const nearestStopIdx = stops.reduce((mi, s, i) =>
      haversineKm(v.lat, v.lon, s.lat, s.lon) < haversineKm(v.lat, v.lon, stops[mi].lat, stops[mi].lon) ? i : mi, 0);
    const liveSchedDeltaSec = scheduleDeltaAt(v.routeId, stops[nearestStopIdx].id, nowMsEta);
    const fwdRes = TX.forward(buildTokenSequence(v, 0, liveSchedDeltaSec, v.routeId, nowMsEta));
    const seqOut = fwdRes.tokenOut; // length 12; first 5 are the trained heads
    // Rank stops by distance to map them to "n stops ahead" → head index.
    const distRank = {};
    [...stops].map((s, i) => ({ i, d: haversineKm(v.lat, v.lon, s.lat, s.lon) }))
              .sort((a, b) => a.d - b.d)
              .forEach((e, rank) => { distRank[e.i] = rank; });

    // Find closest stop to figure out which direction/sequence we're travelling
    const stopETAs = stops.map((stop, i) => {
      const distKm = haversineKm(v.lat, v.lon, stop.lat, stop.lon);
      const etaSpeed = speedKmh > 1 ? (distKm / speedKmh) * 60 : null;
      const etaHist  = histAvgSpeed > 1 ? (distKm / histAvgSpeed) * 60 : etaSpeed;
      // Official predicted arrival (minutes from now), if the agency feed has it.
      const off = officialStops[String(stop.id)] || officialStops[stop.id];
      const etaOfficial = off ? Math.round(((off.ms - nowMsEta) / 60000) * 10) / 10 : null;

      // Model correction: use the output head for this stop's rank ahead of the bus.
      const head = Math.min(distRank[i] || 0, 4); // 5 trained heads (0..4)
      const correction = seqOut[head];
      const etaSeq = etaHist != null ? Math.max(0, etaHist + correction) : null;

      // Headline ETA: prefer the agency's official prediction; fall back to the
      // model-corrected estimate, then plain historical/speed estimates.
      let etaMin, etaSource;
      if (etaOfficial != null)      { etaMin = etaOfficial; etaSource = 'official'; }
      else if (etaSeq != null)      { etaMin = Math.round(etaSeq * 10) / 10; etaSource = 'model'; }
      else if (etaHist != null)     { etaMin = Math.round(etaHist * 10) / 10; etaSource = 'historical'; }
      else if (etaSpeed != null)    { etaMin = Math.round(etaSpeed * 10) / 10; etaSource = 'speed'; }
      else                          { etaMin = null; etaSource = null; }

      return {
        stopId: stop.id, name: stop.name, stopCode: stop.stopCode,
        lat: stop.lat, lon: stop.lon, seq: stop.seq,
        distKm: Math.round(distKm * 1000) / 1000,
        etaMin, etaSource,
        etaMinOfficial: etaOfficial,
        etaMinSpeed: etaSpeed !== null ? Math.round(etaSpeed * 10) / 10 : null,
        etaMinHist:  etaHist  !== null ? Math.round(etaHist  * 10) / 10 : null,
        etaMinSeq:   etaSeq != null ? Math.round(etaSeq * 10) / 10 : null,
        seqCorrection: Math.round(correction * 10) / 10,
        histSampleCount: histRows.length,
        histAvgSpeedMph: Math.round(histAvgSpeed / 1.60934 * 10) / 10,
      };
    });

    // Determine next stop: the stop the bus is actually driving TOWARD.
    // Strategy: find the two closest stops. If they're adjacent in sequence,
    // the bus is between them — the higher-seq one is "next".
    // If not adjacent (loop route), use the bus's last-passed stop as a reference
    // and pick the closest stop whose seq is ahead of (or wrapping from) that.
    const sorted = [...stopETAs].sort((a, b) => a.distKm - b.distKm);
    let nextStop = sorted[0];

    // Authoritative next stop from the agency feed: the upcoming stop in this
    // trip's TripUpdates with the smallest still-in-the-future predicted arrival.
    // You can't be heading to a stop you haven't reached, so this beats geometry.
    let officialNext = null;
    if (Object.keys(officialStops).length) {
      // The next stop is the one the agency predicts the SOONEST arrival for —
      // i.e. the smallest still-in-the-future predicted time. (Lowest sequence is
      // wrong: the feed predicts the whole trip, and on a route that revisits low
      // sequence numbers the soonest-arriving stop is the real next one, not the
      // numerically-lowest.)
      let bestMs = Infinity;
      for (const s of stopETAs) {
        // NOTE: stopETAs entries carry `stopId` (not `id`).
        const off = officialStops[String(s.stopId)] || officialStops[s.stopId];
        if (!off || off.ms <= nowMsEta - 30000) continue; // already passed
        if (off.ms < bestMs) { bestMs = off.ms; officialNext = s; }
      }
    }

    if (officialNext) {
      nextStop = officialNext;
    } else {
      // No agency feed for this trip — derive the next stop from geometry +
      // sequence so we never highlight a stop the bus hasn't reached. Stops are
      // ordered by seq. Find the nearest stop, then decide whether the bus has
      // already passed it (closer to its successor) or is still approaching it.
      // "Next" is the first stop in sequence at or ahead of the bus's progress.
      const bySeq = [...stopETAs].sort((a, b) => a.seq - b.seq);
      // Index of the geometrically nearest stop within the seq-ordered list.
      let nearIdx = 0, nearDist = Infinity;
      bySeq.forEach((s, i) => { if (s.distKm < nearDist) { nearDist = s.distKm; nearIdx = i; } });
      const near = bySeq[nearIdx];
      const prev = bySeq[nearIdx - 1];
      const succ = bySeq[nearIdx + 1];
      // Have we passed `near`? We have if we're now closer to its successor than
      // the successor is to `near` minus our distance — i.e. projecting our
      // position onto the near→succ segment puts us past `near`. Simple, robust
      // proxy: compare distance-to-prev vs distance-to-succ.
      let next;
      if (succ && (!prev || (prev && near.distKm > 0.05))) {
        // If we're closer to the successor's side, the bus has passed `near`.
        const dSucc = succ ? succ.distKm : Infinity;
        const dPrev = prev ? prev.distKm : Infinity;
        if (dSucc < dPrev && near.distKm > 0.08) next = succ; else next = near;
      } else {
        next = near;
      }
      // Honour the last stop we actually recorded an arrival at, if more advanced.
      const lastArr = dbGet(
        `SELECT stop_seq FROM stop_arrivals WHERE vehicle_id=? ORDER BY ts DESC LIMIT 1`, [vid]);
      const lastSeq = (vehicleLastStopIdx[vid] && vehicleLastStopIdx[vid].stopSeq != null)
        ? vehicleLastStopIdx[vid].stopSeq
        : (lastArr && lastArr.stop_seq != null ? lastArr.stop_seq : null);
      if (lastSeq != null && next.seq <= lastSeq) {
        const ahead = bySeq.find(s => s.seq > lastSeq);
        if (ahead) next = ahead;
      }
      nextStop = next || sorted[0];
    }

    // ── GTFS scheduled times ──────────────────────────────────────────────────
    // For each stop, find the trip passing through it closest to the current time.
    // Buses are scheduled throughout the day — different trips hit different stops.
    const nowDate = new Date();
    const nowSec = nowDate.getHours() * 3600 + nowDate.getMinutes() * 60 + nowDate.getSeconds();
    const dayOfWeek = nowDate.getDay();
    const validServices = new Set();
    validServices.add('225-1');
    if (dayOfWeek >= 1 && dayOfWeek <= 6) validServices.add('225-2');
    if (dayOfWeek >= 1 && dayOfWeek <= 5) validServices.add('225-3');
    if (dayOfWeek === 0) validServices.add('225-4');

    // Load all valid trip times for this route once: stop_id -> [{arrival_sec, trip_id}]
    const allTripStops = dbAll(
      `SELECT stop_id, trip_id, arrival_sec FROM gtfs_stop_times WHERE route_id=?`,
      [v.routeId]
    );
    const tripStopGroups = {}; // stop_id -> [{sec, trip_id}]
    const tripServices = {}; // trip_id -> service_id (lookup)
    dbAll(`SELECT trip_id, service_id FROM gtfs_stop_times WHERE route_id=? GROUP BY trip_id`,
      [v.routeId]).forEach(t => { tripServices[t.trip_id] = t.service_id; });

    allTripStops.forEach(r => {
      if (!validServices.has(tripServices[r.trip_id])) return;
      if (!tripStopGroups[r.stop_id]) tripStopGroups[r.stop_id] = [];
      tripStopGroups[r.stop_id].push({ sec: r.arrival_sec, trip_id: r.trip_id });
    });

    // For each stop, find scheduled_sec of the trip whose time is closest to now
    // (within ±2 hours — outside that we have no scheduled service today)
    const scheduledMap = {};
    const scheduledTripId = {}; // track which trip matched
    stopETAs.forEach(stop => {
      const candidates = tripStopGroups[stop.stopId];
      if (!candidates || !candidates.length) return;
      let best = null, bestDiff = Infinity;
      for (const c of candidates) {
        // Treat times >24h as next-day (rare here, but handle)
        const sec = c.sec % 86400;
        const diff = Math.abs(sec - nowSec);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      if (best && bestDiff < 7200) { // within 2 hours
        scheduledMap[stop.stopId] = best.sec;
        scheduledTripId[stop.stopId] = best.trip_id;
      }
    });

    // Exact trip schedule: GTFS-RT gives us the actual trip_id, so use that
    // trip's own scheduled stop times instead of the nearest-time heuristic.
    if (v.tripId) {
      dbAll(`SELECT stop_id, arrival_sec FROM gtfs_stop_times WHERE trip_id=?`, [v.tripId])
        .forEach(r => { scheduledMap[r.stop_id] = r.arrival_sec; scheduledTripId[r.stop_id] = v.tripId; });
    }

    // Enrich each stop with historical typical arrival time from stop_arrivals
    // Group all recorded arrivals by hour-of-day, compute mean minute-of-hour & stddev
    const nowMs = Date.now();
    const nowHour = nowDate.getHours();
    stopETAs.forEach(stop => {
      // Scheduled time from GTFS
      if (scheduledMap[stop.stopId] !== undefined) {
        stop.scheduledSec = scheduledMap[stop.stopId];
        // Convert to today's absolute ms timestamp
        const todayMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
        stop.scheduledMs = todayMidnight + stop.scheduledSec * 1000;
      } else {
        stop.scheduledSec = null;
        stop.scheduledMs = null;
      }
    });
    // ── Typical arrival: bucket by the scheduled time-of-day, not current hour ──
    // For each stop, take arrivals within ±30min of its scheduled_sec for this trip.
    // That way an afternoon bus's "typical" reflects afternoon arrivals, not all-day average.
    stopETAs.forEach(stop => {
      const schedSec = scheduledMap[stop.stopId];
      if (schedSec == null) { stop.typicalMin = null; stop.typicalStddev = null; stop.typicalN = 0; return; }
      const targetMin = Math.floor(schedSec / 60);
      // Pull last 500 arrivals and filter to those within ±30min of target minute-of-day
      const arrivals = dbAll(
        `SELECT ts FROM stop_arrivals WHERE stop_id=? AND route_id=? ORDER BY ts DESC LIMIT 500`,
        [stop.stopId, v.routeId]
      );
      const matched = [];
      arrivals.forEach(r => {
        const d = new Date(r.ts);
        const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
        const diff = Math.min(Math.abs(m - targetMin), 1440 - Math.abs(m - targetMin));
        if (diff <= 30) matched.push(m);
      });
      if (matched.length < 1) { stop.typicalMin = null; stop.typicalStddev = null; stop.typicalN = 0; return; }
      const mean = matched.reduce((a,b) => a+b, 0) / matched.length;
      const variance = matched.length > 1
        ? matched.reduce((a,b) => a+(b-mean)**2, 0) / matched.length : 0;
      const stddev = Math.sqrt(variance);
      // Convert mean to minute-of-hour (since `matched` is in absolute minutes 0-1440)
      const meanMinOfHour = mean % 60;
      stop.typicalMin = Math.round(meanMinOfHour * 10) / 10;
      stop.typicalStddev = Math.round(stddev * 10) / 10;
      stop.typicalN = matched.length;
      stop.typicalHour = Math.floor(mean / 60); // remember which hour the typical is from
    });

    // ── Schedule adherence ────────────────────────────────────────────────────
    // Compare the predicted arrival at the next stop with its scheduled time.
    // delayMin > 0 = behind schedule (late); < 0 = ahead (early).
    // Only trust schedule adherence when we know the bus's real trip AND the
    // next-stop arrival is the agency's official prediction — otherwise the
    // scheduled-time match is a guess and the delta is meaningless.
    let scheduleDelayMin = null, scheduleSuspect = false;
    if (nextStop && v.tripId && !v.unassigned &&
        nextStop.scheduledMs != null && nextStop.etaMinOfficial != null) {
      const predictedArrivalMs = nowMs + nextStop.etaMinOfficial * 60000;
      scheduleDelayMin = Math.round(((predictedArrivalMs - nextStop.scheduledMs) / 60000) * 10) / 10;
      // A delay beyond ~45 min on these short routes almost always means the
      // static GTFS schedule for this trip_id doesn't line up with the realtime
      // feed's trip (versioning drift), not a genuinely hour-late bus. Trust the
      // official live ETA, but don't display a misleading adherence number.
      if (Math.abs(scheduleDelayMin) > 45) { scheduleSuspect = true; scheduleDelayMin = null; }
    }

    const payload = {
      vehicle_id: vid,
      route: v.routeName,
      routeShort: v.routeShort,
      routeColor: v.routeColor,
      tripId: v.tripId || null,
      headsign: v.headsign || null,
      speed_mph: v.speed,
      hist_avg_mph: Math.round(histAvgSpeed / 1.60934 * 10) / 10,
      hist_samples: histRows.length,
      next_stop: nextStop,
      scheduleDelayMin,            // +late / −early, null if unknown
      scheduleSuspect,             // true when delay is implausible (>2h)
      etaPrimarySource: nextStop ? nextStop.etaSource : null,
      stops: stopETAs,   // in route sequence order
      serverTs: nowMs,
    };
    stoplineMemo.set(memoKey, { t: Date.now(), data: payload });
    if (stoplineMemo.size > 200) stoplineMemo.clear(); // bound the cache
    return json(res, payload);
  }

  // GTFS official stop data (names, wheelchair)
  if (p === '/api/gtfs/stops') {
    const rows = dbAll(`SELECT stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair FROM gtfs_stops`);
    rows.forEach(r => { r.weather = weatherByStop[r.stop_id] || null; });
    return json(res, rows);
  }

  // GTFS feed status
  if (p === '/api/gtfs/status') {
    const meta = gtfsMeta();
    const n = dbGet(`SELECT COUNT(*) as n FROM gtfs_stop_times`);
    const ns = dbGet(`SELECT COUNT(*) as n FROM gtfs_stops`);
    return json(res, {
      stopTimes: n?.n || 0,
      stops: ns?.n || 0,
      lastDownloaded: meta.downloadedAt ? new Date(meta.downloadedAt).toISOString() : null,
      lastModified: meta.lastModified || null,
    });
  }

  // Learning model state
  if (p === '/api/learn/status') {
    const totalParams = TX.dModel * 6 + TX.dModel * TX.nTokens +
                       TX.dModel * TX.dModel * 4 + TX.ffnDim * TX.dModel +
                       TX.dModel * TX.ffnDim + TX.outDim * TX.dModel +
                       TX.dModel * 2; // lnGamma + lnBeta
    return json(res, {
      architecture: `Transformer block: ${TX.nTokens} tokens × ${TX.dModel}d → self-attention(${TX.nHeads}h) → FFN(${TX.ffnDim}) → ${TX.outDim} heads`,
      params: totalParams,
      learningRate: TX.lr,
      trained: TX.trained,
      trainedExamples: TX.trainedCount || 0,
    });
  }

  if (p === '/proxy') {
    const apiPath = q.get('path') || '';
    const pr = https.request({
      hostname: UPSTREAM, path: `/api/rtpi?path=${encodeURIComponent(apiPath)}`, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://myheleonbus.org/' },
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
      proxyRes.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    pr.end();
    return;
  }

  // ── BOATS layer (live AIS via aisstream.io, opt-in by env var) ────────────
  // Endpoint serves the in-memory vessel cache. Without AISSTREAM_API_KEY the
  // cache stays empty and the UI shows a clear "add your free key" hint rather
  // than fabricating fake boats. We never fall back to guessed data.
  if (p === '/api/vessels') {
    const now = Date.now();
    const list = [];
    for (const [mmsi, v] of vesselCache) {
      if ((now - v.lastTs) > VESSEL_STALE_MS) continue;
      list.push(v);
    }
    return json(res, {
      ts: now,
      keyConfigured: !!AISSTREAM_API_KEY,
      lastConnectTs: vesselLastConnectTs,
      lastError: vesselLastError,
      msgCount: vesselMsgCount,
      count: list.length,
      vessels: list,
    });
  }

  // ── HIBIKE bikeshare (GBFS v3, keyless — Hilo + Kona stations) ───────────
  if (p === '/api/hibike') {
    const stations = mobilityCache.filter(s => s.system === 'hibike');
    return json(res, {
      ts: Date.now(),
      lastPollTs: mobilityLastPollTs,
      lastError: mobilityErrors.hibike || null,
      count: stations.length,
      bikesAvailable: stations.reduce((s, st) => s + (st.bikes || 0), 0),
      stations,
    });
  }

  // ── Bikeshare / micromobility (GBFS v3, keyless — HIBIKE + Biki) ─────────
  if (p === '/api/mobility') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: mobilityLastPollTs,
      errors: mobilityErrors,
      count: mobilityCache.length,
      bikesAvailable: mobilityCache.reduce((s, st) => s + (st.bikes || 0), 0),
      systems: MOBILITY_GBFS_FEEDS.map(f => ({
        id: f.id, name: f.name,
        count: mobilityCache.filter(s => s.system === f.id).length,
        bikes: mobilityCache.filter(s => s.system === f.id).reduce((n, st) => n + (st.bikes || 0), 0),
        error: mobilityErrors[f.id] || null,
      })),
      stations: mobilityCache,
    });
  }

  // ── AIRCRAFT layer (OpenSky Network, no key) ──────────────────────────────
  if (p === '/api/aircraft') {
    const now = Date.now();
    const list = aircraftCache.filter(a => (now - a.lastTs) < AIRCRAFT_STALE_MS);
    return json(res, {
      ts: now,
      lastPollTs: aircraftLastPollTs,
      lastError: aircraftLastError,
      source: aircraftSource,
      count: list.length,
      aircraft: list,
    });
  }

  // ── EARTHQUAKES (USGS, no key) ──────────────────────────────────────────
  if (p === '/api/earthquakes') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: earthquakeLastPollTs,
      lastError: earthquakeLastError,
      count: earthquakeCache.length,
      earthquakes: earthquakeCache,
    });
  }

  // ── WEATHER ALERTS (NWS api.weather.gov, no key) ────────────────────────
  if (p === '/api/alerts') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: alertsLastPollTs,
      lastError: alertsLastError,
      count: alertsCache.length,
      alerts: alertsCache,
    });
  }

  // ── HAZARD ZONES (Hawaii Statewide GIS ArcGIS, no key) ──────────────────
  if (p === '/api/hazards/lava') {
    if (!lavaZonesCache) return json(res, { error: 'not loaded yet', lastError: hazardZonesLastError }, 503);
    return json(res, lavaZonesCache);
  }
  if (p === '/api/hazards/tsunami') {
    if (!tsunamiZonesCache) return json(res, { error: 'not loaded yet', lastError: hazardZonesLastError }, 503);
    return json(res, tsunamiZonesCache);
  }

  // ── WILDFIRE HOTSPOTS (NASA VIIRS via Esri Living Atlas, no key) ────────
  if (p === '/api/wildfire') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: wildfireLastPollTs,
      lastError: wildfireLastError,
      count: wildfireCache ? (wildfireCache.features || []).length : 0,
      geojson: wildfireCache || { type: 'FeatureCollection', features: [] },
    });
  }

  // ── PUBLIC SAFETY FACILITIES (Hawaii Statewide GIS, no key) ─────────────
  if (p === '/api/facilities/police') {
    if (!policeStationsCache) return json(res, { error: 'not loaded yet' }, 503);
    return json(res, policeStationsCache);
  }
  if (p === '/api/facilities/fire') {
    if (!fireStationsCache) return json(res, { error: 'not loaded yet' }, 503);
    return json(res, fireStationsCache);
  }
  if (p === '/api/facilities/ems') {
    if (!emsStationsCache) return json(res, { error: 'not loaded yet' }, 503);
    return json(res, emsStationsCache);
  }
  if (p === '/api/facilities/trauma') {
    if (!traumaCentersCache) return json(res, { error: 'not loaded yet' }, 503);
    return json(res, traumaCentersCache);
  }

  // ── STREAMFLOW (USGS NWIS, Big Island river gauges, no key) ─────────────
  if (p === '/api/streamflow') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: streamflowLastPollTs,
      lastError: streamflowLastError,
      geojson: streamflowCache || { type: 'FeatureCollection', features: [] },
    });
  }

  // Historical stats for every current flow gauge (all-time min/max + today's
  // percentiles). Drives the vertical level meters. Best-effort per site.
  if (p === '/api/streamflow-stats') {
    const feats = (streamflowCache && streamflowCache.features) || [];
    const today = new Date();
    const doy = `${today.getMonth() + 1}-${today.getDate()}`;
    const out = {};
    await Promise.all(feats.map(async f => {
      const site = f.properties.site_no;
      const readings = f.properties.readings || {};
      const blocks = [];
      if (f.properties.value != null) {
        blocks.push({ param: '00060', cur: f.properties.value, label: 'Flow', unit: 'ft³/s' });
      }
      if (readings.gageHeight) {
        blocks.push({ param: '00065', cur: readings.gageHeight.value, label: 'Gage height', unit: 'ft' });
      }
      if (!blocks.length) return;
      try {
        const primary = blocks[0];
        const s = await usgsDailyStats(site, primary.param);
        const d = s.byDoy[doy] || null;
        out[site] = {
          param: primary.param, label: primary.label, unit: primary.unit, current: primary.cur,
          allMin: s.allMin, allMax: s.allMax, allMinYr: s.allMinYr, allMaxYr: s.allMaxYr,
          beginYr: s.beginYr, endYr: s.endYr,
          todayMin: d && d.min, todayMax: d && d.max, todayMedian: d && d.p50, todayP10: d && d.p10, todayP90: d && d.p90,
        };
        if (blocks.length > 1) {
          const st = blocks[1];
          const ss = await usgsDailyStats(site, st.param);
          const sd = ss.byDoy[doy] || null;
          out[site].stage = {
            param: st.param, label: st.label, unit: st.unit, current: st.cur,
            allMin: ss.allMin, allMax: ss.allMax, allMinYr: ss.allMinYr, allMaxYr: ss.allMaxYr,
            beginYr: ss.beginYr, endYr: ss.endYr,
            todayMin: sd && sd.min, todayMax: sd && sd.max, todayMedian: sd && sd.p50, todayP10: sd && sd.p10, todayP90: sd && sd.p90,
          };
        }
      } catch (e) { /* site may have no stats; skip */ }
    }));
    return json(res, { stats: out });
  }

  // Time series for a gauge, for the detail-card graph. param defaults to
  // discharge; range = 'year' | '5yr' | 'month' | 'week'.
  if (p === '/api/gauge-history') {
    const site = q.get('site'); const param = q.get('param') || '00060';
    const range = q.get('range') || 'year';
    if (!site) return json(res, { error: 'site required', series: [] });
    const end = new Date();
    const start = new Date(end);
    if (range === '5yr') start.setFullYear(end.getFullYear() - 5);
    else if (range === 'month') start.setMonth(end.getMonth() - 1);
    else if (range === 'week') start.setDate(end.getDate() - 7);
    else start.setFullYear(end.getFullYear() - 1);
    const iso = d => d.toISOString().slice(0, 10);
    try {
      const series = await usgsDailyValues(site, param, iso(start), iso(end));
      return json(res, { site, param, range, series });
    } catch (e) { return json(res, { site, param, range, series: [], error: e.message }); }
  }

  // ── APRS (ham radio real-time positions, keyless) ─────────────────────────
  if (p === '/api/aprs') {
    const now = Date.now();
    const STALE = 60 * 60 * 1000; // drop stations not heard in an hour
    const list = [...aprsCache.values()].filter(s => now - s.ts < STALE);
    return json(res, { ts: now, lastRxTs: aprsLastRxTs, lastError: aprsLastError, count: list.length, stations: list });
  }

  // ── VOLCANO (USGS HVO alert levels + live webcams, keyless) ───────────────
  if (p === '/api/volcano') {
    return json(res, { ts: Date.now(), lastPollTs: volcanoLastPollTs, lastError: volcanoLastError,
      alerts: volcanoCache.alerts, webcams: volcanoCache.webcams });
  }

  // ── AVIATION METARs (airports + Bradshaw AAF military field, keyless) ─────
  if (p === '/api/metars') {
    return json(res, { ts: Date.now(), lastPollTs: metarLastPollTs, lastError: metarLastError, metars: metarCache });
  }

  // ── RAINFALL — standalone USGS rain gauges (keyless) ──────────────────────
  if (p === '/api/rainfall') {
    return json(res, { ts: Date.now(), lastPollTs: rainfallLastPollTs, lastError: rainfallLastError,
      gauges: rainfallCache });
  }

  // ── SPACE WEATHER — NOAA SWPC Kp index (keyless) ──────────────────────────
  if (p === '/api/space-weather') {
    return json(res, { ts: Date.now(), lastPollTs: spaceWxLastPollTs, lastError: spaceWxLastError,
      ...(spaceWxCache || {}) });
  }

  // ── SOLAR — live irradiance / UV across the island (keyless) ──────────────
  if (p === '/api/solar') {
    return json(res, { ts: Date.now(), lastPollTs: solarLastPollTs, lastError: solarLastError,
      points: solarCache });
  }

  // ── PLACES OF INTEREST — Wikipedia (keyless, photos + notes) ──────────────
  if (p === '/api/places') {
    return json(res, { ts: Date.now(), lastPollTs: placesLastPollTs, lastError: placesLastError,
      places: placesCache });
  }

  // ── TSUNAMI — PTWC bulletin status (keyless) ──────────────────────────────
  if (p === '/api/tsunami') {
    return json(res, { ts: Date.now(), lastPollTs: tsunamiLastPollTs, lastError: tsunamiLastError,
      ...(tsunamiCache || {}) });
  }

  // ── SKY CLOCK — sun & moon for the Big Island (keyless) ───────────────────
  if (p === '/api/skyclock') {
    return json(res, { ts: Date.now(), lastPollTs: skyClockLastPollTs, lastError: skyClockLastError,
      ...(skyClockCache || {}) });
  }

  // ── SATELLITES — live ISS/Hubble position (keyless) ───────────────────────
  if (p === '/api/satellites') {
    return json(res, { ts: Date.now(), lastPollTs: satelliteLastPollTs, lastError: satelliteLastError,
      satellites: satelliteCache });
  }

  // ── MESHTASTIC / LoRa mesh nodes (keyless) ────────────────────────────────
  if (p === '/api/meshtastic') {
    ensureMeshtasticPoll();
    return json(res, { ts: Date.now(), lastPollTs: meshtasticLastPollTs, lastError: meshtasticLastError,
      polling: meshtasticPollInFlight, count: meshtasticCache.length, nodes: meshtasticCache });
  }
  if (p === '/api/meshtastic-feed') {
    return json(res, { ts: Date.now(), lastPollTs: meshtasticFeedLastPoll, messages: meshtasticFeedCache });
  }
  if (p === '/api/meshtastic-detail') {
    const nodeId = q.get('node');
    if (!nodeId) return json(res, { error: 'node query param required' });
    try {
      const detail = await fetchMeshtasticNodeDetail(nodeId);
      return json(res, { ts: Date.now(), ...detail });
    } catch (e) { return json(res, { error: e.message, node: null, messages: [] }); }
  }

  // ── HAM REPEATERS (hearham.com, keyless) ──────────────────────────────────
  if (p === '/api/repeaters') {
    return json(res, { ts: Date.now(), lastPollTs: repeaterLastPollTs, lastError: repeaterLastError,
      count: repeaterCache.length, repeaters: repeaterCache });
  }

  // ── AIR QUALITY / VOG (Open-Meteo, keyless) ───────────────────────────────
  if (p === '/api/air-quality') {
    return json(res, { ts: Date.now(), lastPollTs: airQualityLastPollTs, lastError: airQualityLastError, points: airQualityCache });
  }

  // ── OCEAN (NDBC buoys + NOAA tide stations, keyless) ──────────────────────
  if (p === '/api/ocean') {
    return json(res, { ts: Date.now(), lastPollTs: oceanLastPollTs, lastError: oceanLastError, stations: oceanCache });
  }

  // ── MARINE (reef webcams, Aqualink sensors, fishing landings summary) ───────
  if (p === '/api/marine') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: marineLastPollTs,
      lastError: marineLastError,
      webcams: marineCache.webcams,
      reefSensors: marineCache.reefSensors,
      fishing: marineFishingCache,
    });
  }

  // ── INFRASTRUCTURE (power grid, cell towers, internet facilities) ─────────
  if (p === '/api/infrastructure') {
    if (!infraLastPollTs && !infraPollInFlight) pollInfrastructure();
    return json(res, {
      ts: Date.now(),
      lastPollTs: infraLastPollTs,
      lastError: infraLastError,
      ...infraCache,
    });
  }

  // ── SUMMIT OBSERVATORIES (Mauna Kea towers, live conditions, no key) ──────
  if (p === '/api/summits') {
    return json(res, { ts: Date.now(), lastPollTs: summitLastPollTs, lastError: summitLastError, summits: summitCache });
  }

  // ── LOCAL: fuel, traffic, telescopes, community sightings ───────────────────
  if (p === '/api/tides-predicted') {
    return json(res, { ts: Date.now(), lastPollTs: tidePredLastPollTs, lastError: tidePredLastError,
      ...tidePredCache });
  }
  if (p === '/api/local') {
    if (!localLastPollTs && !localPollInFlight) pollLocal();
    return json(res, { ts: Date.now(), lastPollTs: localLastPollTs, lastError: localLastError, ...localCache });
  }

  // ── WEATHER STATIONS (NWS, Big Island, no key) ──────────────────────────
  if (p === '/api/weather-stations') {
    return json(res, {
      ts: Date.now(),
      lastPollTs: weatherStationsLastPollTs,
      lastError: weatherStationsLastError,
      geojson: weatherStationsCache || { type: 'FeatureCollection', features: [] },
    });
  }

  res.writeHead(404); res.end('Not found');
}

function handleStatic(url, res) {
  const fp = url.pathname === '/' ? HTML_PATH : path.join(__dirname, url.pathname);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
}

// ─── AIS (boats) — aisstream.io subscription ──────────────────────────────
// Live vessel positions are a great companion to the bus layer. aisstream.io
// streams free public AIS over WebSocket but requires a free key. So the boats
// layer works out-of-the-box for everyone, a shared key is bundled below.
//
// NOTE: this is OBFUSCATION, not encryption. A key that ships in the client of
// a public app can never be truly secret — anything needed to decode it must
// ship too. The XOR+base64 below just keeps the token from being grep-able as a
// plaintext secret and from tripping naive secret scanners. Set AISSTREAM_API_KEY
// to override with your own key (recommended for heavy use / rate-limit headroom).
function decodeBundledAisKey() {
  try {
    const enc = Buffer.from('WAZcXVhbFURHUAdbUEdIVAtGXwcPB1pYGU1BBQBZVEQaAwtLW1NdBA==', 'base64');
    const pass = 'heleon-tracker-ais';
    return Buffer.from(enc.map((b, i) => b ^ pass.charCodeAt(i % pass.length))).toString('utf8');
  } catch { return ''; }
}
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || decodeBundledAisKey();
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
// Hawaii bounding box for filtering: lat 18.8..20.4, lon -156.2..-154.7
// Wider than the island itself so we catch cargo/cruise/fishing traffic in the
// approaches and inter-island lanes (AIS shore-receiver coverage out here is
// sparse, so a tight box often shows nothing even when ships are near).
// Three boxes: Big Island + approaches, Maui channel, and Oʻahu where most
// shore AIS receivers actually hear traffic (Honolulu harbor, USCG, inter-island).
const HAWAII_BBOX = [
  [[18.0, -157.5], [21.0, -154.0]],
  [[20.5, -158.5], [22.5, -155.0]],
  [[21.0, -158.5], [22.2, -157.5]],
];
const VESSEL_LAT_MIN = 18.0;
const VESSEL_LAT_MAX = 22.5;
const VESSEL_LON_MIN = -160.5;
const VESSEL_LON_MAX = -154.0;
const VESSEL_STALE_MS = 10 * 60 * 1000; // drop unseen vessels after 10 min
const vesselCache = new Map(); // mmsi -> { mmsi, name, lat, lon, speedKts, headingDeg, lastTs, shipType }
let vesselLastConnectTs = null;
let vesselLastError = null;
let vesselMsgCount = 0;
let aisSocket = null;
let aisReconnectTimer = null;

function aisMmsiFromMsg(msg) {
  if (!msg) return null;
  const md = msg.MetaData;
  if (md && md.MMSI != null) return String(md.MMSI);
  const inner = msg.Message || {};
  for (const key of ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'PositionReportForLongRange']) {
    const block = inner[key];
    if (!block) continue;
    if (block.UserID != null) return String(block.UserID);
    if (block.MMSI != null) return String(block.MMSI);
  }
  return null;
}

function aisPositionBlock(msg) {
  if (!msg || !msg.Message) return null;
  const inner = msg.Message;
  const blocks = [
    inner.PositionReport,
    inner.StandardClassBPositionReport,
    inner.ExtendedClassBPositionReport,
    inner.PositionReportForLongRange,
  ].filter(Boolean);
  for (const p of blocks) {
    if (p.Latitude != null && p.Longitude != null) return p;
  }
  const md = msg.MetaData;
  if (md && md.latitude != null && md.longitude != null) {
    return { Latitude: md.latitude, Longitude: md.longitude, Sog: null, TrueHeading: null, Cog: null };
  }
  return null;
}

function vesselInHawaii(lat, lon) {
  return lat >= VESSEL_LAT_MIN && lat <= VESSEL_LAT_MAX && lon >= VESSEL_LON_MIN && lon <= VESSEL_LON_MAX;
}

function setVesselFromMsg(msg) {
  if (!msg) return;
  vesselMsgCount++;
  const mmsi = aisMmsiFromMsg(msg);
  if (!mmsi) return;
  let v = vesselCache.get(mmsi) || { mmsi, name: '', lat: null, lon: null, speedKts: 0, headingDeg: 0, lastTs: 0, shipType: null };
  const md = msg.MetaData || {};
  if (md.ShipName && String(md.ShipName).trim()) v.name = String(md.ShipName).trim();
  const p = aisPositionBlock(msg);
  if (p) {
    if (!vesselInHawaii(p.Latitude, p.Longitude)) return;
    v.lat = p.Latitude;
    v.lon = p.Longitude;
    v.speedKts = p.Sog != null ? p.Sog : v.speedKts;
    v.headingDeg = p.TrueHeading != null && p.TrueHeading <= 359 ? p.TrueHeading
      : (p.Cog != null ? p.Cog : v.headingDeg);
    v.lastTs = Date.now();
  }
  const inner = msg.Message || {};
  if (inner.ShipStaticData) {
    const s = inner.ShipStaticData;
    if (s.Name && String(s.Name).trim()) v.name = String(s.Name).trim();
    if (s.Type != null) v.shipType = s.Type;
    v.lastTs = Date.now();
  }
  if (v.lat == null || v.lon == null) return;
  vesselCache.set(mmsi, v);
}

function connectAisStream() {
  if (!AISSTREAM_API_KEY) {
    vesselLastError = 'AISSTREAM_API_KEY not set — boats layer disabled. Sign up free at aisstream.io to enable.';
    return;
  }
  if (aisSocket && (aisSocket.readyState === WebSocket.OPEN || aisSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    aisSocket = new WebSocket(AISSTREAM_URL);
  } catch (e) {
    vesselLastError = 'WS construct failed: ' + e.message;
    scheduleAisReconnect();
    return;
  }
  aisSocket.on('open', () => {
    vesselLastConnectTs = Date.now();
    vesselLastError = null;
    try {
      aisSocket.send(JSON.stringify({
        APIKey: AISSTREAM_API_KEY,
        BoundingBoxes: HAWAII_BBOX,
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
    } catch (e) {
      vesselLastError = 'send failed: ' + e.message;
    }
  });
  aisSocket.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      setVesselFromMsg(msg);
    } catch { /* drop malformed */ }
  });
  aisSocket.on('close', () => { vesselLastError = 'connection closed'; scheduleAisReconnect(); });
  aisSocket.on('error', e => { vesselLastError = (e && e.message) || 'unknown WS error'; });
}

function scheduleAisReconnect() {
  if (aisReconnectTimer) return;
  // Backoff capped at 60s
  const delay = Math.min(60000, 5000 * Math.pow(1.5, (vesselCache.size === 0 ? 1 : 0)));
  aisReconnectTimer = setTimeout(() => { aisReconnectTimer = null; connectAisStream(); }, delay);
}

// ─── BIKESHARE / MICROMOBILITY (GBFS v3, keyless) ───────────────────────────
// Dock-based bikeshare — stations with live bike/dock counts (not per-bike GPS).
// HIBIKE: Big Island (Hilo + Kona). Biki: Oʻahu (Honolulu). No API keys.
const MOBILITY_GBFS_FEEDS = [
  { id: 'hibike', name: 'HIBIKE', host: 'kona.publicbikesystem.net', path: '/customer/gbfs/v3.0/gbfs.json' },
  { id: 'biki', name: 'Biki', host: 'honolulu.publicbikesystem.net', path: '/customer/gbfs/v3.0/gbfs.json' },
];
let mobilityCache = [];
let mobilityLastPollTs = null;
let mobilityErrors = {};

function gbfsText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    const en = field.find(x => x.language === 'en');
    return (en && en.text) || (field[0] && field[0].text) || '';
  }
  return '';
}

async function fetchGbfsStations(host, path) {
  const root = await fetchJson(host, path);
  const feeds = (root.data && root.data.feeds) || [];
  const infoFeed = feeds.find(f => f.name === 'station_information');
  const statusFeed = feeds.find(f => f.name === 'station_status');
  if (!infoFeed || !statusFeed) throw new Error('GBFS station feeds missing');
  const infoUrl = new URL(infoFeed.url);
  const statusUrl = new URL(statusFeed.url);
  const [info, status] = await Promise.all([
    fetchJson(infoUrl.hostname, infoUrl.pathname + infoUrl.search),
    fetchJson(statusUrl.hostname, statusUrl.pathname + statusUrl.search),
  ]);
  const statusById = new Map((status.data.stations || []).map(s => [s.station_id, s]));
  return (info.data.stations || []).map(st => {
    const stStat = statusById.get(st.station_id) || {};
    return {
      id: st.station_id,
      name: gbfsText(st.name) || gbfsText(st.short_name) || `Station ${st.station_id}`,
      lat: st.lat,
      lon: st.lon,
      address: st.address || '',
      capacity: st.capacity,
      bikes: stStat.num_bikes_available ?? 0,
      docks: stStat.num_docks_available ?? 0,
      isRenting: stStat.is_renting !== false,
    };
  });
}

async function pollMobility() {
  const settled = await Promise.allSettled(
    MOBILITY_GBFS_FEEDS.map(f => fetchGbfsStations(f.host, f.path)),
  );
  const next = [];
  const errs = {};
  settled.forEach((r, i) => {
    const feed = MOBILITY_GBFS_FEEDS[i];
    if (r.status === 'fulfilled') {
      for (const st of r.value) next.push({ ...st, system: feed.id, systemName: feed.name });
    } else {
      errs[feed.id] = r.reason?.message || String(r.reason);
    }
  });
  if (next.length) mobilityCache = next;
  mobilityErrors = errs;
  mobilityLastPollTs = Date.now();
}

// ─── AIRCRAFT (OpenSky Network) ────────────────────────────────────────────
// Live ADS-B positions around the Hawaiian islands. Free, no API key required
// for the anonymous tier (10s rate limit). We poll every 12s with a tight
// Hawaii bbox so we never get more than ~30 aircraft per call.
const OPENSKY_URL = 'https://opensky-network.org/api/states/all';
// Big-Island-focused bbox. OpenSky charges per query by area: ≤25 sq° = 1 credit,
// 25–100 = 2, etc. The old wide Hawaii bbox (~42 sq°) cost 2 credits/call and blew
// past the anonymous 400-credit/day budget → constant rate-limit timeouts. This
// box (~1.5° × 1.8° ≈ 2.7 sq°) is 1 credit and still covers ITO/KOA + approaches.
const HAWAII_AIR_BBOX = {
  lamin: 18.7, lomin: -156.3,
  lamax: 20.5, lomax: -154.6,
};
const AIRCRAFT_STALE_MS = 90 * 1000;  // 90s — OpenSky refreshes every 10s; anything older is unreliable
let aircraftCache = [];               // [{ icao24, callsign, country, lat, lon, altM, velMs, headingDeg, onGround, lastTs }]
let aircraftLastPollTs = null;
let aircraftLastError = null;
let aircraftSource = null;  // which feed the current cache came from

// ── OpenSky OAuth2 (optional, free) ──────────────────────────────────────────
// Anonymous = 400 credits/day (one /states/all call costs 1+ credits), so a live
// poll exhausts it fast. A free OpenSky account → API client gives 4,000/day.
// Set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET to enable; we fetch & cache an
// OAuth2 token (client_credentials grant) and send it as a Bearer header. With no
// credentials we fall back to anonymous (still works, just polled more slowly).
// Credentials come from env vars (preferred — set these on Render) or, for local
// dev convenience, a gitignored Sources/credentials.json ({clientId, clientSecret}).
function loadOpenSkyCreds() {
  let id = process.env.OPENSKY_CLIENT_ID || '', secret = process.env.OPENSKY_CLIENT_SECRET || '';
  if (!id || !secret) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'Sources', 'credentials.json'), 'utf8'));
      id = id || c.clientId || ''; secret = secret || c.clientSecret || '';
    } catch { /* no file — anonymous */ }
  }
  return { id, secret };
}
const { id: OPENSKY_CLIENT_ID, secret: OPENSKY_CLIENT_SECRET } = loadOpenSkyCreds();
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const openskyAuthed = () => !!(OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET);
let openskyToken = null, openskyTokenExp = 0;

async function getOpenSkyToken() {
  if (!openskyAuthed()) return null;
  if (openskyToken && Date.now() < openskyTokenExp - 60000) return openskyToken; // still valid (60s margin)
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OPENSKY_CLIENT_ID,
    client_secret: OPENSKY_CLIENT_SECRET,
  }).toString();
  const u = new URL(OPENSKY_TOKEN_URL);
  const json = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`token HTTP ${res.statusCode}`)); try { resolve(JSON.parse(b)); } catch { reject(new Error('bad token JSON')); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('token timeout')); });
    req.end(body);
  });
  openskyToken = json.access_token;
  openskyTokenExp = Date.now() + (json.expires_in || 1800) * 1000;
  return openskyToken;
}

// OpenSky's anonymous tier is rate-limited and frequently slow/throttled. Fetch
// with a generous timeout and an explicit HTTP-status check (a 429/503 returns an
// HTML body that would otherwise blow up JSON.parse and look like a hard error).
// On ANY failure we keep the last good aircraft on screen (cache untouched) so a
// transient timeout doesn't blank the map — we only note the error.
function fetchOpenSky(reqPath, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'heleon-tracker', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = https.request({ hostname: 'opensky-network.org', path: reqPath, method: 'GET',
      headers, timeout: 20000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('rate limited (429) — backing off'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON from OpenSky')); }
      });
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Authenticated users have 10× the credits, so they can afford a wider box that
// shows all-Hawaii traffic (inter-island flights, neighbor-island airports).
const HAWAII_AIR_BBOX_WIDE = { lamin: 18.5, lomin: -160.5, lamax: 22.5, lomax: -154.5 };

// PRIMARY aircraft source: community ADS-B aggregators (adsb.lol, airplanes.live,
// adsb.one). They're free, keyless, and — critically — have FAR better Hawaii
// coverage than OpenSky's anonymous tier (dozens of aircraft vs frequently zero),
// because they pool volunteer feeders. Same v2 point/radius API + response shape
// (ADSBExchange-style `ac[]`), so one parser handles all three. Radius in NM.
const ADSB_HOSTS = ['api.adsb.lol', 'api.airplanes.live', 'api.adsb.one'];
const ADSB_CENTER = { lat: 19.6, lon: -156.2 };  // between Big Island & the chain
const ADSB_RADIUS_NM = 250;                        // covers the whole island group
const ftToM = 0.3048, ktToMs = 0.514444;

async function pollAircraft() {
  const reqPath = `/v2/point/${ADSB_CENTER.lat}/${ADSB_CENTER.lon}/${ADSB_RADIUS_NM}`;
  let data = null, usedHost = null, lastErr = null;
  for (const host of ADSB_HOSTS) {
    try { data = await fetchJson(host, reqPath, { 'User-Agent': 'heleon-tracker' }); usedHost = host; break; }
    catch (e) { lastErr = `${host}: ${e.message}`; }
  }
  if (data && Array.isArray(data.ac)) {
    const now = Date.now();
    const next = [];
    for (const a of data.ac) {
      const lat = a.lat, lon = a.lon;
      if (lat == null || lon == null) continue;
      // alt_baro can be the string "ground"; gs in knots; track in degrees.
      const onGround = a.alt_baro === 'ground' || a.alt_baro === 0;
      const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : (typeof a.alt_geom === 'number' ? a.alt_geom : null);
      next.push({
        icao24: a.hex, callsign: (a.flight || '').trim(),
        country: '', // aggregators don't include origin country; not worth a lookup
        lat, lon,
        altM: altFt != null ? altFt * ftToM : null,
        onGround,
        velMs: a.gs != null ? a.gs * ktToMs : null,
        headingDeg: a.track != null ? a.track : (a.true_heading != null ? a.true_heading : 0),
        verticalRateMs: a.baro_rate != null ? a.baro_rate * ftToM / 60 : null,
        type: a.t || null, registration: a.r || null,  // aircraft type + tail number
        lastContact: Math.round(now / 1000 - (a.seen || 0)),
        lastTs: now,
      });
    }
    aircraftCache = next;
    aircraftLastPollTs = now;
    aircraftLastError = null;
    aircraftSource = usedHost;
    return;
  }
  // All aggregators failed — fall back to OpenSky (keyed or anonymous) so we
  // degrade gracefully rather than blanking the layer.
  try {
    const box = openskyAuthed() ? HAWAII_AIR_BBOX_WIDE : HAWAII_AIR_BBOX;
    const params = new URLSearchParams(box).toString();
    let token = null;
    try { token = await getOpenSkyToken(); } catch { /* anonymous */ }
    const res = await fetchOpenSky(`/api/states/all?${params}`, token);
    if (res && res.states === null) { aircraftCache = []; aircraftLastPollTs = Date.now(); aircraftLastError = null; aircraftSource = 'opensky'; return; }
    if (!res || !Array.isArray(res.states)) { aircraftLastError = lastErr || 'no aircraft source'; return; }
    const now = Date.now();
    aircraftCache = res.states.filter(s => s[6] != null && s[5] != null).map(s => ({
      icao24: s[0], callsign: (s[1] || '').trim(), country: s[2], lat: s[6], lon: s[5],
      altM: s[7], onGround: !!s[8], velMs: s[9], headingDeg: s[10] != null ? s[10] : 0,
      verticalRateMs: s[11], lastContact: s[4], lastTs: now,
    }));
    aircraftLastPollTs = now; aircraftLastError = null; aircraftSource = 'opensky';
  } catch (e) {
    aircraftLastError = lastErr || (e && e.message) || 'unknown error';
  }
}

// ─── HAWAII CIVIC LAYERS (all free, keyless, official federal/state sources) ─
// Three independent feeds relevant to a Big Island map: recent earthquakes
// (USGS), active NWS watches/warnings for Hawai'i, and static hazard-zone
// polygons (lava flow zones, tsunami evacuation zones — Hawaii Statewide GIS
// ArcGIS REST). Hazard-zone geometry never changes day-to-day, so it's fetched
// once at boot and re-fetched only every 24h; earthquakes/alerts poll often.

function fetchJson(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: 'GET', headers, timeout: 15000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function fetchText(hostname, reqPath, headers, proto) {
  const mod = proto === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request({ hostname, path: reqPath, method: 'GET', headers, timeout: 25000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => res.statusCode === 200 ? resolve(b) : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── USGS gauge statistics (daily percentiles over the full period of record) ──
// Drives the vertical meter (where does today's reading sit between the all-time
// min and max, and vs the median for this day of year) and the detail card.
// Cached per site+param for a day — these barely change.
const gaugeStatsCache = new Map(); // `${site}:${param}` -> { at, stats }
async function usgsDailyStats(site, param) {
  const key = `${site}:${param}`;
  const c = gaugeStatsCache.get(key);
  if (c && Date.now() - c.at < 24 * 3600 * 1000) return c.stats;
  const rdb = await fetchText('waterservices.usgs.gov',
    `/nwis/stat/?format=rdb&sites=${site}&statReportType=daily&statTypeCd=all&parameterCd=${param}`,
    { 'User-Agent': 'heleon-tracker' });
  // RDB: comment lines start with '#'; then a header row, a format row, then data.
  const lines = rdb.split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length < 3) throw new Error('no stat rows');
  const cols = lines[0].split('\t');
  const idx = name => cols.indexOf(name);
  const iMon = idx('month_nu'), iDay = idx('day_nu'), iBeg = idx('begin_yr'), iEnd = idx('end_yr');
  const iCount = idx('count_nu'), iMax = idx('max_va'), iMin = idx('min_va'), iMean = idx('mean_va');
  const iMaxYr = idx('max_va_yr'), iMinYr = idx('min_va_yr'), iP50 = idx('p50_va'), iP10 = idx('p10_va'), iP90 = idx('p90_va');
  let allMin = Infinity, allMax = -Infinity, allMinYr = null, allMaxYr = null, beginYr = null, endYr = null;
  const byDoy = {}; // "M-D" -> {min,max,mean,p10,p50,p90}
  for (let i = 2; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const mn = +c[iMon], dy = +c[iDay];
    const mx = parseFloat(c[iMax]), mi = parseFloat(c[iMin]);
    if (Number.isFinite(mx) && mx > allMax) { allMax = mx; allMaxYr = c[iMaxYr]; }
    if (Number.isFinite(mi) && mi < allMin) { allMin = mi; allMinYr = c[iMinYr]; }
    if (iBeg >= 0 && c[iBeg]) beginYr = beginYr == null ? +c[iBeg] : Math.min(beginYr, +c[iBeg]);
    if (iEnd >= 0 && c[iEnd]) endYr = endYr == null ? +c[iEnd] : Math.max(endYr, +c[iEnd]);
    byDoy[`${mn}-${dy}`] = {
      min: parseFloat(c[iMin]), max: parseFloat(c[iMax]), mean: parseFloat(c[iMean]),
      p10: parseFloat(c[iP10]), p50: parseFloat(c[iP50]), p90: parseFloat(c[iP90]),
    };
  }
  const stats = {
    param, allMin: allMin === Infinity ? null : allMin, allMax: allMax === -Infinity ? null : allMax,
    allMinYr, allMaxYr, beginYr, endYr, byDoy,
  };
  gaugeStatsCache.set(key, { at: Date.now(), stats });
  return stats;
}

// USGS daily-values time series for the card's graph. Cached briefly.
const gaugeHistCache = new Map();
async function usgsDailyValues(site, param, startDT, endDT) {
  const key = `${site}:${param}:${startDT}:${endDT}`;
  const c = gaugeHistCache.get(key);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.series;
  const j = await fetchJson('waterservices.usgs.gov',
    `/nwis/dv/?format=json&sites=${site}&parameterCd=${param}&statCd=00003&startDT=${startDT}&endDT=${endDT}`,
    { 'User-Agent': 'heleon-tracker' });
  const ts = j.value && j.value.timeSeries && j.value.timeSeries[0];
  const series = ts ? ts.values[0].value
    .map(v => ({ t: v.dateTime.slice(0, 10), v: parseFloat(v.value) }))
    .filter(x => Number.isFinite(x.v) && x.v > -999999) : [];
  gaugeHistCache.set(key, { at: Date.now(), series });
  return series;
}

// Big Island bbox, generous margin (same footprint as the vehicle/aircraft boxes).
const BIGISLAND_BBOX = { minLat: 18.5, maxLat: 20.5, minLon: -156.3, maxLon: -154.5 };

let earthquakeCache = [];
let earthquakeLastPollTs = null, earthquakeLastError = null;
async function pollEarthquakes() {
  const b = BIGISLAND_BBOX;
  const starttime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const qs = `format=geojson&starttime=${starttime}&minlatitude=${b.minLat}&maxlatitude=${b.maxLat}&minlongitude=${b.minLon}&maxlongitude=${b.maxLon}&minmagnitude=1.5&orderby=time`;
  try {
    const data = await fetchJson('earthquake.usgs.gov', `/fdsnws/event/1/query?${qs}`, { 'User-Agent': 'heleon-tracker' });
    earthquakeCache = (data.features || []).map(f => ({
      id: f.id,
      mag: f.properties.mag,
      place: f.properties.place,
      time: f.properties.time,
      depthKm: f.geometry.coordinates[2],
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      url: f.properties.url,
      tsunami: !!f.properties.tsunami,
    }));
    earthquakeLastPollTs = Date.now();
    earthquakeLastError = null;
  } catch (e) {
    earthquakeLastError = (e && e.message) || 'unknown error';
  }
}

let alertsCache = [];
let alertsLastPollTs = null, alertsLastError = null;
async function pollAlerts() {
  try {
    const data = await fetchJson('api.weather.gov', '/alerts/active?area=HI', {
      'User-Agent': 'heleon-tracker (https://github.com/hatsmagee/Bus-Tracker)',
      'Accept': 'application/geo+json',
    });
    alertsCache = (data.features || []).map(f => ({
      id: f.properties.id,
      event: f.properties.event,
      severity: f.properties.severity,
      headline: f.properties.headline,
      areaDesc: f.properties.areaDesc,
      sent: f.properties.sent,
      expires: f.properties.expires,
      description: f.properties.description,
    }));
    alertsLastPollTs = Date.now();
    alertsLastError = null;
  } catch (e) {
    alertsLastError = (e && e.message) || 'unknown error';
  }
}

// Hazard-zone polygons (lava flow zones id 3, tsunami evacuation zones id 2) —
// static reference geometry, refetched daily rather than on the live poll loop.
let lavaZonesCache = null, tsunamiZonesCache = null;
let hazardZonesLastFetchTs = null, hazardZonesLastError = null;
async function fetchHazardLayer(layerId, outFields) {
  const b = BIGISLAND_BBOX;
  const geom = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
  const qs = `where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&f=geojson&geometryPrecision=5`;
  const data = await fetchJson('geodata.hawaii.gov', `/arcgis/rest/services/Hazards/MapServer/${layerId}/query?${qs}`, { 'User-Agent': 'heleon-tracker' });
  return data;
}
async function pollHazardZones() {
  try {
    lavaZonesCache = await fetchHazardLayer(3, 'hzone,mzone');
    tsunamiZonesCache = await fetchHazardLayer(2, 'zone_type,zone_desc,evac_zone,island');
    hazardZonesLastFetchTs = Date.now();
    hazardZonesLastError = null;
  } catch (e) {
    hazardZonesLastError = (e && e.message) || 'unknown error';
  }
}

// Wildfire hotspots — NASA VIIRS satellite thermal-anomaly detections, the
// same public Esri Living Atlas layer HI-EMA's own wildfire dashboard uses.
// Genuinely live (refreshed continuously), unlike everything else in this
// block, so it polls on the fast (5-min) cadence, not the daily one.
let wildfireCache = null;
let wildfireLastPollTs = null, wildfireLastError = null;
async function pollWildfireHotspots() {
  const b = BIGISLAND_BBOX;
  const geom = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
  const qs = `where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=latitude,longitude,confidence,frp,acq_date,acq_time,hours_old,daynight&f=geojson`;
  try {
    wildfireCache = await fetchJson('services9.arcgis.com', `/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query?${qs}`, { 'User-Agent': 'heleon-tracker' });
    wildfireLastPollTs = Date.now();
    wildfireLastError = null;
  } catch (e) {
    wildfireLastError = (e && e.message) || 'unknown error';
  }
}

// Public-safety facility locations — Hawaii Statewide GIS EmergMgmtPubSafety
// service. Static reference data (station addresses), fetched once like the
// hazard-zone polygons, not polled live — there is no live dispatch/CAD feed
// published by Hawaii County Police or Fire; this is location context only.
let policeStationsCache = null, fireStationsCache = null, emsStationsCache = null, traumaCentersCache = null;
async function fetchPubSafetyLayer(layerId, outFields, extraWhere) {
  const b = BIGISLAND_BBOX;
  const geom = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
  const where = extraWhere || '1=1';
  const qs = `where=${encodeURIComponent(where)}&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&f=geojson`;
  return fetchJson('geodata.hawaii.gov', `/arcgis/rest/services/EmergMgmtPubSafety/MapServer/${layerId}/query?${qs}`, { 'User-Agent': 'heleon-tracker' });
}
async function pollPubSafetyFacilities() {
  try {
    policeStationsCache = await fetchPubSafetyLayer(12, 'district,type,name,address,zipcode');
    fireStationsCache = await fetchPubSafetyLayer(7, 'name,alt_name,island,status', "island='Hawaii'");
    emsStationsCache = await fetchPubSafetyLayer(8, 'unit,unit_name,county,address');
    traumaCentersCache = await fetchPubSafetyLayer(9, 'facility_name,trauma_level,island,address,city', "island='Hawaii'");
    hazardZonesLastError = null; // reuse the same daily-refresh error slot
  } catch (e) {
    hazardZonesLastError = (e && e.message) || 'unknown error';
  }
}

// USGS real-time streamflow — Big Island river/streams gauges, keyless JSON
// from the National Water Information System. Filtered down to the Big Island
// bbox client-side because the NWIS endpoint only takes one major filter
// (state, bbox, OR sites), and state=HI also pulls in Kauai/Maui sites.
let streamflowCache = null;
let streamflowLastPollTs = null, streamflowLastError = null;
// Which USGS parameters we ask for, and how to present each. A gauge often
// reports only SOME of these — so instead of showing "—" when discharge is
// missing, we surface whatever it does have (gage height, water temp, etc.).
const NWIS_PARAMS = {
  '00060': { key: 'discharge', label: 'Flow',        unit: 'ft³/s' },
  '00065': { key: 'gageHeight', label: 'Gage height', unit: 'ft' },
  '00010': { key: 'waterTempC', label: 'Water temp',  unit: '°C' },
  '00045': { key: 'precip',     label: 'Precip',       unit: 'in' },
};
async function pollStreamflow() {
  try {
    const pc = Object.keys(NWIS_PARAMS).join(',');
    // siteType ST (stream) + LK (lake) so we don't miss gauges that only report
    // stage; ask for every parameter above in one call.
    const data = await fetchJson('waterservices.usgs.gov',
      `/nwis/iv/?format=json&stateCd=hi&siteType=ST&parameterCd=${pc}&period=PT2H`,
      { 'User-Agent': 'heleon-tracker' });
    const ts = (data.value && data.value.timeSeries) || [];
    // Group all parameter series by site (USGS returns one series per site×param).
    const bySite = new Map();
    for (const s of ts) {
      const g = s.sourceInfo.geoLocation.geogLocation;
      const lat = g.latitude, lon = g.longitude;
      if (lat < BIGISLAND_BBOX.minLat || lat > BIGISLAND_BBOX.maxLat ||
          lon < BIGISLAND_BBOX.minLon || lon > BIGISLAND_BBOX.maxLon) continue;
      const siteNo = s.sourceInfo.siteCode[0].value;
      const paramCd = s.variable && s.variable.variableCode && s.variable.variableCode[0] && s.variable.variableCode[0].value;
      const meta = NWIS_PARAMS[paramCd];
      if (!meta) continue;
      const vals = (s.values && s.values[0] && s.values[0].value) || [];
      const latest = vals[vals.length - 1];
      if (!latest || latest.value == null || latest.value === 'n/a') continue;
      const num = parseFloat(latest.value);
      if (!Number.isFinite(num) || num <= -999999) continue; // USGS -999999 = no data
      let rec = bySite.get(siteNo);
      if (!rec) { rec = { site_no: siteNo, name: s.sourceInfo.siteName, lat, lon, readings: {}, ts: null }; bySite.set(siteNo, rec); }
      rec.readings[meta.key] = { value: num, label: meta.label, unit: meta.unit };
      if (latest.dateTime && (!rec.ts || latest.dateTime > rec.ts)) rec.ts = latest.dateTime;
    }
    const features = [];
    for (const rec of bySite.values()) {
      const d = rec.readings.discharge;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [rec.lon, rec.lat] },
        properties: {
          site_no: rec.site_no,
          name: rec.name,
          // `value`/`unit` keep the old discharge-first contract for the wheel
          // spin; `readings` carries EVERY parameter this gauge reports.
          value: d ? d.value : null,
          unit: 'ft³/s',
          readings: rec.readings,
          ts: rec.ts,
        },
      });
    }
    streamflowCache = { type: 'FeatureCollection', features };
    streamflowLastPollTs = Date.now();
    streamflowLastError = null;
  } catch (e) {
    streamflowLastError = (e && e.message) || 'unknown error';
  }
}

// ─── RAINFALL — standalone USGS rain gauges (keyless) ────────────────────────
// The streamflow poller restricts to siteType=ST (streams), so it misses the
// dozens of DEDICATED rain gauges USGS runs on the Big Island (Saddle Rd,
// Honoliʻi, Kīholo, Kawainui…). Those report precip (param 00045) without any
// stream. Pull them separately so we can show live rainfall accumulation with
// an animated rain icon that intensifies with the rate.
let rainfallCache = [];
let rainfallLastPollTs = null, rainfallLastError = null;
async function pollRainfall() {
  try {
    const data = await fetchJson('waterservices.usgs.gov',
      `/nwis/iv/?format=json&stateCd=hi&parameterCd=00045&siteStatus=active&period=PT6H`,
      { 'User-Agent': 'heleon-tracker' });
    const ts = (data.value && data.value.timeSeries) || [];
    const bySite = new Map();
    for (const s of ts) {
      const g = s.sourceInfo.geoLocation.geogLocation;
      const lat = g.latitude, lon = g.longitude;
      if (lat < BIGISLAND_BBOX.minLat || lat > BIGISLAND_BBOX.maxLat ||
          lon < BIGISLAND_BBOX.minLon || lon > BIGISLAND_BBOX.maxLon) continue;
      const siteNo = s.sourceInfo.siteCode[0].value;
      const vals = (s.values && s.values[0] && s.values[0].value) || [];
      // Sum the incremental precip readings over the window (each is inches
      // since the previous reading) for a "last 6h" accumulation, and keep the
      // most recent single reading as the current rate.
      let accum = 0, latestVal = null, latestTime = null;
      for (const v of vals) {
        const num = parseFloat(v.value);
        if (!Number.isFinite(num) || num <= -999999 || num < 0) continue;
        accum += num;
        latestVal = num; latestTime = v.dateTime;
      }
      if (latestVal == null) continue;
      bySite.set(siteNo, {
        site_no: siteNo, name: s.sourceInfo.siteName, lat, lon,
        latestIn: latestVal, accum6hIn: +accum.toFixed(2), at: latestTime,
      });
    }
    rainfallCache = [...bySite.values()];
    rainfallLastPollTs = Date.now(); rainfallLastError = null;
  } catch (e) { rainfallLastError = (e && e.message) || 'unknown error'; }
}

// ─── SPACE WEATHER — NOAA SWPC planetary K-index (keyless) ───────────────────
// Global geomagnetic activity (Kp 0-9). Not Big-Island-specific, but it's the
// live "space weather" readout for an RTS status board — aurora potential, HF
// radio propagation (relevant to the ham layer), GPS accuracy. One tiny JSON.
let spaceWxCache = null;
let spaceWxLastPollTs = null, spaceWxLastError = null;
async function pollSpaceWeather() {
  try {
    const j = await fetchJson('services.swpc.noaa.gov',
      '/products/noaa-planetary-k-index.json', { 'User-Agent': 'heleon-tracker' });
    // This product is an array of OBJECTS {time_tag, Kp, a_running, station_count}
    // (not array-of-arrays). Take the most recent with a numeric Kp.
    if (Array.isArray(j) && j.length) {
      let last = null;
      for (let i = j.length - 1; i >= 0; i--) {
        if (j[i] && Number.isFinite(parseFloat(j[i].Kp))) { last = j[i]; break; }
      }
      if (last) {
        const kp = parseFloat(last.Kp);
        const level = kp >= 7 ? 'severe storm' : kp >= 5 ? 'geomagnetic storm'
          : kp >= 4 ? 'active' : 'quiet';
        spaceWxCache = { kp, level, at: last.time_tag, auroraPossible: kp >= 5 };
        spaceWxLastPollTs = Date.now(); spaceWxLastError = null;
      } else spaceWxLastError = 'no numeric Kp';
    } else spaceWxLastError = 'unexpected response';
  } catch (e) { spaceWxLastError = (e && e.message) || 'unknown error'; }
}

// NWS weather stations — Big Island fixed weather stations (HELCO *HE* and
// Hawaii Island *HI* suffixes in NWS naming) with real-time observations:
// temperature, dewpoint, humidity, wind, barometer. Refreshed every 10 min.
// Map an NWS text description to a sky-condition emoji so the weather markers
// read as little weather glyphs (☀️/⛅/🌧️…) instead of a bare thermometer number.
function wxConditionEmoji(desc) {
  const d = (desc || '').toLowerCase();
  if (!d) return '🌡️';
  if (/thunder|t-storm|tstm/.test(d)) return '⛈️';
  if (/snow|flurr|sleet|ice|wintry/.test(d)) return '🌨️';
  if (/rain|shower|drizzle|precip/.test(d)) return '🌧️';
  if (/fog|mist|haze|smoke/.test(d)) return '🌫️';
  if (/overcast|cloudy/.test(d)) return '☁️';
  if (/mostly cloudy|broken/.test(d)) return '🌥️';
  if (/partly|scattered|few/.test(d)) return '⛅';
  if (/clear|sunny|fair/.test(d)) return '☀️';
  if (/wind|breez/.test(d)) return '💨';
  return '🌡️';
}
let weatherStationsCache = null;
let weatherStationsLastPollTs = null, weatherStationsLastError = null;
async function fetchWeatherStationsState() {
  try {
    const list = await fetchJson('api.weather.gov', '/stations?state=HI&limit=100',
      { 'User-Agent': 'heleon-tracker', 'Accept': 'application/geo+json' });
    const all = list.features || [];
    // Pre-compute the Big Island subset, with coordinates normalized to lon/lat,
    // so we can fan out per-station /observations/latest calls without
    // re-filtering the whole list each cycle.
    const big = all.filter(f => {
      const c = f.geometry && f.geometry.coordinates;
      return c && c[1] > 18.8 && c[1] < 20.5 && c[0] > -156.4 && c[0] < -154.5;
    });
    // Concurrently fetch each station's latest observation, with a short per-call
    // timeout so a single slow station doesn't stall the whole batch.
    const fetchOne = async (f) => {
      const p = f.properties;
      const sid = p.stationIdentifier;
      try {
        const obs = await fetchJson('api.weather.gov', `/stations/${sid}/observations/latest`,
          { 'User-Agent': 'heleon-tracker', 'Accept': 'application/geo+json' });
        const o = obs.properties || {};
        const C = v => v == null ? null : (typeof v === 'object' ? v.value : v);
        return {
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            stationId: sid,
            name: p.name || sid,
            elevation: p.elevation && p.elevation.value,
            timeZone: p.timeZone,
            temperatureC: C(o.temperature),
            dewpointC: C(o.dewpoint),
            humidity: C(o.relativeHumidity),
            windDirection: C(o.windDirection),
            windSpeedKmh: C(o.windSpeed),
            windGustKmh: C(o.windGust),
            pressurePa: C(o.barometricPressure),
            textDescription: o.textDescription || '',
            wxIcon: wxConditionEmoji(o.textDescription || ''),
            timestamp: C(o.timestamp),
          },
        };
      } catch (e) { return null; }
    };
    const results = await Promise.all(big.map(fetchOne));
    weatherStationsCache = {
      type: 'FeatureCollection',
      features: results.filter(Boolean),
    };
    weatherStationsLastPollTs = Date.now();
    weatherStationsLastError = null;
  } catch (e) {
    weatherStationsLastError = (e && e.message) || 'unknown error';
  }
}
const fetchWeatherStations = fetchWeatherStationsState;

// ─── SUMMIT OBSERVATORIES (Maunakea + Mauna Loa) ─────────────────────────────
// Maunakea: MKWC publishes a single HTML table of per-telescope weather (CFHT,
// Keck, Subaru, IRTF, JCMT, UKIRT, SMA, VLBA, Hale Pōhaku) — keyless HTTP.
// Mauna Loa: NOAA GML hourly met + daily CO₂ from public FTP-style URLs on
// gml.noaa.gov (Keeling Curve site). MLO road access is still restricted after
// the 2022 eruption but met/CO₂ files continue updating — see obop/mlo status.
const MKWC_OBS = {
  'CFHT/GEM': { id: 'cfht', name: 'CFHT / Gemini North', lat: 19.8252, lon: -155.4692, elevM: 4204 },
  'UKIRT': { id: 'ukirt', name: 'UKIRT Infrared Telescope', lat: 19.8237, lon: -155.4693, elevM: 4194 },
  'IRTF': { id: 'irtf', name: 'NASA Infrared Telescope Facility (IRTF)', lat: 19.8267, lon: -155.4784, elevM: 4168 },
  'SUBARU': { id: 'subaru', name: 'Subaru Telescope', lat: 19.8235, lon: -155.4765, elevM: 4139 },
  'KECK': { id: 'keck', name: 'W. M. Keck Observatory', lat: 19.8263, lon: -155.4749, elevM: 4160 },
  'JCMT': { id: 'jcmt', name: 'James Clerk Maxwell Telescope', lat: 19.8229, lon: -155.4783, elevM: 4082 },
  'SMA': { id: 'sma', name: 'Submillimeter Array', lat: 19.8242, lon: -155.4792, elevM: 4080 },
  'VLBA': { id: 'vlba', name: 'VLBA Station (Maunakea)', lat: 19.8013, lon: -155.4564, elevM: 3720 },
  'HP': { id: 'hpohaku', name: 'Hale Pōhaku (mid-level facility)', lat: 19.7583, lon: -155.4556, elevM: 2800 },
};
const MLO_SITE = {
  id: 'mlo', name: 'Mauna Loa Observatory (NOAA GML)', lat: 19.5362, lon: -155.5763, elevM: 3397,
  pageUrl: 'https://gml.noaa.gov/obop/mlo/',
  webcamUrl: 'https://gml.noaa.gov/webdata/mlo/webcam/northcam.jpg',
  note: 'Road/public access limited since 2022 eruption; GML is restoring instruments. Met + CO₂ data from GML FTP.',
};

function mkwcStationKey(label) {
  const s = String(label || '').trim();
  if (!s || s === '--') return null;
  if (MKWC_OBS[s]) return s;
  for (const k of Object.keys(MKWC_OBS)) {
    if (s.startsWith(k.split('/')[0])) return k;
  }
  return null;
}
function parseMkwcTable(html) {
  const out = [];
  const seen = new Set();
  for (const row of (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [])) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 8) continue;
    const key = mkwcStationKey(cells[0]);
    if (!key || seen.has(key)) continue;
    if (cells[1] === '--' || cells[3] === '--') continue;
    seen.add(key);
    const meta = MKWC_OBS[key];
    const tempC = parseFloat(cells[3]);
    const windMph = parseFloat(cells[6]);
    out.push({
      id: meta.id, name: meta.name, lat: meta.lat, lon: meta.lon, elevM: meta.elevM,
      source: 'Maunakea Weather Center',
      pageUrl: 'http://mkwc.ifa.hawaii.edu/current/',
      readings: {
        tempC: Number.isFinite(tempC) ? tempC : null,
        dewpointC: Number.isFinite(parseFloat(cells[4])) ? parseFloat(cells[4]) : null,
        humidity: Number.isFinite(parseFloat(cells[5])) ? parseFloat(cells[5]) : null,
        windMph: Number.isFinite(windMph) ? windMph : null,
        windGustMph: Number.isFinite(parseFloat(cells[7])) ? parseFloat(cells[7]) : null,
        windDir: cells[8] && cells[8] !== '--' ? cells[8] : null,
        pressureMb: Number.isFinite(parseFloat(cells[9])) ? parseFloat(cells[9]) : null,
        rainMm: Number.isFinite(parseFloat(cells[10])) ? parseFloat(cells[10]) : null,
        readingTs: `${cells[1]} ${cells[2]} HST`,
      },
    });
  }
  return out;
}
function parseMloMetHourly(text) {
  const lines = text.split('\n').filter(l => l.startsWith('MLO'));
  if (!lines.length) return {};
  const p = lines[lines.length - 1].trim().split(/\s+/);
  if (p.length < 12) return {};
  const tempC = parseFloat(p[9]);
  const dew = parseFloat(p[10]);
  const pres = parseFloat(p[8]);
  return {
    tempC: Number.isFinite(tempC) ? tempC : null,
    dewpointC: Number.isFinite(dew) && dew > -900 ? dew : null,
    pressureMb: Number.isFinite(pres) && pres > 100 ? pres : null,
    windDir: parseInt(p[5], 10),
    windMs: Number.isFinite(parseFloat(p[6])) ? parseFloat(p[6]) : null,
    rainMm: Number.isFinite(parseFloat(p[11])) && parseFloat(p[11]) >= 0 ? parseFloat(p[11]) : null,
    readingTs: `${p[1]}-${p[2].padStart(2, '0')}-${p[3].padStart(2, '0')} ${p[4]}:00 UTC`,
  };
}
function parseNoaaDailyCo2(text) {
  const rows = text.split('\n').filter(l => l && !l.startsWith('#'));
  const last = rows[rows.length - 1].trim().split(/\s+/);
  if (last.length < 5) return {};
  return {
    co2ppm: parseFloat(last[4]),
    co2Year: `${last[0]}-${last[1].padStart(2, '0')}-${last[2].padStart(2, '0')}`,
    co2Cadence: 'daily',
  };
}
function parseNoaaWeeklyCo2(text) {
  const rows = text.split('\n').filter(l => l && !l.startsWith('#'));
  const last = rows[rows.length - 1].trim().split(/\s+/);
  if (last.length < 8) return {};
  return {
    co2ppm: parseFloat(last[4]),
    co2Year: `${last[0]}-${last[1].padStart(2, '0')}-${last[2].padStart(2, '0')}`,
    co2OneYearAgo: parseFloat(last[6]),
    co2TenYearsAgo: parseFloat(last[7]),
    co2Cadence: 'weekly',
  };
}
let summitCache = [];
let summitLastPollTs = null, summitLastError = null;

async function pollSummits() {
  const next = [];
  const hdrs = { 'User-Agent': 'Mozilla/5.0 (heleon-tracker)' };
  try {
    const mkwcHtml = await fetchText('mkwc.ifa.hawaii.edu', '/current/index.cgi', hdrs, 'http');
    next.push(...parseMkwcTable(mkwcHtml));
  } catch (e) { summitLastError = `mkwc: ${e.message}`; }

  try {
    const yr = new Date().getUTCFullYear();
    const metText = await fetchText('gml.noaa.gov',
      `/aftp/data/meteorology/in-situ/mlo/met_mlo_insitu_1_obop_hour_${yr}.txt`, hdrs);
    let co2 = {};
    try {
      const co2Text = await fetchText('gml.noaa.gov', '/webdata/ccgg/trends/co2/co2_daily_mlo.txt', hdrs);
      co2 = parseNoaaDailyCo2(co2Text);
    } catch {
      const wk = await fetchText('gml.noaa.gov', '/webdata/ccgg/trends/co2/co2_weekly_mlo.txt', hdrs);
      co2 = parseNoaaWeeklyCo2(wk);
    }
    next.push({
      ...MLO_SITE,
      source: 'NOAA Global Monitoring Laboratory',
      readings: { ...parseMloMetHourly(metText), ...co2 },
    });
  } catch (e) {
    summitLastError = (summitLastError ? summitLastError + '; ' : '') + `mlo: ${e.message}`;
    if (!next.some(s => s.id === 'mlo')) {
      next.push({ ...MLO_SITE, source: 'NOAA GML', readings: {}, offline: true });
    }
  }

  if (next.length) { summitCache = next; summitLastPollTs = Date.now(); if (next.some(s => (s.readings && Object.keys(s.readings).length) || !s.offline)) summitLastError = null; }
}

// ─── OCEAN: NDBC wave/weather buoys + NOAA tide stations (keyless) ────────────
// Real marine conditions around the Big Island. NDBC buoys emit a fixed-width
// realtime2 text file (latest row = now); NOAA CO-OPS gives live water level.
const NDBC_BUOYS = [
  { id: '51000', name: 'NDBC 51000 — N of Hawaii', lat: 23.53, lon: -153.79 },
  { id: '51001', name: 'NDBC 51001 — NW Hawaii', lat: 23.44, lon: -162.06 },
  { id: '51002', name: 'NDBC 51002 — S of Hawaii', lat: 17.09, lon: -157.81 },
  { id: '51004', name: 'NDBC 51004 — SE of Hawaii', lat: 17.52, lon: -152.24 },
  { id: '51206', name: 'NDBC 51206 — Hilo (Waverider)', lat: 19.78, lon: -154.97 },
  { id: '51207', name: 'NDBC 51207 — Kaneohe', lat: 21.48, lon: -157.75 },
];
const TIDE_STATIONS = [
  { id: '1617760', name: 'Hilo Bay tide', lat: 19.7303, lon: -155.0556 },
  { id: '1617433', name: 'Kawaihae tide', lat: 20.0366, lon: -155.8294 },
  { id: '1612480', name: 'Kailua-Kona tide', lat: 19.6392, lon: -155.9969 },
];
let oceanCache = [];
let oceanLastPollTs = null, oceanLastError = null;
function parseNdbc(text) {
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  if (!lines.length) return null;
  const c = lines[0].trim().split(/\s+/);
  // cols: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
  const num = v => (v && v !== 'MM' ? parseFloat(v) : null);
  return {
    windDir: num(c[5]), windMs: num(c[6]), gustMs: num(c[7]),
    waveHtM: num(c[8]), domPeriodS: num(c[9]), waveDir: num(c[11]),
    pressureHpa: num(c[12]), airTempC: num(c[13]), waterTempC: num(c[14]),
  };
}
async function pollOcean() {
  const next = [];
  await Promise.all(NDBC_BUOYS.map(async b => {
    try {
      const t = await fetchText('www.ndbc.noaa.gov', `/data/realtime2/${b.id}.txt`, { 'User-Agent': 'heleon-tracker' });
      const r = parseNdbc(t);
      if (r) next.push({ kind: 'buoy', id: b.id, name: b.name, lat: b.lat, lon: b.lon, readings: r });
    } catch (e) { /* skip this buoy */ }
  }));
  await Promise.all(TIDE_STATIONS.map(async s => {
    try {
      const j = await fetchJson('api.tidesandcurrents.noaa.gov',
        `/api/prod/datagetter?date=latest&station=${s.id}&product=water_level&datum=MLLW&units=english&time_zone=lst_ldt&format=json`,
        { 'User-Agent': 'heleon-tracker' });
      const d = j.data && j.data[0];
      const readings = { waterLevelFt: parseFloat(d && d.v), at: d && d.t };
      // Next high/low tide predictions round out the tide card.
      try {
        const pj = await fetchJson('api.tidesandcurrents.noaa.gov',
          `/api/prod/datagetter?date=today&station=${s.id}&product=predictions&datum=MLLW&units=english&time_zone=lst_ldt&interval=hilo&format=json`,
          { 'User-Agent': 'heleon-tracker' });
        if (pj.predictions) readings.tides = pj.predictions.map(t => ({ t: t.t, ft: parseFloat(t.v), type: t.type }));
      } catch { /* predictions are a bonus */ }
      if (d) next.push({ kind: 'tide', id: s.id, name: s.name, lat: s.lat, lon: s.lon, readings });
    } catch (e) { /* skip */ }
  }));
  // DART tsunami buoy 51407 — deep-ocean pressure sensor 34 NM west of Kona.
  // The .dart file's HEIGHT column is water-column height in meters; a sudden
  // deviation is how the Pacific Tsunami Warning Center sees a tsunami coming.
  try {
    const t = await fetchText('www.ndbc.noaa.gov', '/data/realtime2/51407.dart', { 'User-Agent': 'heleon-tracker' });
    const rows = t.split('\n').filter(l => l && !l.startsWith('#'));
    if (rows.length) {
      const c = rows[0].trim().split(/\s+/); // YY MM DD hh mm ss T HEIGHT
      const heightM = parseFloat(c[7]);
      if (Number.isFinite(heightM)) {
        next.push({ kind: 'dart', id: '51407', name: 'DART 51407 tsunami buoy — 34 NM W of Kona',
          lat: 19.53, lon: -156.601,
          readings: { waterColumnM: heightM, at: `${c[0]}-${c[1]}-${c[2]} ${c[3]}:${c[4]} UTC` } });
      }
    }
  } catch (e) { /* skip */ }
  if (next.length) { oceanCache = next; oceanLastPollTs = Date.now(); oceanLastError = null; }
  else oceanLastError = 'no ocean stations reporting';
}

// ─── MARINE: reef webcams, Aqualink sensors, NOAA fishing landings ───────────
// Aqualink publishes all site metadata (incl. YouTube/Luma reef cams) at
// /api/sites — no key. FOSS landings API is keyless but needs paging to filter
// Hawaiʻi rows; many species are "WITHHELD" at fine granularity.
const MARINE_BI = { minLat: 18.5, maxLat: 20.6, minLon: -156.5, maxLon: -154.4 };
let marineCache = { webcams: [], reefSensors: [] };
let marineFishingCache = { top: [], source: '', links: [], note: '' };
let marineLastPollTs = null, marineLastError = null;

function cleanYoutubeEmbed(url) {
  if (!url) return null;
  const m = String(url).match(/embed\/([^?&]+)/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : url.split('?')[0];
}

async function pollMarine() {
  const webcams = [];
  const reefSensors = [];
  try {
    const sites = await fetchJson('ocean-systems.uc.r.appspot.com', '/api/sites', { 'User-Agent': 'heleon-tracker' });
    for (const s of (Array.isArray(sites) ? sites : [])) {
      const coords = s.polygon && s.polygon.coordinates;
      if (!coords) continue;
      const lon = coords[0], lat = coords[1];
      const b = MARINE_BI;
      if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
      const pageUrl = `https://aqualink.org/sites/${s.id}`;
      if (s.videoStream) {
        const embedUrl = cleanYoutubeEmbed(s.videoStream);
        webcams.push({
          id: `aq-v-${s.id}`, name: s.name, lat, lon,
          kind: 'reef-cam', embedType: 'youtube', embedUrl,
          source: 'MEGA Lab / Aqualink', pageUrl,
        });
      }
      if (s.iframe) {
        webcams.push({
          id: `aq-i-${s.id}`, name: s.name, lat, lon,
          kind: 'reef-cam', embedType: 'iframe', embedUrl: s.iframe,
          source: 'Aqualink', pageUrl,
        });
      }
      if (s.sensorId) {
        reefSensors.push({
          id: `aq-s-${s.id}`, name: s.name, lat, lon,
          sensorId: s.sensorId, depth: s.depth,
          source: 'Aqualink / Sofar Spotter', pageUrl,
        });
      }
    }
    marineCache = { webcams, reefSensors };
    marineLastPollTs = Date.now();
    marineLastError = null;
  } catch (e) { marineLastError = e.message; }
}

// ─── TIDE PREDICTIONS — NOAA CO-OPS forward-looking (keyless) ─────────────────
// High/low tide forecasts for the Big Island gauges (Hilo 1617760, Kawaihae
// 1617433). Keyless, updated daily. Drives a small "next high tide" badge on
// the ocean stations — useful for fishing, harbor, paddling, safety.
const TIDE_PRED_STATIONS = [
  { id: '1617760', name: 'Hilo',     lat: 19.7303, lon: -155.0569 },
  { id: '1617433', name: 'Kawaihae', lat: 20.0367, lon: -155.8297 },
];
let tidePredCache = { stations: [] };
let tidePredLastPollTs = null, tidePredLastError = null;
async function pollTidePredictions() {
  try {
    const stations = [];
    for (const ts of TIDE_PRED_STATIONS) {
      try {
        const j = await fetchJson('api.tidesandcurrents.noaa.gov',
          `/api/prod/datagetter?station=${ts.id}&product=predictions&datum=MLLW&interval=hilo&units=english&time_zone=gmt&format=json&range=48`,
          { 'User-Agent': 'heleon-tracker' });
        const preds = j.predictions || [];
        // Find the next high tide from "now" (server time).
        const nowIso = new Date().toISOString();
        const upcoming = preds.filter(p => p.t && p.t.replace(' ', 'T') + 'Z' >= nowIso).slice(0, 6);
        stations.push({
          id: ts.id, name: ts.name, lat: ts.lat, lon: ts.lon,
          next: upcoming[0] || null,
          upcoming: upcoming,
        });
      } catch (e) { /* skip this station */ }
    }
    if (stations.length) { tidePredCache = { stations }; tidePredLastPollTs = Date.now(); tidePredLastError = null; }
    else tidePredLastError = 'no predictions';
  } catch (e) { tidePredLastError = (e && e.message) || 'unknown error'; }
}

async function pollFishingSummary() {
  try {
    const agg = new Map();
    let offset = 0;
    for (let page = 0; page < 40; page++) {
      const j = await fetchJson('apps-st.fisheries.noaa.gov',
        `/ods/foss/landings/?offset=${offset}&limit=1000`,
        { 'User-Agent': 'heleon-tracker' });
      const items = j.items || [];
      if (!items.length) break;
      for (const row of items) {
        if (row.state_name !== 'HAWAII' || row.year < 2018) continue;
        if (!row.ts_afs_name || /WITHHELD/i.test(row.ts_afs_name)) continue;
        const key = `${row.year}|${row.ts_afs_name}`;
        agg.set(key, (agg.get(key) || 0) + (row.pounds || 0));
      }
      offset += items.length;
      if (items.length < 1000) break;
    }
    const top = [...agg.entries()]
      .map(([k, pounds]) => {
        const [year, species] = k.split('|');
        return { year: +year, species, pounds: Math.round(pounds) };
      })
      .sort((a, b) => b.pounds - a.pounds)
      .filter(r => r.pounds > 0)
      .slice(0, 30);
    marineFishingCache = {
      top,
      source: 'NOAA FOSS commercial landings (statewide summaries)',
      links: [
        { label: 'WPacFIN Hawaiʻi queries', url: 'https://apps-pifsc.fisheries.noaa.gov/wpacfin/' },
        { label: 'FOSS landings API', url: 'https://apps-st.fisheries.noaa.gov/ods/foss/landings/' },
        { label: 'DLNR fishing rules', url: 'https://dlnr.hawaii.gov/dar/fishing/' },
      ],
      note: 'Commercial catch totals by species/year — not live boat positions. Fine-grained catch is often withheld as confidential.',
    };
  } catch (e) {
    marineFishingCache = { top: [], error: e.message, source: 'NOAA FOSS', links: [], note: '' };
  }
}

// ─── INFRASTRUCTURE: power grid, cell towers, internet facilities ───────────
// Hawaiian Electric does not publish a keyless real-time Hawaiʻi Island MW /
// fuel-mix API (islandpulse.org is defunct). We surface curated plant locations,
// OpenStreetMap transmission assets, PeeringDB colo/IX metadata, and OSM-mapped
// cell towers — all static/reference, refreshed daily from public sources.
const INFRA_BI = { minLat: 18.5, maxLat: 20.6, minLon: -156.5, maxLon: -154.4 };
const INFRA_CACHE_PATH = path.join(__dirname, 'data', 'infrastructure-cache.json');
const CURATED_POWER_PLANTS = [
  { id: 'pgv', name: 'Puna Geothermal Venture', fuel: 'geothermal', capacityMw: 38, lat: 19.470, lon: -155.117, operator: 'PGV / HECO', island: 'Hawaiʻi', note: 'Largest geothermal plant in the state' },
  { id: 'hamakua', name: 'Hamakua Energy', fuel: 'oil', capacityMw: 60, lat: 20.054, lon: -155.552, operator: 'Hamakua Energy Partners', island: 'Hawaiʻi', note: 'Oil-fired peaker near Honokaʻa' },
  { id: 'keahole', name: 'Keahole Power Plant', fuel: 'oil', capacityMw: 77, lat: 19.728, lon: -156.058, operator: 'HECO', island: 'Hawaiʻi', note: 'North Kona combustion turbines' },
  { id: 'hill6', name: 'Hill 6 Generating Station', fuel: 'oil', capacityMw: 63, lat: 19.718, lon: -155.089, operator: 'HECO', island: 'Hawaiʻi', note: 'Hilo-area baseload / peaker' },
  { id: 'waimea', name: 'Waimea Generating Station', fuel: 'oil', capacityMw: 6, lat: 20.023, lon: -155.669, operator: 'HECO', island: 'Hawaiʻi', note: 'North Hawaiʻi diesel' },
  { id: 'pakinigui', name: 'Pakini Nui Wind Farm', fuel: 'wind', capacityMw: 21, lat: 18.941, lon: -155.682, operator: 'Tawhiri Power', island: 'Hawaiʻi', note: 'South Point area' },
  { id: 'hawiwind', name: 'Hawi Wind Farm', fuel: 'wind', capacityMw: 10.6, lat: 20.228, lon: -155.832, operator: 'Tawhiri Power', island: 'Hawaiʻi', note: 'North Kohala' },
  { id: 'aes-waikoloa', name: 'AES Waikoloa Solar', fuel: 'solar', capacityMw: 30, lat: 19.945, lon: -155.865, operator: 'AES', island: 'Hawaiʻi', note: 'Utility-scale solar + storage' },
  { id: 'hakalau-hydro', name: 'Hakalau Hydro', fuel: 'hydro', capacityMw: 2.4, lat: 19.865, lon: -155.125, operator: 'HECO', island: 'Hawaiʻi', note: 'Run-of-river hydro' },
];
const HAWAII_ISLAND_GRID_MIX = {
  year: 2024,
  island: 'Hawaiʻi Island',
  renewablePct: 57.3,
  sources: [
    { fuel: 'geothermal', pct: 14.8 },
    { fuel: 'oil', pct: 42.7 },
    { fuel: 'wind', pct: 14.2 },
    { fuel: 'solar', pct: 15.8 },
    { fuel: 'hydro', pct: 12.5 },
  ],
  note: 'Annual average shares from HECO RPS reporting — not live grid load. No public real-time Hawaiʻi Island MW-by-fuel feed exists.',
  links: [
    { label: 'HECO clean energy portfolio', url: 'https://www.hawaiianelectric.com/clean-energy-portfolio' },
    { label: 'Hawaii Powered (grid plan)', url: 'https://www.hawaiipowered.com/' },
    { label: 'FCC mobile coverage maps', url: 'https://www.fcc.gov/BroadbandData/MobileMaps' },
  ],
};
let infraCache = {
  powerPlants: [...CURATED_POWER_PLANTS],
  substations: [],
  powerLines: { type: 'FeatureCollection', features: [] },
  railways: { type: 'FeatureCollection', features: [] },
  cellTowers: [],
  netFacilities: [],
  internetExchanges: [],
  gridMix: HAWAII_ISLAND_GRID_MIX,
  notes: {
    power: 'Plant locations and transmission lines from HECO public reports + OpenStreetMap. Live MW output is not published.',
    cell: 'OpenStreetMap communication towers — incomplete vs the full FCC ASR database (~130k US structures). No live coverage/load API.',
    net: 'PeeringDB colocation + internet exchange metadata — facility locations, not live backbone traffic.',
  },
};
let infraLastPollTs = null, infraLastError = null, infraPollInFlight = false;

function fetchOverpass(query, attempt = 1) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;
    const req = https.request({
      hostname: 'overpass-api.de', path: '/api/interpreter', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'heleon-tracker',
      },
      timeout: 50000,
    }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(`Overpass HTTP ${res.statusCode}`);
          if (attempt < 2 && (res.statusCode === 429 || res.statusCode === 504)) {
            setTimeout(() => fetchOverpass(query, attempt + 1).then(resolve).catch(reject), 3000);
            return;
          }
          return reject(err);
        }
        try { resolve(JSON.parse(b)); } catch { reject(new Error('Overpass bad JSON')); }
      });
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Overpass timeout')); });
    req.write(body);
    req.end();
  });
}

const overpassPause = () => new Promise(r => setTimeout(r, 2500));

function osmCenter(el) {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function inInfraBi(lat, lon) {
  const b = INFRA_BI;
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

function normalizeFuel(tags) {
  const raw = tags['generator:source'] || tags['plant:source'] || tags['plant:method'] || '';
  const s = String(raw).toLowerCase();
  if (s.includes('geotherm')) return 'geothermal';
  if (s.includes('wind')) return 'wind';
  if (s.includes('solar') || s.includes('photovoltaic')) return 'solar';
  if (s.includes('hydro') || s.includes('water')) return 'hydro';
  if (s.includes('oil') || s.includes('diesel')) return 'oil';
  if (s.includes('gas')) return 'gas';
  return s || 'unknown';
}

function clusterOsmGenerators(elements) {
  const buckets = new Map();
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.power !== 'generator' && tags.power !== 'plant') continue;
    const c = osmCenter(el);
    if (!c || !inInfraBi(c.lat, c.lon)) continue;
    const fuel = normalizeFuel(tags);
    const name = tags.name || '';
    const cell = (fuel === 'wind' && !name)
      ? `${Math.round(c.lat * 40) / 40}|${Math.round(c.lon * 40) / 40}|${fuel}`
      : `id|${el.type}|${el.id}`;
    const prev = buckets.get(cell);
    if (prev) { prev.count++; if (name && !prev.name) prev.name = name; }
    else buckets.set(cell, {
      id: `osm-${el.type}-${el.id}`, name: name || null, fuel, lat: c.lat, lon: c.lon,
      count: 1, source: 'OpenStreetMap', operator: tags.operator || '', voltage: tags.voltage || '',
    });
  }
  return [...buckets.values()].map(b => ({
    id: b.id,
    name: b.name || (b.count > 3 ? `${b.fuel} cluster (${b.count} units)` : `${b.fuel} generator`),
    fuel: b.fuel, capacityMw: null, lat: b.lat, lon: b.lon,
    operator: b.operator, island: 'Hawaiʻi', source: b.source, unitCount: b.count, note: b.voltage ? `${b.voltage} V` : '',
  }));
}

function osmPowerLinesGeojson(elements) {
  const features = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const tags = el.tags || {};
    const coords = el.geometry.map(p => [p.lon, p.lat]);
    if (coords.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        voltage: tags.voltage || '',
        cables: tags.cables || '',
        operator: tags.operator || '',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// Railways (heritage/tourist track + stations) → line features + station points.
function osmRailwaysGeojson(elements) {
  const features = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const coords = el.geometry.map(p => [p.lon, p.lat]);
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
        properties: {
          kind: 'track', railway: tags.railway || 'rail',
          name: tags.name || '', gauge: tags.gauge || '',
          heritage: (tags.railway === 'preserved' || tags.usage === 'tourism' || !!tags.tourism) ? 1 : 0,
        },
      });
    } else if (el.type === 'node' && el.lat != null && el.lon != null && tags.railway === 'station') {
      features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
        properties: { kind: 'station', name: tags.name || 'Station' },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function loadInfraCacheFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(INFRA_CACHE_PATH, 'utf8'));
    if (j.powerPlants) infraCache = { ...infraCache, ...j };
    infraLastPollTs = j.lastPollTs || infraLastPollTs;
  } catch { /* no cache yet */ }
}
function saveInfraCacheToDisk() {
  try {
    fs.writeFileSync(INFRA_CACHE_PATH, JSON.stringify({ lastPollTs: infraLastPollTs, ...infraCache }));
  } catch { /* non-fatal */ }
}
loadInfraCacheFromDisk();

async function pollPeeringDbInfra() {
  const netFacilities = [];
  const internetExchanges = [];
  try {
    const facJ = await fetchJson('www.peeringdb.com', '/api/fac?state=HI&limit=50', { 'User-Agent': 'heleon-tracker' });
    for (const f of (facJ.data || [])) {
      if (f.latitude == null || f.longitude == null) continue;
      netFacilities.push({
        id: `pdb-fac-${f.id}`, name: f.name, org: f.org_name || '', city: f.city || '',
        state: f.state || 'HI', lat: f.latitude, lon: f.longitude,
        netCount: f.net_count, ixCount: f.ix_count, website: f.website || '',
        address: [f.address1, f.city, f.state, f.zipcode].filter(Boolean).join(', '),
        source: 'PeeringDB', kind: 'datacenter',
      });
    }
    const ixJ = await fetchJson('www.peeringdb.com', '/api/ix?country=US&limit=200', { 'User-Agent': 'heleon-tracker' });
    for (const ix of (ixJ.data || [])) {
      const city = (ix.city || '').toLowerCase();
      if (!city.includes('honolulu') && !city.includes('hilo') && !city.includes('kapolei')) continue;
      internetExchanges.push({
        id: `pdb-ix-${ix.id}`, name: ix.name, city: ix.city, website: ix.website || '',
        netCount: ix.net_count, facCount: ix.fac_count, media: ix.media || '',
        protoIpv6: ix.proto_ipv6, source: 'PeeringDB', kind: 'ix',
        note: 'Internet exchange — peering point for networks, not live traffic stats',
      });
    }
  } catch (e) { throw new Error(`PeeringDB: ${e.message}`); }
  return { netFacilities, internetExchanges };
}

async function pollInfrastructure() {
  if (infraPollInFlight) return;
  infraPollInFlight = true;
  try {
    const bbox = `${INFRA_BI.minLat},${INFRA_BI.minLon},${INFRA_BI.maxLat},${INFRA_BI.maxLon}`;
    let powerJ = { elements: [] }, towerJ = { elements: [] }, lineJ = { elements: [] };
    try {
      powerJ = await fetchOverpass(`[out:json][timeout:40];
(
  node["power"~"^(plant|generator|substation)$"](${bbox});
  way["power"~"^(plant|generator|substation)$"](${bbox});
);
out center tags 120;`);
    } catch (e) { console.warn('[infra] power OSM:', e.message); }
    await overpassPause();
    try {
      towerJ = await fetchOverpass(`[out:json][timeout:40];
(
  node["man_made"="tower"]["tower:type"="communication"](${bbox});
  node["man_made"="mast"](${bbox});
  node["man_made"="communications_tower"](${bbox});
);
out body 200;`);
    } catch (e) { console.warn('[infra] tower OSM:', e.message); }
    await overpassPause();
    try {
      lineJ = await fetchOverpass(`[out:json][timeout:40];
way["power"="line"]["voltage"](${bbox});
out geom 80;`);
    } catch (e) { console.warn('[infra] lines OSM:', e.message); }
    await overpassPause();
    let railJ = { elements: [] };
    try {
      // Big Island rail is heritage/tourist (Laupāhoehoe, Pana'ewa Zoo train,
      // old sugar lines) + any preserved track. Grab the lines + stations.
      railJ = await fetchOverpass(`[out:json][timeout:40];
(
  way["railway"~"^(rail|narrow_gauge|light_rail|preserved|miniature|tram)$"](${bbox});
  node["railway"="station"](${bbox});
);
out geom 120;`);
    } catch (e) { console.warn('[infra] rail OSM:', e.message); }
    let peering = { netFacilities: [], internetExchanges: [] };
    try { peering = await pollPeeringDbInfra(); } catch (e) { console.warn('[infra] PeeringDB:', e.message); }

    const osmPlants = clusterOsmGenerators(powerJ.elements || []);
    const extraPlants = osmPlants.filter(p => {
      return !CURATED_POWER_PLANTS.some(c => Math.hypot(c.lat - p.lat, c.lon - p.lon) < 0.015);
    });

    const substations = [];
    for (const el of (powerJ.elements || [])) {
      const tags = el.tags || {};
      if (tags.power !== 'substation') continue;
      const c = osmCenter(el);
      if (!c || !inInfraBi(c.lat, c.lon)) continue;
      substations.push({
        id: `osm-sub-${el.type}-${el.id}`, name: tags.name || 'Substation',
        lat: c.lat, lon: c.lon, voltage: tags.voltage || '', operator: tags.operator || '',
      });
    }

    const cellTowers = [];
    for (const el of (towerJ.elements || [])) {
      if (el.lat == null || el.lon == null) continue;
      if (!inInfraBi(el.lat, el.lon)) continue;
      const tags = el.tags || {};
      cellTowers.push({
        id: `osm-tower-${el.id}`, lat: el.lat, lon: el.lon,
        heightM: tags.height || tags['tower:type'] || '', operator: tags.operator || '',
        name: tags.name || '', source: 'OpenStreetMap',
      });
    }

    infraCache = {
      powerPlants: [...CURATED_POWER_PLANTS, ...extraPlants],
      substations,
      powerLines: osmPowerLinesGeojson(lineJ.elements || []),
      railways: osmRailwaysGeojson(railJ.elements || []),
      cellTowers,
      netFacilities: peering.netFacilities,
      internetExchanges: peering.internetExchanges,
      gridMix: HAWAII_ISLAND_GRID_MIX,
      notes: infraCache.notes,
    };
    infraLastPollTs = Date.now();
    infraLastError = null;
    saveInfraCacheToDisk();
    console.log(`[infra] power plants ${infraCache.powerPlants.length}, subs ${substations.length}, lines ${infraCache.powerLines.features.length}, towers ${cellTowers.length}, net fac ${peering.netFacilities.length}`);
  } catch (e) {
    infraLastError = e.message;
    console.error('[infra] poll failed:', e.message);
  } finally {
    infraPollInFlight = false;
  }
}

// ─── LOCAL DATA: gas prices, traffic counts, remote telescopes, sightings ─────
// Keyless / open sources for “what’s around town” on Hawaiʻi Island. Per-station
// live pump prices aren’t published free (GasBuddy needs private GraphQL); we use
// AAA monthly regional averages from Hawaii Open Data + OSM station locations.
// HDOT AADT road segments from state GIS; East Hawaiʻi Bluetooth travel-time
// sensors link to Blyncsy Pulse (no public API). LCO global telescope schedule is
// fully open. iNaturalist provides community species sightings.
const LOCAL_BI = { minLat: 18.5, maxLat: 20.6, minLon: -156.5, maxLon: -154.4 };
const LOCAL_CACHE_PATH = path.join(__dirname, 'data', 'local-cache.json');
const BLYNCSY_SENSORS = [
  { id: 'bly-hilo-1', name: 'Kamehameha Ave / Pauahi (Hilo)', lat: 19.725, lon: -155.087 },
  { id: 'bly-hilo-2', name: 'Kanoelehua / Puainako', lat: 19.699, lon: -155.064 },
  { id: 'bly-hilo-3', name: 'Kanoelehua / Makaala', lat: 19.688, lon: -155.051 },
  { id: 'bly-hilo-4', name: 'Hwy 11 / Keaau-Pahoa Rd', lat: 19.623, lon: -155.041 },
  { id: 'bly-hilo-5', name: 'Hwy 11 / Railroad Ave', lat: 19.602, lon: -155.005 },
  { id: 'bly-hilo-6', name: 'Keaau / Hwy 11', lat: 19.578, lon: -155.041 },
];
const LCO_SITES = {
  ogg: { name: 'LCO Haleakalā (Maui)', lat: 20.706, lon: -156.257 },
  lsc: { name: 'LCO Cerro Tololo (Chile)', lat: -30.470, lon: -70.815 },
  coj: { name: 'LCO Siding Spring (Australia)', lat: -31.273, lon: 149.062 },
  elp: { name: 'LCO McDonald (Texas)', lat: 30.680, lon: -104.015 },
  tfn: { name: 'LCO Teide (Canary Islands)', lat: 28.300, lon: -16.511 },
  sqa: { name: 'LCO Sutherland (South Africa)', lat: -32.376, lon: 20.811 },
  bpl: { name: 'LCO Siding Spring (backup)', lat: -31.273, lon: 149.062 },
};
let localCache = {
  fuelPrices: { regions: [], note: '', source: 'AAA via Hawaii Open Data' },
  fuelStations: [],
  trafficRoads: { type: 'FeatureCollection', features: [] },
  trafficSensors: BLYNCSY_SENSORS.map(s => ({
    ...s, source: 'HDOT / Blyncsy', dashboardUrl: 'https://pulse.blyncsy.com/commuter_dashboard/hidot',
    note: 'Bluetooth travel-time corridor sensor — live delays on Blyncsy Pulse dashboard (no public API).',
  })),
  lcoSchedule: [],
  iNaturalist: [],
  notes: {
    fuel: 'AAA monthly regional averages — not live pump prices. OSM marks station locations only.',
    traffic: 'AADT = annual average daily traffic from HDOT HPMS (static). Blyncsy sensors are East Hawaiʻi only.',
    lco: 'Las Cumbres Observatory global network — live schedule, not Big Island telescopes (except Maui site).',
    inat: 'Community nature observations from iNaturalist — not official wildlife surveys.',
  },
};
let localLastPollTs = null, localLastError = null, localPollInFlight = false;

function fetchUrlText(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 35000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.hostname}${res.headers.location}`;
        return fetchUrlText(next, headers, redirects + 1).then(resolve).catch(reject);
      }
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchCkanResourceUrl(packageId, format) {
  const j = await fetchJson('opendata.hawaii.gov', `/api/3/action/package_show?id=${packageId}`,
    { 'User-Agent': 'heleon-tracker' });
  const r = (j.result.resources || []).find(x => x.format === format);
  if (!r || !r.url) throw new Error(`no ${format} resource for ${packageId}`);
  return r.url;
}

function parseAaaFuelCsv(text) {
  const lines = text.trim().split('\n').filter(l => l && !l.startsWith('Date'));
  const rows = lines.map(l => {
    const p = l.split(',');
    return { date: p[0].trim(), region: p[1].trim(), fuel: p[2].trim(), price: parseFloat(p[3]), unit: (p[4] || '').trim() };
  }).filter(r => r.price > 0);
  const latestDate = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const latest = rows.filter(r => r.date === latestDate);
  const byRegion = {};
  for (const r of latest) {
    if (!byRegion[r.region]) byRegion[r.region] = [];
    byRegion[r.region].push({ fuel: r.fuel, price: r.price, unit: r.unit, date: r.date });
  }
  return { asOf: latestDate, byRegion, rows: latest };
}

function loadLocalCacheFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL_CACHE_PATH, 'utf8'));
    localCache = { ...localCache, ...j };
    localLastPollTs = j.lastPollTs || localLastPollTs;
  } catch { /* no cache */ }
}
function saveLocalCacheToDisk() {
  try {
    fs.writeFileSync(LOCAL_CACHE_PATH, JSON.stringify({ lastPollTs: localLastPollTs, ...localCache }));
  } catch { /* non-fatal */ }
}
loadLocalCacheFromDisk();

async function pollLocalFuel() {
  const url = await fetchCkanResourceUrl('aaa-fuel-prices', 'CSV');
  const csv = await fetchUrlText(url, { 'User-Agent': 'heleon-tracker' });
  const parsed = parseAaaFuelCsv(csv);
  const regions = Object.entries(parsed.byRegion).map(([region, fuels]) => ({ region, fuels }));
  localCache.fuelPrices = {
    asOf: parsed.asOf,
    regions,
    hilo: parsed.byRegion.Hilo || [],
    source: 'AAA monthly averages (Hawaii Open Data)',
    note: 'Statewide/regional monthly averages — not live per-pump prices. GasBuddy has station prices but no keyless public API.',
    links: [
      { label: 'Hawaii Open Data — AAA fuel', url: 'https://opendata.hawaii.gov/dataset/aaa-fuel-prices' },
      { label: 'DBEDT Energy Trends', url: 'https://dbedt.hawaii.gov/economic/qser/energy/' },
    ],
  };
}

async function pollLocalFuelStations() {
  const bbox = `${LOCAL_BI.minLat},${LOCAL_BI.minLon},${LOCAL_BI.maxLat},${LOCAL_BI.maxLon}`;
  const j = await fetchOverpass(`[out:json][timeout:35];
(
  node["amenity"="fuel"](${bbox});
  way["amenity"="fuel"](${bbox});
);
out center tags 80;`);
  const stations = [];
  for (const el of (j.elements || [])) {
    const c = osmCenter(el);
    if (!c) continue;
    const tags = el.tags || {};
    stations.push({
      id: `fuel-${el.type}-${el.id}`, name: tags.name || tags.brand || 'Gas station',
      brand: tags.brand || '', operator: tags.operator || '',
      lat: c.lat, lon: c.lon, source: 'OpenStreetMap',
    });
  }
  localCache.fuelStations = stations;
}

async function pollLocalTrafficRoads() {
  const j = await fetchJson('geodata.hawaii.gov',
    '/arcgis/rest/services/Transportation/MapServer/12/query?where=island%3D%27Hawaii%27'
    + '&outFields=route_id,route_name,aadt,f_system_t,island'
    + '&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=800',
    { 'User-Agent': 'heleon-tracker' });
  const features = (j.features || []).filter(f => (f.properties.aadt || 0) > 0);
  localCache.trafficRoads = { type: 'FeatureCollection', features };
  localCache.trafficMeta = {
    source: 'HDOT HPMS (state GIS)',
    note: 'Annual Average Daily Traffic — static counts, not live congestion. For live East Hawaiʻi delays see Blyncsy Pulse.',
    link: 'https://geodata.hawaii.gov/arcgis/rest/services/Transportation/MapServer/12',
  };
}

async function pollLocalLco() {
  const now = new Date();
  const start = now.toISOString().slice(0, 19);
  const end = new Date(now.getTime() + 48 * 3600 * 1000).toISOString().slice(0, 19);
  const j = await fetchJson('observe.lco.global',
    `/api/schedule/?start_after=${encodeURIComponent(start)}&end_before=${encodeURIComponent(end)}&limit=40`,
    { 'User-Agent': 'heleon-tracker' });
  const items = [];
  for (const row of (j.results || [])) {
    const site = LCO_SITES[row.site] || { name: `LCO site ${row.site}`, lat: null, lon: null };
    items.push({
      id: `lco-${row.id}`, site: row.site, siteName: site.name,
      lat: site.lat, lon: site.lon, telescope: row.telescope, enclosure: row.enclosure,
      start: row.start, end: row.end, name: row.name, proposal: row.proposal, state: row.state,
      source: 'Las Cumbres Observatory', portalUrl: 'https://observe.lco.global/',
      scheduleUrl: 'https://schedule.lco.global/',
    });
  }
  localCache.lcoSchedule = items;
}

async function pollLocalINat() {
  const b = LOCAL_BI;
  const j = await fetchJson('api.inaturalist.org',
    `/v1/observations?nelat=${b.maxLat}&nelng=${b.maxLon}&swlat=${b.minLat}&swlng=${b.minLon}`
    + '&per_page=40&order=desc&order_by=observed_at&photos=true&quality_grade=research,needs_id',
    { 'User-Agent': 'heleon-tracker' });
  localCache.iNaturalist = (j.results || []).map(o => {
    const tax = o.taxon || {};
    const geo = o.geojson && o.geojson.coordinates;
    return {
      id: `inat-${o.id}`, name: tax.preferred_common_name || tax.name || 'Unknown species',
      species: tax.name || '', iconic: tax.iconic_taxon_name || '',
      observedAt: o.observed_on || o.time_observed_at,
      lat: geo ? geo[1] : null, lon: geo ? geo[0] : null,
      photoUrl: o.photos && o.photos[0] && (o.photos[0].url || '').replace('square', 'medium'),
      user: o.user && o.user.login, source: 'iNaturalist',
      pageUrl: `https://www.inaturalist.org/observations/${o.id}`,
    };
  }).filter(r => r.lat != null);
}

async function pollLocal() {
  if (localPollInFlight) return;
  localPollInFlight = true;
  const errs = [];
  try { await pollLocalFuel(); } catch (e) { errs.push(`fuel: ${e.message}`); }
  try { await pollLocalFuelStations(); } catch (e) { errs.push(`stations: ${e.message}`); }
  try { await pollLocalTrafficRoads(); } catch (e) { errs.push(`traffic: ${e.message}`); }
  try { await pollLocalLco(); } catch (e) { errs.push(`lco: ${e.message}`); }
  try { await pollLocalINat(); } catch (e) { errs.push(`inat: ${e.message}`); }
  localLastPollTs = Date.now();
  localLastError = errs.length ? errs.join('; ') : null;
  saveLocalCacheToDisk();
  console.log(`[local] fuel regions ${localCache.fuelPrices.regions.length}, stations ${localCache.fuelStations.length}, roads ${localCache.trafficRoads.features.length}, lco ${localCache.lcoSchedule.length}, inat ${localCache.iNaturalist.length}`);
  localPollInFlight = false;
}

// ─── APRS-IS (ham radio real-time positions: stations, vehicles, wx) ──────────
// Keyless read-only feed from the APRS-Internet System. We connect with an area
// filter around the Big Island and parse position packets — this surfaces real
// moving things hams beacon: vehicles/trackers, handhelds, weather stations,
// digipeaters. RX-only login needs no passcode (pass -1). Runs on the server so
// it works in production even where this dev sandbox blocks the TCP port.
const net = require('net');
const APRS_ENABLED = process.env.APRS_DISABLE ? false : true;
let aprsCache = new Map();  // callsign -> { call, lat, lon, symbol, comment, kind, ts }
let aprsSock = null, aprsLastError = null, aprsLastRxTs = null;

// Decode a standard uncompressed APRS lat/lon like "1947.50N/15528.30Wk".
function aprsParseUncompressed(s) {
  const m = s.match(/(\d{2})(\d{2}\.\d+)([NS])[\/\\](\d{3})(\d{2}\.\d+)([EW])(.)/);
  if (!m) return null;
  let lat = (+m[1]) + (+m[2]) / 60; if (m[3] === 'S') lat = -lat;
  let lon = (+m[4]) + (+m[5]) / 60; if (m[6] === 'W') lon = -lon;
  return { lat, lon, symbol: m[7] };
}
// Compressed format: "/YYYYXXXX$csT" after the symbol-table char.
function aprsParseCompressed(body) {
  const m = body.match(/[\/\\]([\x21-\x7b]{4})([\x21-\x7b]{4})(.)/);
  if (!m) return null;
  const dec = (s) => { let v = 0; for (const ch of s) v = v * 91 + (ch.charCodeAt(0) - 33); return v; };
  const lat = 90 - dec(m[1]) / 380926;
  const lon = -180 + dec(m[2]) / 190463;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, symbol: m[3] };
}
function parseAprsPacket(line) {
  const gt = line.indexOf('>'); const colon = line.indexOf(':');
  if (gt < 0 || colon < 0) return null;
  const call = line.slice(0, gt);
  const payload = line.slice(colon + 1);
  const dti = payload[0];
  if (!'!=@/`\'.'.includes(dti)) return null; // not a position/weather packet
  // Strip a leading timestamp on @// packets.
  let body = payload.slice(1);
  const pos = aprsParseUncompressed(body) || aprsParseCompressed(body);
  if (!pos) return null;
  if (pos.lat < 18.8 || pos.lat > 22.6 || pos.lon < -160.8 || pos.lon > -154.2) return null;
  // Classify by APRS symbol code: '>' car, 'k' truck, '_' wx station, etc.
  const sym = pos.symbol;
  let kind = 'station';
  if ('>kjuvs'.includes(sym)) kind = 'vehicle';
  else if (sym === '_') kind = 'weather';
  else if (sym === 'Y' || sym === 'y') kind = 'boat';
  const comment = body.replace(/^[^\s]*\s?/, '').slice(0, 60);
  return { call, lat: pos.lat, lon: pos.lon, symbol: sym, kind, comment, ts: Date.now() };
}
function connectAprs() {
  if (!APRS_ENABLED) return;
  try {
    aprsSock = net.connect(14580, 'rotate.aprs2.net');
    aprsSock.setEncoding('utf8');
    let buf = '';
    aprsSock.on('connect', () => {
      // APRS-IS area filter. The `b/` box is NW-corner first (max lat, min lon)
      // then SE-corner (min lat, max lon) — the previous string had the
      // latitudes inverted (18.8 before 22.6), which matches an empty box, so
      // the feed silently delivered nothing. Also add a wide radius filter
      // (r/lat/lon/dist-km) as a belt-and-suspenders so we still get packets if
      // a server is fussy about box syntax.
      aprsSock.write('user HELEON-RO pass -1 vers heleon 1.0 filter b/22.60/-160.80/18.80/-154.20 r/20.0/-157.0/400\r\n');
    });
    aprsSock.on('data', d => {
      buf += d; const parts = buf.split('\n'); buf = parts.pop();
      for (const raw of parts) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const pkt = parseAprsPacket(line);
        if (pkt) { aprsCache.set(pkt.call, pkt); aprsLastRxTs = Date.now(); }
      }
    });
    aprsSock.on('error', e => { aprsLastError = e.message; });
    aprsSock.on('close', () => { setTimeout(connectAprs, 30000); }); // auto-reconnect
  } catch (e) { aprsLastError = e.message; setTimeout(connectAprs, 60000); }
}

// ─── AIR QUALITY / VOG (Open-Meteo, keyless) ──────────────────────────────────
// Vog (volcanic SO₂ + sulfate haze from Kīlauea) is a defining Big Island air
// hazard. Open-Meteo's air-quality API is fully open (no key) and returns PM2.5,
// PM10, SO₂ and US AQI per point, so we sample representative towns across the
// island to build a live AQ layer. Downwind (Kona/Ka'ū) usually reads worst.
const AQ_POINTS = [
  { name: 'Hilo', lat: 19.707, lon: -155.09 },
  { name: 'Kailua-Kona', lat: 19.64, lon: -155.996 },
  { name: 'Volcano', lat: 19.44, lon: -155.23 },
  { name: 'Pāhala', lat: 19.2, lon: -155.48 },
  { name: 'Ocean View', lat: 19.09, lon: -155.76 },
  { name: 'Waimea', lat: 20.02, lon: -155.67 },
  { name: 'Waikoloa', lat: 19.94, lon: -155.79 },
  { name: 'Pāhoa', lat: 19.49, lon: -154.95 },
  { name: 'Captain Cook', lat: 19.5, lon: -155.92 },
];
let airQualityCache = [];
let airQualityLastPollTs = null, airQualityLastError = null;
async function pollAirQuality() {
  const lats = AQ_POINTS.map(p => p.lat).join(',');
  const lons = AQ_POINTS.map(p => p.lon).join(',');
  try {
    // Open-Meteo accepts comma-separated lat/lon for a batch of points in one call.
    const j = await fetchJson('air-quality-api.open-meteo.com',
      `/v1/air-quality?latitude=${lats}&longitude=${lons}&current=pm2_5,pm10,sulphur_dioxide,us_aqi&timezone=Pacific%2FHonolulu`,
      { 'User-Agent': 'heleon-tracker' });
    const arr = Array.isArray(j) ? j : [j]; // batch returns an array; single returns object
    const next = arr.map((r, i) => ({
      name: AQ_POINTS[i] ? AQ_POINTS[i].name : `pt${i}`,
      lat: r.latitude, lon: r.longitude,
      pm25: r.current && r.current.pm2_5, pm10: r.current && r.current.pm10,
      so2: r.current && r.current.sulphur_dioxide, usAqi: r.current && r.current.us_aqi,
      at: r.current && r.current.time,
    })).filter(x => x.usAqi != null || x.pm25 != null);
    if (next.length) { airQualityCache = next; airQualityLastPollTs = Date.now(); airQualityLastError = null; }
  } catch (e) { airQualityLastError = e.message; }
}

// ─── SOLAR — live sunshine intensity across the island (Open-Meteo, keyless) ─
// Shortwave (global horizontal) irradiance in W/m² + UV index at each town — a
// real-time proxy for solar-power generation potential ("how hard is the sun
// hitting the island right now"). No utility publishes live PV MW, so this is
// the closest honest live signal. Same batched Open-Meteo call as air quality.
let solarCache = [];
let solarLastPollTs = null, solarLastError = null;
async function pollSolar() {
  const lats = AQ_POINTS.map(p => p.lat).join(',');
  const lons = AQ_POINTS.map(p => p.lon).join(',');
  try {
    const j = await fetchJson('api.open-meteo.com',
      `/v1/forecast?latitude=${lats}&longitude=${lons}&current=shortwave_radiation,direct_radiation,uv_index,cloud_cover&timezone=Pacific%2FHonolulu`,
      { 'User-Agent': 'heleon-tracker' });
    const arr = Array.isArray(j) ? j : [j];
    const next = arr.map((r, i) => ({
      name: AQ_POINTS[i] ? AQ_POINTS[i].name : `pt${i}`,
      lat: r.latitude, lon: r.longitude,
      ghi: r.current && r.current.shortwave_radiation,   // W/m² global horizontal
      dni: r.current && r.current.direct_radiation,
      uv: r.current && r.current.uv_index,
      cloud: r.current && r.current.cloud_cover,
      at: r.current && r.current.time,
    })).filter(x => x.ghi != null);
    if (next.length) { solarCache = next; solarLastPollTs = Date.now(); solarLastError = null; }
    else solarLastError = 'no solar data';
  } catch (e) { solarLastError = e.message; }
}

// ─── VOLCANO (USGS HVO HANS API + live webcams, keyless) ─────────────────────
// Live alert level/color code for Kīlauea & Mauna Loa from the official USGS
// Hazard Alert Notification System, plus the HVO webcam network — each cam is
// a public-domain JPEG that USGS refreshes continuously, so the map can show
// what the volcano looks like RIGHT NOW. All keyless.
const HVO_WEBCAMS = [
  { id: 'KWcam',  name: 'Halemaʻumaʻu crater (west rim)',        lat: 19.4055, lon: -155.2876 },
  { id: 'V1cam',  name: 'Kīlauea — west Halemaʻumaʻu (PTZ)',      lat: 19.4073, lon: -155.2884 },
  { id: 'V2cam',  name: 'Kīlauea — east Halemaʻumaʻu (PTZ)',      lat: 19.4090, lon: -155.2815 },
  { id: 'V3cam',  name: 'Kīlauea — south Halemaʻumaʻu (PTZ)',     lat: 19.4008, lon: -155.2843 },
  { id: 'KOcam',  name: 'Kīlauea upper East Rift Zone (Maunaulu)', lat: 19.3672, lon: -155.2035 },
  { id: 'MKcam',  name: 'Mauna Loa summit & NE Rift (from Mauna Kea)', lat: 19.8228, lon: -155.4749 },
  { id: 'MSPcam', name: 'Mauna Loa SW Rift Zone (from South Point)',   lat: 18.9643, lon: -155.6754 },
  { id: 'HLcam',  name: 'Mauna Loa NW flank (from Hualālai)',     lat: 19.6890, lon: -155.8645 },
];
const hvoWebcamUrl = id => `https://volcanoes.usgs.gov/cams/${id}/images/M.jpg`;
let volcanoCache = { alerts: [], webcams: HVO_WEBCAMS.map(c => ({ ...c, imageUrl: hvoWebcamUrl(c.id) })) };
let volcanoLastPollTs = null, volcanoLastError = null;
async function pollVolcano() {
  try {
    const j = await fetchJson('volcanoes.usgs.gov', '/hans-public/api/volcano/getElevatedVolcanoes',
      { 'User-Agent': 'heleon-tracker' });
    // Big Island volcano coordinates for placing the alert badge.
    const VOLC_COORDS = {
      'Kilauea': { lat: 19.421, lon: -155.287 },
      'Mauna Loa': { lat: 19.475, lon: -155.608 },
      'Hualalai': { lat: 19.692, lon: -155.87 },
      'Mauna Kea': { lat: 19.821, lon: -155.468 },
    };
    const alerts = (Array.isArray(j) ? j : [])
      .filter(v => v.obs_abbr === 'hvo' && VOLC_COORDS[v.volcano_name])
      .map(v => ({
        volcano: v.volcano_name,
        colorCode: v.color_code, alertLevel: v.alert_level,
        sentUtc: v.sent_utc, noticeUrl: v.notice_url,
        ...VOLC_COORDS[v.volcano_name],
      }));
    volcanoCache.alerts = alerts;
    volcanoLastPollTs = Date.now(); volcanoLastError = null;
  } catch (e) { volcanoLastError = e.message; }
}

// ─── AVIATION METARs (aviationweather.gov, keyless) ───────────────────────────
// Live observed weather at every Big Island airfield — including Bradshaw Army
// Airfield (PHSF) inside the Pōhakuloa Training Area, the one public real-time
// data stream that comes off the military base. Flight category (VFR/IFR),
// wind, temp, visibility, raw METAR.
const METAR_FIELDS = [
  { icao: 'PHTO', name: 'Hilo International', military: false },
  { icao: 'PHKO', name: 'Kona International (Ellison Onizuka)', military: false },
  { icao: 'PHSF', name: 'Bradshaw Army Airfield (Pōhakuloa)', military: true },
  { icao: 'PHUP', name: 'Upolu Airport', military: false },
];
let metarCache = [];
let metarLastPollTs = null, metarLastError = null;
async function pollMetars() {
  try {
    const ids = METAR_FIELDS.map(f => f.icao).join(',');
    const j = await fetchJson('aviationweather.gov', `/api/data/metar?ids=${ids}&format=json`,
      { 'User-Agent': 'heleon-tracker' });
    if (!Array.isArray(j)) { metarLastError = 'unexpected response'; return; }
    metarCache = j.map(m => {
      const meta = METAR_FIELDS.find(f => f.icao === m.icaoId) || {};
      return {
        icao: m.icaoId, name: meta.name || m.name, military: !!meta.military,
        lat: m.lat, lon: m.lon,
        tempC: m.temp, dewpC: m.dewp, windDir: m.wdir, windKt: m.wspd,
        visib: m.visib, altimHpa: m.altim, fltCat: m.fltCat,
        raw: m.rawOb, obsTime: m.obsTime ? m.obsTime * 1000 : null,
      };
    });
    metarLastPollTs = Date.now(); metarLastError = null;
  } catch (e) { metarLastError = e.message; }
}

// ─── PLACES OF INTEREST — Wikipedia geosearch (keyless, photos + notes) ──────
// Historical & notable Big Island locations straight from Wikipedia: famous
// sites, old docks, battle/heiau sites, landmarks, natural features — each with
// a thumbnail photo and a short extract on click. We geosearch a grid of points
// across the island, dedupe by pageid, then enrich the set with pageimages +
// intro extracts in one batched call. Keyless. Refreshed daily (very static).
const WIKI_GRID = [];
for (let lat = 19.0; lat <= 20.25; lat += 0.18) {
  for (let lon = -156.05; lon <= -154.85; lon += 0.18) WIKI_GRID.push([+lat.toFixed(3), +lon.toFixed(3)]);
}
let placesCache = [];
let placesLastPollTs = null, placesLastError = null;
async function pollPlaces() {
  try {
    const UA = 'heleon-tracker/1.0 (https://bus-tracker-a36o.onrender.com; bus map)';
    const wiki = (q) => fetchJson('en.wikipedia.org', `/w/api.php?${q}`, { 'User-Agent': UA });
    const found = new Map(); // pageid -> {title, lat, lon}
    for (const [lat, lon] of WIKI_GRID) {
      // Retry a couple of times with backoff — Wikipedia rate-limits rapid
      // sequential requests from shared cloud IPs (Render), so a naive tight
      // loop gets throttled and returns almost nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const j = await wiki(`action=query&format=json&list=geosearch&gscoord=${lat}%7C${lon}&gsradius=10000&gslimit=20`);
          for (const g of ((j.query && j.query.geosearch) || [])) {
            if (!found.has(g.pageid)) found.set(g.pageid, { title: g.title, lat: g.lat, lon: g.lon });
          }
          break;
        } catch (e) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
      }
      await new Promise(r => setTimeout(r, 350)); // gentler spacing
    }
    // Enrich in batches of 20 pageids with thumbnail + intro extract. If a batch
    // fails, fall back to emitting those places WITHOUT a photo (title/coords/
    // kind from geosearch) so the layer is never empty just because enrichment
    // got throttled.
    const ids = [...found.keys()];
    const out = [];
    const classify = (title, extract) => {
      const hay = `${title} ${extract}`.toLowerCase();
      if (/shipwreck|wreck|sunk|sank/.test(hay)) return 'wreck';
      if (/battle|war|fort|cannon|skirmish/.test(hay)) return 'battle';
      if (/heiau|puʻuhonua|puuhonua|sacred/.test(hay)) return 'heiau';
      if (/dock|wharf|pier|harbor|harbour|landing/.test(hay)) return 'dock';
      if (/waterfall|falls|spring|pond|lake|\bbay\b|beach/.test(hay)) return 'water';
      if (/heritage|historic|national register|monument|memorial/.test(hay)) return 'historic';
      if (/church|mission|shrine/.test(hay)) return 'church';
      if (/observatory|telescope/.test(hay)) return 'observatory';
      if (/park|refuge|forest|reserve/.test(hay)) return 'park';
      return 'landmark';
    };
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      let enriched = false;
      for (let attempt = 0; attempt < 3 && !enriched; attempt++) {
        try {
          const j = await wiki(`action=query&format=json&prop=pageimages%7Cextracts&piprop=thumbnail&pithumbsize=360&exintro=1&explaintext=1&exsentences=2&pilimit=20&pageids=${batch.join('%7C')}`);
          for (const p of Object.values((j.query && j.query.pages) || {})) {
            const base = found.get(p.pageid);
            if (!base) continue;
            const extract = (p.extract || '').trim();
            enriched = true;
            out.push({
              id: p.pageid, title: base.title, lat: base.lat, lon: base.lon,
              kind: classify(base.title, extract),
              extract: extract.slice(0, 320),
              thumb: (p.thumbnail && p.thumbnail.source) || null,
              url: `https://en.wikipedia.org/?curid=${p.pageid}`,
            });
          }
        } catch (e) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
      }
      // Enrichment throttled for this batch — still emit the places (no photo)
      // so the layer isn't empty; the title-based classifier still gives an icon.
      if (!enriched) {
        for (const pid of batch) {
          const base = found.get(pid);
          if (base) out.push({ id: pid, title: base.title, lat: base.lat, lon: base.lon,
            kind: classify(base.title, ''), extract: '', thumb: null,
            url: `https://en.wikipedia.org/?curid=${pid}` });
        }
      }
      await new Promise(r => setTimeout(r, 350));
    }
    placesLastPollTs = Date.now();
    if (out.length) { placesCache = out; placesLastError = null; }
    else placesLastError = `no places (found ${found.size} geo, ${ids.length} ids)`;
  } catch (e) { placesLastError = (e && e.message) || 'unknown error'; placesLastPollTs = Date.now(); }
}

// ─── TSUNAMI — Pacific Tsunami Warning Center bulletins (keyless Atom) ────────
// PTWC's Pacific feed (PHEB = Hawaii/Pacific messages). Most of the time it
// carries only info statements or "no threat"; a real WARNING/WATCH/ADVISORY is
// the single most important thing a Big Island status board can surface. We
// classify the latest entry so the UI can flip green→red. Keyless XML.
let tsunamiCache = null;
let tsunamiLastPollTs = null, tsunamiLastError = null;
async function pollTsunami() {
  try {
    const xml = await fetchText('www.tsunami.gov', '/events/xml/PHEBAtom.xml',
      { 'User-Agent': 'heleon-tracker' });
    // Grab the first <entry>'s title/summary/updated (most recent bulletin).
    const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1] || xml;
    const g = (re) => { const m = entry.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : null; };
    const title = g(/<title>([\s\S]*?)<\/title>/);
    const summary = g(/<summary>([\s\S]*?)<\/summary>/);
    const updated = g(/<updated>([\s\S]*?)<\/updated>/);
    const hay = `${title || ''} ${summary || ''}`.toUpperCase();
    // Severity by keyword — WARNING > WATCH > ADVISORY > info/none.
    let level = 'none';
    if (/TSUNAMI WARNING/.test(hay)) level = 'warning';
    else if (/TSUNAMI WATCH/.test(hay)) level = 'watch';
    else if (/TSUNAMI ADVISORY/.test(hay)) level = 'advisory';
    else if (/INFORMATION STATEMENT|NO TSUNAMI|THREAT/.test(hay)) level = 'info';
    tsunamiCache = { level, title, summary: (summary || '').slice(0, 400), updated };
    tsunamiLastPollTs = Date.now(); tsunamiLastError = null;
  } catch (e) { tsunamiLastError = (e && e.message) || 'unknown error'; }
}

// ─── SKY CLOCK — sun & moon for the Big Island (USNO, keyless) ────────────────
// Sunrise/sunset + moon phase & illumination for Hilo, refreshed daily. Drives
// a day/night + moon-phase status badge — the "what time is it on the island"
// readout for the RTS status board. Keyless USNO astronomical API.
let skyClockCache = null;
let skyClockLastPollTs = null, skyClockLastError = null;
async function pollSkyClock() {
  try {
    const d = new Date();
    // Hawaii is UTC-10, no DST. Use the Hawaii-local date.
    const hi = new Date(d.getTime() - 10 * 3600000);
    const date = `${hi.getUTCFullYear()}-${String(hi.getUTCMonth()+1).padStart(2,'0')}-${String(hi.getUTCDate()).padStart(2,'0')}`;
    const j = await fetchJson('aa.usno.navy.mil',
      `/api/rstt/oneday?date=${date}&coords=19.7,-155.1&tz=-10`, { 'User-Agent': 'heleon-tracker' });
    const p = j && j.properties && j.properties.data;
    if (!p) { skyClockLastError = 'unexpected response'; return; }
    const pick = (arr, phen) => { const e = (arr || []).find(x => x.phen === phen); return e ? e.time : null; };
    skyClockCache = {
      date,
      sunrise: pick(p.sundata, 'Rise'), sunset: pick(p.sundata, 'Set'),
      solarNoon: pick(p.sundata, 'Upper Transit'),
      moonrise: pick(p.moondata, 'Rise'), moonset: pick(p.moondata, 'Set'),
      moonPhase: p.curphase || (p.closestphase && p.closestphase.phase) || null,
      moonIllum: p.fracillum || null,
    };
    skyClockLastPollTs = Date.now(); skyClockLastError = null;
  } catch (e) { skyClockLastError = (e && e.message) || 'unknown error'; }
}

// ─── SATELLITES — live ISS position (wheretheiss.at, keyless) ─────────────────
// Real-time ground-track position of the International Space Station (and any
// other NORAD ids we add). Keyless, single tiny JSON per object. Rendered as a
// moving 🛰 marker with its footprint; a nice "nerdy real-time" layer that fits
// the RTS-status vibe. Distance-from-Hawaii + overhead flag computed here so the
// UI can highlight when the ISS is actually passing over the islands.
const SATELLITES = [
  { id: 25544, name: 'ISS (International Space Station)', emoji: '🛰️' },
  { id: 20580, name: 'Hubble Space Telescope', emoji: '🔭' },
];
const HAWAII_CENTER = { lat: 20.3, lon: -157.0 };
let satelliteCache = [];
let satelliteLastPollTs = null, satelliteLastError = null;
function haversineKm(a, b, c, d) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(c - a), dLon = toR(d - b);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
async function pollSatellites() {
  try {
    const out = [];
    for (const sat of SATELLITES) {
      try {
        const j = await fetchJson('api.wheretheiss.at', `/v1/satellites/${sat.id}`,
          { 'User-Agent': 'heleon-tracker' });
        if (j && j.latitude != null && j.longitude != null) {
          const distKm = haversineKm(HAWAII_CENTER.lat, HAWAII_CENTER.lon, j.latitude, j.longitude);
          // Radio horizon (visibility footprint) radius for the given altitude —
          // "overhead" if Hawaii falls within that circle.
          const altKm = j.altitude || 420;
          const footprintKm = Math.acos(6371 / (6371 + altKm)) * 6371;
          out.push({
            id: sat.id, name: sat.name, emoji: sat.emoji,
            lat: j.latitude, lon: j.longitude,
            altKm: Math.round(altKm), velKmh: j.velocity ? Math.round(j.velocity) : null,
            footprintKm: Math.round(footprintKm),
            distKm: Math.round(distKm), overhead: distKm < footprintKm,
            visibility: j.visibility || null, at: (j.timestamp ? j.timestamp * 1000 : Date.now()),
          });
        }
      } catch (e) { /* skip this satellite this cycle */ }
    }
    if (out.length) { satelliteCache = out; satelliteLastPollTs = Date.now(); satelliteLastError = null; }
    else satelliteLastError = 'no satellite data';
  } catch (e) { satelliteLastError = e.message; }
}

// ─── MESHTASTIC / LoRa MESH NODES (liamcottle map API, keyless) ───────────────
// Community MQTT aggregator — node list, telemetry, neighbours, and text
// messages. LoRa mesh carries data (not audio); we pull messages + metrics.
const MESHTASTIC_HOST = 'meshtastic.liamcottle.net';
const MESHTASTIC_CACHE_PATH = path.join(__dirname, 'data', 'meshtastic-nodes.json');
// Full node list is ~30 MB — needs a longer timeout than the default 15 s fetchJson.
const HAWAII_MESH_BBOX = { minLat: 18.8, maxLat: 22.6, minLon: -160.8, maxLon: -154.2 };
function meshtasticApi(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: MESHTASTIC_HOST, path, method: 'GET',
      headers: { 'User-Agent': 'heleon-tracker' }, timeout: 90000,
    }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', e => reject(new Error(e.code || e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
function loadMeshtasticCacheFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(MESHTASTIC_CACHE_PATH, 'utf8'));
    if (Array.isArray(j.nodes) && j.nodes.length) {
      meshtasticCache = j.nodes;
      meshtasticLastPollTs = j.lastPollTs || meshtasticLastPollTs;
    }
  } catch { /* no cache yet */ }
}
function saveMeshtasticCacheToDisk() {
  try {
    fs.writeFileSync(MESHTASTIC_CACHE_PATH, JSON.stringify({
      lastPollTs: meshtasticLastPollTs, nodes: meshtasticCache,
    }));
  } catch { /* non-fatal */ }
}
function formatMeshtasticNode(n) {
  return {
    id: n.node_id,
    idHex: n.node_id_hex || ('!' + Number(n.node_id).toString(16)),
    name: n.long_name || n.short_name || String(n.node_id),
    shortName: n.short_name || '',
    lat: n.latitude != null ? n.latitude / 1e7 : null,
    lon: n.longitude != null ? n.longitude / 1e7 : null,
    altitude: n.altitude,
    hw: n.hardware_model,
    hwName: n.hardware_model_name || '',
    role: n.role,
    roleName: n.role_name || '',
    fw: n.firmware_version || '',
    region: n.region_name || '',
    modem: n.modem_preset_name || '',
    battery: n.battery_level,
    voltage: n.voltage,
    temperature: n.temperature,
    humidity: n.relative_humidity,
    pressure: n.barometric_pressure,
    channelUtil: n.channel_utilization,
    airUtilTx: n.air_util_tx,
    uptimeSec: n.uptime_seconds,
    localNodes: n.num_online_local_nodes,
    neighbourCount: (n.neighbours || []).length,
    neighbours: (n.neighbours || []).map(nb => ({ id: nb.node_id, snr: nb.snr })),
    positionUpdated: n.position_updated_at,
    updatedAt: n.updated_at,
  };
}
let meshtasticCache = [];
let meshtasticLastPollTs = null, meshtasticLastError = null;
let meshtasticFeedCache = [];
let meshtasticFeedLastPoll = null;
let meshtasticPollInFlight = false;
loadMeshtasticCacheFromDisk();
function ensureMeshtasticPoll() {
  const stale = !meshtasticLastPollTs || Date.now() - meshtasticLastPollTs > 35 * 60 * 1000;
  if (!meshtasticPollInFlight && (meshtasticCache.length === 0 || stale)) pollMeshtastic();
}
async function pollMeshtastic() {
  if (meshtasticPollInFlight) return;
  meshtasticPollInFlight = true;
  try {
    const j = await meshtasticApi('/api/v1/nodes');
    const nodes = (j && j.nodes) || (Array.isArray(j) ? j : []);
    const b = HAWAII_MESH_BBOX;
    meshtasticCache = nodes
      .map(formatMeshtasticNode)
      .filter(n => n.lat != null && n.lat >= b.minLat && n.lat <= b.maxLat && n.lon >= b.minLon && n.lon <= b.maxLon);
    meshtasticLastPollTs = Date.now(); meshtasticLastError = null;
    saveMeshtasticCacheToDisk();
    pollMeshtasticFeed();
  } catch (e) { meshtasticLastError = e.message; }
  finally { meshtasticPollInFlight = false; }
}
async function pollMeshtasticFeed() {
  if (!meshtasticCache.length) return;
  try {
    const biIds = new Set(meshtasticCache.map(n => String(n.id)));
    const j = await meshtasticApi('/api/v1/text-messages?count=400&order=desc');
    meshtasticFeedCache = (j.text_messages || []).filter(m =>
      biIds.has(String(m.from)) || biIds.has(String(m.to)) || biIds.has(String(m.gateway_id))).slice(0, 100);
    meshtasticFeedLastPoll = Date.now();
  } catch (e) { /* keep last feed */ }
}
async function fetchMeshtasticNodeDetail(nodeId) {
  const id = encodeURIComponent(nodeId);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const [dev, env, pwr, posHist, trace, fromMsgs, toMsgs] = await Promise.all([
    meshtasticApi(`/api/v1/nodes/${id}/device-metrics?count=30&order=desc`).catch(() => ({ device_metrics: [] })),
    meshtasticApi(`/api/v1/nodes/${id}/environment-metrics?count=30&order=desc`).catch(() => ({ environment_metrics: [] })),
    meshtasticApi(`/api/v1/nodes/${id}/power-metrics?count=30&order=desc`).catch(() => ({ power_metrics: [] })),
    meshtasticApi(`/api/v1/nodes/${id}/position-history?time_from=${dayAgo}`).catch(() => ({ position_history: [] })),
    meshtasticApi(`/api/v1/nodes/${id}/traceroutes?count=15`).catch(() => ({ traceroutes: [] })),
    meshtasticApi(`/api/v1/text-messages?from=${id}&count=50&order=desc`).catch(() => ({ text_messages: [] })),
    meshtasticApi(`/api/v1/text-messages?to=${id}&count=50&order=desc`).catch(() => ({ text_messages: [] })),
  ]);
  const msgMap = new Map();
  for (const m of [...(fromMsgs.text_messages || []), ...(toMsgs.text_messages || [])]) msgMap.set(String(m.id), m);
  const messages = [...msgMap.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 80);
  const node = meshtasticCache.find(n => String(n.id) === String(nodeId)) || null;
  let neighbours = { nodes_that_we_heard: [], nodes_that_heard_us: [] };
  try { neighbours = await meshtasticApi(`/api/v1/nodes/${id}/neighbours`); } catch (e) { /* optional */ }
  return {
    node,
    messages,
    neighbours,
    deviceMetrics: dev.device_metrics || [],
    environmentMetrics: env.environment_metrics || [],
    powerMetrics: pwr.power_metrics || [],
    positionHistory: posHist.position_history || [],
    traceroutes: trace.traceroutes || [],
  };
}

// ─── HAM RADIO REPEATERS (hearham.com open API, keyless) ──────────────────────
// Every VHF/UHF amateur repeater on the island — frequency, offset, tone, mode
// (FM/DMR/D-STAR), IRLP/EchoLink internet nodes. Mostly static infrastructure,
// refreshed daily.
let repeaterCache = [];
let repeaterLastPollTs = null, repeaterLastError = null;
// Curated listen links — per-tower VHF streams are rare; the Hawaii linked-ham
// Broadcastify feed (27598) is the best keyless in-browser MP3 we can attach to
// every tower so the click-card Play button actually does something.
const HAWAII_HAM_BROADCASTIFY_PAGE = 'https://www.broadcastify.com/listen/feed/27598';
const HAWAII_HAM_STREAM = 'https://broadcastify.cdnstream1.com/27598';
const KIWISDR_MAP = 'https://rx.kiwisdr.com/';
function cleanRepeaterDescription(s) {
  if (!s) return '';
  return String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\r/g, '').trim().slice(0, 900);
}
function repeaterGroupLabel(group, mode) {
  const g = String(group || '').trim();
  const m = String(mode || 'FM').trim();
  if (!g) return `${m} amateur voice repeater`;
  if (g === 'IRLP') return `${m} repeater with IRLP internet linking`;
  if (g === 'DMR') return 'DMR digital repeater on BrandMeister';
  if (g.toLowerCase() === 'allstar') return `${m} repeater on the AllStar linking network`;
  if (g.toLowerCase().includes('echolink')) return `${m} repeater with EchoLink`;
  return `${g} ${m} repeater`;
}
function repeaterTypeEmoji(group, mode) {
  const g = String(group || '').trim().toLowerCase();
  const m = String(mode || '').trim().toLowerCase();
  if (g === 'dmr' || g.includes('mmdvm')) return '📟';
  if (g === 'irlp') return '🌐';
  if (g === 'allstar') return '🔗';
  if (g.includes('echolink')) return '📞';
  if (m.includes('dstar') || m.includes('d-star')) return '✨';
  if (m.includes('fusion') || m.includes('c4fm')) return '🎛️';
  if (m.includes('nxdn')) return '🔷';
  return '📡';
}
function repeaterListenMeta(r) {
  const g = String(r.group || '').toUpperCase();
  const node = r.internet_node || '';
  let listenLabel = 'Hawaiʻi linked ham nets';
  if (g.includes('DMR') || g.includes('MMDVM')) listenLabel = 'Hawaiʻi ham nets (DMR — see Hoseline for talkgroups)';
  else if (g === 'IRLP' && node) listenLabel = `Linked ham nets (IRLP node ${node} nearby)`;
  return {
    irlpStatus: (g === 'IRLP' && node) ? `https://status.irlp.net/?node=${node}` : '',
    listenStream: HAWAII_HAM_STREAM,
    listenLabel,
    hoselineUrl: (g.includes('DMR') || g.includes('MMDVM')) ? 'https://hose.brandmeister.network/' : '',
    broadcastifyUrl: HAWAII_HAM_BROADCASTIFY_PAGE,
    kiwisdrUrl: KIWISDR_MAP,
  };
}
async function pollRepeaters() {
  try {
    const j = await fetchJson('hearham.com', '/api/repeaters/v1', { 'User-Agent': 'heleon-tracker' });
    if (!Array.isArray(j)) { repeaterLastError = 'unexpected response'; return; }
    repeaterCache = j
      .filter(r => r.latitude > 18.5 && r.latitude < 20.6 && r.longitude > -156.5 && r.longitude < -154.4)
      .map(r => {
        const listen = repeaterListenMeta(r);
        const desc = cleanRepeaterDescription(r.description);
        return {
          callsign: r.callsign, lat: r.latitude, lon: r.longitude,
          city: r.city, mode: r.mode, group: r.group || '',
          icon: repeaterTypeEmoji(r.group, r.mode),
          typeLabel: repeaterGroupLabel(r.group, r.mode),
          freqMhz: r.frequency / 1e6, offsetMhz: r.offset / 1e6,
          tone: r.decode || r.encode || '',
          encodeTone: r.encode || '', decodeTone: r.decode || '',
          internetNode: r.internet_node || '',
          description: desc,
          power: r.power && r.power !== 'unknown' ? r.power : '',
          restriction: (r.restriction || '').trim(),
          operational: r.operational !== 0,
          ...listen,
        };
      });
    repeaterLastPollTs = Date.now(); repeaterLastError = null;
  } catch (e) { repeaterLastError = e.message; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin':'*' }); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Render health check — 200 OK with current status
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      uptime_s: Math.round(process.uptime()),
      last_poll_ts: lastPollStats?.ts || null,
      vehicles: latestVehicles?.length || 0,
    }));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/proxy') {
    handleApi(url, res).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  } else {
    handleStatic(url, res);
  }
});

// ─── BOOT ────────────────────────────────────────────────────────────────────
(async () => {
  await openDb();

  const shapeCount = dbGet(`SELECT COUNT(*) as n FROM route_shapes`);
  if (!shapeCount || shapeCount.n === 0) {
    await fetchShapes();
  } else {
    console.log(`[shapes] ${shapeCount.n} patterns cached in DB`);
  }

  await fetchAllStops();
  // Retry the initial GTFS load: on a fresh ephemeral instance (Render redeploy)
  // there's no cached DB row to fall back on, so a single transient network
  // hiccup hitting the county's feed at boot leaves gtfs_stop_times empty for
  // the server's ENTIRE lifetime — no scheduled times, no schedule-adherence
  // badge, no real schedDeltaSec for the transformer — until the next deploy.
  // A few retries with backoff covers the common transient case cheaply.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await loadGtfs();
    const n = dbGet(`SELECT COUNT(*) as n FROM gtfs_stop_times`);
    if (n && n.n > 0) break;
    if (attempt < 4) {
      console.error(`[gtfs] boot load attempt ${attempt} produced no data, retrying in ${attempt * 5}s…`);
      await new Promise(r => setTimeout(r, attempt * 5000));
    } else {
      console.error('[gtfs] boot load failed after 4 attempts — scheduled times unavailable until next deploy or periodic refresh');
    }
  }
  // Fill in geometry for schedule-only routes (401/301/204/502) that the live
  // upstream API doesn't serve, using GTFS shapes.txt — so they appear on the map.
  try { loadGtfsShapesForMissing(); } catch (e) { console.error('[gtfs-shapes]', e.message); }
  // Build the authoritative route registry (unions every source) and log any
  // route still missing geometry, so gaps surface immediately, never silently.
  try { buildRouteRegistry(); } catch (e) { console.error('[registry]', e.message); }
  // Seed road geometry from the vendored file so a fresh deploy has snapped lines
  // INSTANTLY (no waiting for Valhalla). Then the self-healing matcher fills any
  // gaps / changed routes in the background and re-vendors. "Match once, reuse forever."
  try { seedMatchedFromVendor(); } catch (e) { console.error('[match] seed:', e.message); }
  // Road-graph-snapped geometry (preferred over the Valhalla-matched vendor file
  // — see bestPatternShape) is a static, pre-generated file too: run
  // scripts/snap-routes-to-roads.js to (re)build it when new GTFS patterns appear.
  try { loadRoadSnappedShapes(); } catch (e) { console.error('[road-snap] seed:', e.message); }
  try { loadRouteEdges(); } catch (e) { console.error('[route-edges] seed:', e.message); }
  try { loadTrafficControls(); } catch (e) { console.error('[controls] seed:', e.message); }
  try { ensureTrafficControlIndex(); } catch (e) { console.error('[controls] index:', e.message); }
  try { ensureTrailGraph(); } catch (e) { console.error('[trail-graph] seed:', e.message); }
  scheduleMatching();
  buildTripIndex();
  // Train learning model on past stop_arrivals history
  try { await trainFromHistory(); } catch(e) { console.error('[learn] train error:', e.message); }
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL);
  // Boats layer — only connects if AISSTREAM_API_KEY is set. With no key, the
  // /api/vessels endpoint returns keyConfigured:false so the UI can show a
  // clean "add your free key" hint instead of faking data.
  if (AISSTREAM_API_KEY) {
    console.log('[boats] AISSTREAM_API_KEY detected — connecting to aisstream.io');
    connectAisStream();
  } else {
    console.log('[boats] AISSTREAM_API_KEY not set — boats layer disabled (set env var to enable)');
  }
  // Airplanes layer — OpenSky Network. The credit budget is the real constraint:
  // anonymous = 400/day, authenticated = 4000/day, at 1 credit per (now-small)
  // bbox call. Poll fast enough to feel live but stay under budget:
  //   authenticated: every 25s  → ~3450 calls/day  (< 4000)
  //   anonymous:     every 240s → ~360 calls/day   (< 400)
  // On error the last fix stays on screen, so a hiccup never blanks the map.
  // Community ADS-B aggregators (adsb.lol/airplanes.live) are the primary source
  // now — no credit budget, ~1 req/s limit — so we can poll fast. OpenSky is only
  // the fallback. 15s keeps aircraft moving smoothly without hammering the API.
  const aircraftPollMs = 15000;
  console.log(`[aircraft] primary: community ADS-B (adsb.lol → airplanes.live → adsb.one), no key; OpenSky fallback ${openskyAuthed() ? '(authenticated)' : '(anonymous)'}; polling every ${aircraftPollMs/1000}s`);
  pollAircraft();
  setInterval(pollAircraft, aircraftPollMs);
  // Hawaii civic layers — all free/keyless. Earthquakes and NWS alerts poll
  // every few minutes (nothing on this island changes faster than that);
  // hazard-zone polygons are static reference data, refreshed once a day.
  console.log('[hazards] polling USGS earthquakes + NWS alerts + wildfire hotspots every 5 min, hazard zones + public-safety facilities daily');
  pollEarthquakes();
  pollAlerts();
  pollHazardZones();
  pollWildfireHotspots();
  pollPubSafetyFacilities();
  pollStreamflow();
  fetchWeatherStations();
  pollSummits();
  pollOcean();
  pollMarine();
  pollFishingSummary();
  pollInfrastructure();
  pollLocal();
  pollAirQuality();
  pollVolcano();
  pollMetars();
  pollRainfall();
  setInterval(pollRainfall, 10 * 60 * 1000);      // rain gauges report ~15 min
  pollSpaceWeather();
  setInterval(pollSpaceWeather, 15 * 60 * 1000);  // Kp updates every 3h; poll loosely
  pollSkyClock();
  setInterval(pollSkyClock, 6 * 60 * 60 * 1000);  // sun/moon change slowly; refresh 4×/day
  pollTsunami();
  setInterval(pollTsunami, 5 * 60 * 1000);        // safety feed — check every 5 min
  pollPlaces();                                    // Wikipedia POIs (slow grid scan)
  setInterval(pollPlaces, 24 * 60 * 60 * 1000);   // very static — once a day
  pollSatellites();
  setInterval(pollSatellites, 20 * 1000); // ISS moves ~7.6 km/s — keep it fresh
  pollRepeaters();
  pollMobility();
  setInterval(pollMobility, 60 * 1000);
  // Meshtastic node list is ~30 MB — kick off in background (disk cache serves until ready).
  pollMeshtastic();
  connectAprs();
  setInterval(pollEarthquakes, 5 * 60 * 1000);
  setInterval(pollAlerts, 5 * 60 * 1000);
  setInterval(pollWildfireHotspots, 5 * 60 * 1000);
  setInterval(pollStreamflow, 15 * 60 * 1000);
  setInterval(fetchWeatherStations, 10 * 60 * 1000);
  setInterval(pollSummits, 5 * 60 * 1000);
  setInterval(pollOcean, 10 * 60 * 1000);
  setInterval(pollMarine, 30 * 60 * 1000);
  setInterval(pollFishingSummary, 24 * 60 * 60 * 1000);
  setInterval(pollInfrastructure, 24 * 60 * 60 * 1000);
  setInterval(pollLocal, 6 * 60 * 60 * 1000);
  setInterval(pollAirQuality, 15 * 60 * 1000);
  pollSolar();
  setInterval(pollSolar, 15 * 60 * 1000);
  pollTidePredictions();
  setInterval(pollTidePredictions, 24 * 60 * 60 * 1000);   // tide tables change daily
  setInterval(pollVolcano, 15 * 60 * 1000);
  setInterval(pollMetars, 10 * 60 * 1000);
  setInterval(pollMeshtastic, 30 * 60 * 1000);
  setInterval(pollMeshtasticFeed, 2 * 60 * 1000);
  setInterval(pollRepeaters, 24 * 60 * 60 * 1000);
  setInterval(pollHazardZones, 24 * 60 * 60 * 1000);
  setInterval(pollPubSafetyFacilities, 24 * 60 * 60 * 1000);
  setTimeout(pruneDb, 30000);                // full prune+VACUUM shortly after boot
  setInterval(pruneDb, 24 * 60 * 60 * 1000); // and daily thereafter
  // poll_log grows ~88 rows/cycle (22 routes × 4/min) but /api/stats only reads
  // the last hour — trim it hourly (cheap DELETE, no VACUUM) so it stays small
  // between the daily full prunes.
  setInterval(() => {
    if (!db) return;
    try { db.run(`DELETE FROM poll_log WHERE ts < ?`, [Date.now() - POLLLOG_RETAIN_MS]); } catch {}
  }, 60 * 60 * 1000);
  setInterval(fetchShapes, 24 * 60 * 60 * 1000);
  setInterval(fetchAllStops, 24 * 60 * 60 * 1000);
  setInterval(discoverNewRoutes, 10 * 60 * 1000); // check for new routes every 10 min
  // Rebuild the authoritative registry every 10 min so newly-seen live routes and
  // freshly-loaded shapes are reflected (and any gap re-surfaces in the log).
  setInterval(() => { try { buildRouteRegistry(); } catch {} }, 10 * 60 * 1000);
  // (Road re-snapping is handled by scheduleMatching()'s self-healing loop above.)
  // Weekly: mirror the agency's human-readable schedule PDFs (runs the scraper
  // as a child process; non-fatal if the agency site blocks us — GTFS is the
  // machine-readable source of truth and refreshes separately). First run ~1 min
  // after boot, then every 7 days.
  scheduleWeeklyScrape();
  // Periodic re-train on latest stop_arrivals (keeps model fresh)
  setInterval(() => { trainFromHistory().catch(e => console.error('[learn] periodic train:', e.message)); }, 5 * 60 * 1000);
  setInterval(saveDb, DB_SAVE_INTERVAL);
  // Check for GTFS feed updates daily (uses conditional HTTP — skips if unchanged)
  setInterval(async () => {
    console.log('\n[gtfs] Checking for feed updates…');
    await loadGtfs(true);
  }, 24 * 60 * 60 * 1000);
  discoverNewRoutes(); // also run at startup

  const localIP = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚌 Hele-On Bus Tracker running`);
    if (IS_RENDER) {
      console.log(`   Render:  ${process.env.RENDER_EXTERNAL_URL || `(port ${PORT})`}`);
      console.log(`   Mode:    Render.com (ephemeral disk → ${DATA_DIR})`);
    } else {
      console.log(`   Local:   http://localhost:${PORT}`);
      console.log(`   Network: http://${localIP}:${PORT}`);
    }
    console.log(`   DB:      ${DB_PATH}`);
    console.log(`   Polling every ${POLL_INTERVAL/1000}s (background)\n`);
  });

  // Graceful shutdown — save DB and push a final durable snapshot on exit so the
  // very latest history survives a redeploy (Render sends SIGTERM before wiping).
  const shutdown = async () => {
    console.log('\n[shutdown] Saving DB…');
    try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch {}
    if (backup.isEnabled()) {
      try { await backup.snapshot(Buffer.from(db.export()), { force: true }); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
})();
