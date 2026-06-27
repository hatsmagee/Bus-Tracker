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

const PORT = 8765;
const DB_PATH = path.join(__dirname, 'heleon.db');
const GTFS_ZIP_PATH = path.join(__dirname, 'heleon-gtfs.zip');
const HTML_PATH = path.join(__dirname, 'heleon-tracker.html');
const POLL_INTERVAL = 10000;
const DB_SAVE_INTERVAL = 30000;
const UPSTREAM = 'myheleonbus.org';

const ROUTES = [
  { id: 5600, name: '10 KAU HILO',              short: '10',  color: '#E36C09' },
  { id: 5602, name: '102 INTRA HILO KAUMANA',   short: '102', color: '#5F497A' },
  { id: 5603, name: '103 INTRA HILO WAIAKEA UKA',short:'103', color: '#4BACC6' },
  { id: 5604, name: '101 INTRA HILO KEAUKAHA',  short: '101', color: '#CCC0D9' },
  { id: 5606, name: '70 NORTH KOHALA S. KOHALA', short: '70', color: '#C2D69B' },
  { id: 5613, name: '1 HILO KONA',               short: '1',  color: '#FFCC99' },
  { id: 5615, name: '201 KONA TROLLEY',          short: '201',color: '#FF00FF' },
  { id: 5704, name: '2 BLUELINE HILO KONA',      short: '2',  color: '#0000FF' },
  { id: 5709, name: '11 REDLINE HILO VOLCANO',   short: '11', color: '#FF0000' },
  { id: 5724, name: '40 PAHOA',                  short: '40', color: '#548DD4' },
  { id: 5725, name: '60 HILO WAIMEA',            short: '60', color: '#76923C' },
  { id: 5728, name: '75 N. KOHALA WAIKOLOA KONA',short: '75', color: '#C2D69B' },
  { id: 5729, name: '76 GREENLINE HONOKAA KONA', short: '76', color: '#00B050' },
  { id: 5730, name: '80 HILO S. KOHALA RESORTS', short: '80', color: '#E5B8B7' },
  { id: 5745, name: '90 PAHALA S. KOHALA RESORTS',short:'90', color: '#D99694' },
  { id: 5748, name: '104 INTRA HILO MOHOULI',   short: '104', color: '#FFC000' },
  { id: 5750, name: '202 CENTRAL KAILUA-KONA',  short: '202', color: '#F79646' },
  { id: 5756, name: '402 HAWAIIAN PARADISE PARK',short:'402', color: '#92CDDC' },
  { id: 5759, name: '403 FERN ACRES',           short: '403', color: '#B8CCE4' },
  { id: 5821, name: '12 VOLCANO TO OCEANVIEW',  short: '12',  color: '#FF6666' },
  { id: 5824, name: '203 NORTH KAILUA-KONA',    short: '203', color: '#E26B0A' },
  { id: 5982, name: '504 KEALAKEKUA KONA TRIPPER',short:'504',color: '#948A54' },
];
const ROUTE_MAP = Object.fromEntries(ROUTES.map(r => [r.id, r]));

// ─── DATABASE (sql.js) ────────────────────────────────────────────────────────
let db;
const initSql = require('sql.js');

async function openDb() {
  const SQL = await initSql();
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
    last_updated  TEXT
  )`);
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

  // Persist DB to disk periodically
  setInterval(saveDb, DB_SAVE_INTERVAL);
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('[db] Save error:', e.message); }
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

const GTFS_META_PATH = path.join(__dirname, 'heleon-gtfs-meta.json');

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
  trips.forEach(t => {
    tripMap[t.trip_id] = {
      route_id: parseInt(t.route_id),
      service_id: t.service_id,
      direction_id: parseInt(t.direction_id) || 0,
    };
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

  return { stRows, stopRows };
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

  const { stRows, stopRows } = parsed;
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
    db.run('COMMIT');
    saveDb();
    console.log(`[gtfs] Loaded ${stRows.length} stop times, ${stopRows.length} stops`);
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

// ─── POLLING ─────────────────────────────────────────────────────────────────
let latestVehicles = [];
let lastPollStats = { ts: null, total: 0 };
const startTime = new Date().toISOString();

// Track last known closest-stop index per vehicle for arrival detection
const vehicleLastStopIdx = {}; // vehicleId -> { stopIdx, stopId, ts }

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
  nHeads: 1,
  ffnDim: 16,
  outDim: 5,
  // weights
  embedW: [],           // inputProj (raw feature) → dModel  [dModel × rawDim]
  posW: [],             // positional encoding [dModel × nTokens]
  Wq: [], Wk: [], Wv: [], // [dModel × dModel]
  Wo: [],               // out projection after attention [dModel × dModel]
  ffnW1: [], ffnB1: [], // [ffnDim × dModel]
  ffnW2: [], ffnB2: [], // [dModel × ffnDim]
  outW: [], outB: [],   // [outDim × dModel]
  lnGamma: [], lnBeta: [],// [dModel]
  lr: 0.005,
  decay: 0.9999,
  trained: false,
  trainedCount: 0,

  init() {
    const r = (rows, cols) => Array.from({length: rows}, () =>
      Array.from({length: cols}, () => (Math.random() - 0.5) * 0.3));
    const rawDim = 5; // 5 raw features per token (speed, dist, hour_sin, hour_cos, dow_sin)
    this.embedW = r(this.dModel, rawDim);
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
    // Step 9: mean pool over tokens
    const pooled = Array(this.dModel).fill(0);
    for (const v of ffnOut) for (let d = 0; d < this.dModel; d++) pooled[d] += v[d] / this.nTokens;
    // Step 10: output heads
    const out = this.outW.map((row, i) => {
      let s = this.outB[i];
      for (let j = 0; j < pooled.length; j++) s += row[j] * pooled[j];
      return s;
    });

    return { tokens, x, Q, K, V, scores, attn, ctx, attnOut, postAttn, ffnOut, pooled, out };
  },

  // Backprop via truncated SGD on the output layer only (proxy training)
  // For a true transformer we'd backprop through attention, but a partial
  // gradient on outW + ffnW2 captures most of the signal and stays fast.
  train(tokens, targets) {
    if (!this.trained) this.init();
    const fwd = this.forward(tokens);
    const errs = fwd.out.map((p, i) => (targets[i] != null ? targets[i] - p : 0));
    const nValid = targets.filter(t => t != null).length || 1;
    // Scale by valid heads
    const scaledErrs = errs.map(e => e / nValid);
    // dL/doutW[i][j] = scaledErrs[i] * pooled[j]
    for (let i = 0; i < this.outDim; i++) {
      for (let j = 0; j < this.dModel; j++) {
        this.outW[i][j] += this.lr * scaledErrs[i] * fwd.pooled[j];
      }
      this.outB[i] += this.lr * scaledErrs[i];
    }
    // Backprop pooled → ffnOut (mean so divide by nTokens)
    const dPooled = Array(this.dModel).fill(0);
    for (let j = 0; j < this.dModel; j++) {
      for (let i = 0; i < this.outDim; i++) dPooled[j] += scaledErrs[i] * this.outW[i][j];
    }
    // Backprop ffnW2 (output of FFN): dffnW2[d][i] = dPooled[d] / nTokens * h[i]
    for (let d = 0; d < this.dModel; d++) {
      const dToFfn = dPooled[d] / this.nTokens;
      // approximate ffn activations from forward pass
      const h = this.ffnW1.map((row, i) => {
        let s = this.ffnB1[i];
        for (let k = 0; k < fwd.postAttn[0].length; k++) s += row[k] * fwd.postAttn[0][k];
        return Math.max(0, s);
      });
      for (let i = 0; i < this.ffnDim; i++) {
        this.ffnW2[d][i] += this.lr * dToFfn * h[i];
      }
      this.ffnB2[d] += this.lr * dToFfn;
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

// Build token sequence from bus state. Each token = [speed, distance, hour_sin, hour_cos, dow_sin]
// Position encodes temporal ordering of features.
function buildTokenSequence(vehicle, distanceKm, schedDeltaSec, routeId) {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const dow = now.getDay();
  const routeIdx = TX.routeIds.indexOf(routeId);
  // 12 tokens, each carrying a slice of state
  const tokens = [];
  for (let i = 0; i < 12; i++) {
    // Modulate scalars across positions to give the model positional info
    const pos = i / 12;
    const speedNorm = Math.min((vehicle.speed || 0) / 60, 1) * (1 - pos * 0.3);
    const distNorm = Math.min(distanceKm / 30, 1) * (1 - pos * 0.3);
    tokens.push([
      speedNorm,                                 // token-level speed
      distNorm,                                  // token-level distance
      Math.sin(2 * Math.PI * (hour + pos) / 24), // hour_sin with position offset
      Math.cos(2 * Math.PI * (hour + pos) / 24), // hour_cos with position offset
      Math.sin(2 * Math.PI * (dow + pos) / 7),   // dow_sin with position offset
    ]);
  }
  return tokens;
}

async function trainFromHistory() {
  console.log('[learn] Training transformer on stop_arrivals history…');
  const rows = dbAll(`
    SELECT sa.ts as actual_ts, sa.stop_id, sa.route_id, sa.vehicle_id,
           p.speed, p.lat, p.lon, s.lat as stop_lat, s.lon as stop_lon
    FROM stop_arrivals sa
    JOIN pings p ON p.vehicle_id = sa.vehicle_id AND ABS(sa.ts - p.ts) < 300000
    JOIN stops s ON s.id = sa.stop_id AND s.route_id = sa.route_id
    WHERE sa.ts > ?
    ORDER BY sa.ts DESC LIMIT 300
  `, [Date.now() - 7 * 86400000]);
  console.log(`[learn] Got ${rows.length} training rows`);

  let totalLoss = 0, n = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = rows[i];
      if (!r.stop_lat) continue;
      const dist = haversineKm(r.lat, r.lon, r.stop_lat, r.stop_lon);
      if ((r.speed || 0) < 1 || dist < 0.05) continue;
      const naiveEta = (dist / (r.speed * 1.60934)) * 60;

      const future = rows.slice(i + 1).filter(f =>
        f.vehicle_id === r.vehicle_id &&
        (f.actual_ts - r.actual_ts) > 0 &&
        (f.actual_ts - r.actual_ts) <= 60 * 60000
      ).slice(0, 5);

      const targets = future.map(f => (f.actual_ts - r.actual_ts) / 60000 - naiveEta);
      while (targets.length < 5) targets.push(null);

      const tokens = buildTokenSequence({ speed: r.speed }, dist, null, r.route_id);
      const loss = TX.train(tokens, targets);
      totalLoss += loss; n++;
    } catch(e) { /* skip bad row */ }
  }
  console.log(`[learn] Trained transformer on ${n} examples, total loss: ${totalLoss.toFixed(1)}, lr=${TX.lr.toFixed(5)}`);
}

async function pollRoute(route) {
  let result;
  try { result = await upstreamFetch(`routes/${route.id}/vehicles`); }
  catch(e) {
    dbRun(`INSERT INTO poll_log(ts,route_id,status,latency,count) VALUES(?,?,0,0,0)`, [Date.now(), route.id]);
    return [];
  }
  dbRun(`INSERT INTO poll_log(ts,route_id,status,latency,count) VALUES(?,?,?,?,?)`,
    [Date.now(), route.id, result.status, result.latency, 0]);
  if (result.status !== 200) return [];
  let vehicles;
  try { vehicles = JSON.parse(result.body); } catch { return []; }
  if (!Array.isArray(vehicles) || !vehicles.length) return [];

  const ts = Date.now();
  vehicles.forEach(v => {
    dbRun(`INSERT INTO pings (ts,vehicle_id,vehicle_name,route_id,pattern_id,lat,lon,speed,heading,heading_deg,passenger_load,capacity,shape_dist,last_updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ts, v.id, v.name, route.id, v.patternId, v.lat, v.lon, v.speed,
       v.heading, v.headingDegrees, v.passengerLoad, v.capacity,
       v.shapeDistanceTraveled, v.lastUpdated]);
  });
  return vehicles.map(v => ({ ...v, routeId: route.id, routeName: route.name, routeShort: route.short, routeColor: route.color }));
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
                const tokens = buildTokenSequence({ speed: prevState.speed }, dist, null, routeId);
                const targets = [residual, null, null, null, null];
                TX.train(tokens, targets);
              }
            }
          }
        }
      }
    } catch (e) { /* skip live training errors */ }

    vehicleLastStopIdx[vehicle.id] = { stopId: stop.id, stopIdx: closestIdx, stopSeq: stop.seq, ts: Date.now() };
  }
}

async function pollAll() {
  const results = await Promise.all(ROUTES.map(r => pollRoute(r).catch(() => [])));
  latestVehicles = results.flat();
  // Detect stop arrivals for each active vehicle
  latestVehicles.forEach(v => {
    try { detectArrivals(v, v.routeId); } catch(e) {}
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
        // Fetch stops and shapes for new route
        fetchStopsForRoute(id).then(stops => { stopsCache[id] = stops; });
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

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.ico':'image/x-icon' };

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

  if (p === '/api/trails') {
    const minutes = Math.min(parseInt(q.get('minutes') || '60'), 1440);
    const since = Date.now() - minutes * 60000;
    const rows = dbAll(
      `SELECT vehicle_id, vehicle_name, route_id, ts, lat, lon, speed, heading_deg
       FROM pings WHERE ts>=? ORDER BY vehicle_id, ts ASC`, [since]);
    const byV = {};
    rows.forEach(r => {
      if (!byV[r.vehicle_id]) byV[r.vehicle_id] = { vehicle_id: r.vehicle_id, name: r.vehicle_name, route_id: r.route_id, points: [] };
      byV[r.vehicle_id].points.push([r.lon, r.lat, r.ts, r.speed, r.heading_deg]);
    });
    return json(res, Object.values(byV));
  }

  if (p === '/api/shapes') {
    const rows = dbAll(`SELECT route_id, pattern_id, name, direction, color, shape FROM route_shapes`);
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

  if (p === '/api/eta') {
    const vid = parseInt(q.get('vehicle_id'));
    const v = latestVehicles.find(x => x.id === vid);
    if (!v) return json(res, { error: 'vehicle not found' }, 404);
    const stops = await ensureStops(v.routeId);
    const etas = calcETAs(v, stops);
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

  // Rich ETA with historical performance
  // Returns stops in order, each with: distKm, etaMinSpeed (pure speed), etaMinHistorical (avg from pings)
  if (p === '/api/stopline') {
    const vid = parseInt(q.get('vehicle_id'));
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

    // Find closest stop to figure out which direction/sequence we're travelling
    const stopETAs = stops.map((stop, i) => {
      const distKm = haversineKm(v.lat, v.lon, stop.lat, stop.lon);
      const etaSpeed = speedKmh > 1 ? (distKm / speedKmh) * 60 : null;
      const etaHist  = histAvgSpeed > 1 ? (distKm / histAvgSpeed) * 60 : etaSpeed;

      // Sequence-model prediction: predicts residuals for next 5 stops
      // Pass sched delta vs GTFS scheduled time (positive = bus behind schedule)
      const schedDeltaSec = stop.scheduledMs ? (stop.scheduledMs - Date.now()) / 1000 : null;
      const tokens = buildTokenSequence(v, distKm, schedDeltaSec, v.routeId);
      const seqPred = TX.forward(tokens);
      // For stop i+1 in route order, use head 0; for later stops use higher heads.
      // Approximation: use head 0 for now since we don't have true position-in-sequence here.
      // For more accurate per-stop predictions, we'd need to pass position info.
      const correction = seqPred.out[0];
      const etaSeq = etaHist != null ? Math.max(0, etaHist + correction) : null;

      return {
        stopId: stop.id, name: stop.name, stopCode: stop.stopCode,
        lat: stop.lat, lon: stop.lon, seq: stop.seq,
        distKm: Math.round(distKm * 1000) / 1000,
        etaMinSpeed: etaSpeed !== null ? Math.round(etaSpeed * 10) / 10 : null,
        etaMinHist:  etaHist  !== null ? Math.round(etaHist  * 10) / 10 : null,
        etaMinSeq:   etaSeq != null ? Math.round(etaSeq * 10) / 10 : null,
        seqCorrection: Math.round(correction * 10) / 10,
        seqPrediction: seqPred.out.map(o => Math.round(o * 10) / 10),
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
    if (sorted.length >= 2) {
      const c0 = sorted[0], c1 = sorted[1];
      if (Math.abs(c0.seq - c1.seq) === 1) {
        nextStop = c0.seq > c1.seq ? c0 : c1;
      } else {
        // Non-adjacent — use the last stop this vehicle actually arrived at
        const lastIdx = vehicleLastStopIdx[vid];
        let lastSeq = lastIdx && lastIdx.stopSeq != null ? lastIdx.stopSeq : null;
        // If no live tracking, look at recent DB arrival history
        if (lastSeq == null) {
          const lastArr = dbGet(
            `SELECT stop_seq FROM stop_arrivals WHERE vehicle_id=? ORDER BY ts DESC LIMIT 1`,
            [vid]
          );
          if (lastArr && lastArr.stop_seq != null) lastSeq = lastArr.stop_seq;
        }
        if (lastSeq != null) {
          // Pick the closest stop that is ahead in sequence (with wrap-around)
          let bestAhead = null, bestBehind = null;
          for (const s of stopETAs) {
            if (s.seq > lastSeq) {
              if (!bestAhead || s.distKm < bestAhead.distKm) bestAhead = s;
            } else {
              if (!bestBehind || s.distKm < bestBehind.distKm) bestBehind = s;
            }
          }
          // If we've looped past the end, take the closest behind as the next stop
          nextStop = bestAhead || bestBehind || sorted[0];
        }
      }
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

    return json(res, {
      vehicle_id: vid,
      route: v.routeName,
      routeShort: v.routeShort,
      routeColor: v.routeColor,
      speed_mph: v.speed,
      hist_avg_mph: Math.round(histAvgSpeed / 1.60934 * 10) / 10,
      hist_samples: histRows.length,
      next_stop: nextStop,
      stops: stopETAs,   // in route sequence order
      serverTs: nowMs,
    });
  }

  // GTFS official stop data (names, wheelchair)
  if (p === '/api/gtfs/stops') {
    const rows = dbAll(`SELECT stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair FROM gtfs_stops`);
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
    const totalParams = TX.dModel * 5 + TX.dModel * TX.nTokens +
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

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin':'*' }); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
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
  await loadGtfs();
  // Train learning model on past stop_arrivals history
  try { await trainFromHistory(); } catch(e) { console.error('[learn] train error:', e.message); }
  await pollAll();
  setInterval(pollAll, POLL_INTERVAL);
  setInterval(fetchShapes, 24 * 60 * 60 * 1000);
  setInterval(fetchAllStops, 24 * 60 * 60 * 1000);
  setInterval(discoverNewRoutes, 10 * 60 * 1000); // check for new routes every 10 min
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
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://${localIP}:${PORT}`);
    console.log(`   DB:      ${DB_PATH}`);
    console.log(`   Polling every ${POLL_INTERVAL/1000}s (background)\n`);
  });

  // Graceful shutdown — save DB on exit
  process.on('SIGTERM', () => { console.log('\n[shutdown] Saving DB…'); saveDb(); process.exit(0); });
  process.on('SIGINT',  () => { console.log('\n[shutdown] Saving DB…'); saveDb(); process.exit(0); });
})();
