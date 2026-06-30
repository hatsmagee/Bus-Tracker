'use strict';
/**
 * Keep data/heleon-reference.json current automatically, no human intervention.
 *
 * The reference file holds what GTFS can't express — route classification
 * (GTFS marks every HeleOn route as generic type 3), transit-hub connections and
 * Park-and-Ride/terminal points — distilled from the agency's System Map PDF.
 *
 * What CAN be auto-derived (route roster, official names, colors) we pull from
 * live GTFS routes.txt each run and reconcile into the file, so the route list
 * never goes stale. What CANNOT be reliably auto-parsed (the rasterised map's
 * classification/hub geometry) is preserved from the curated seed; when a brand
 * new route appears we add it with a best-guess class from its number range and
 * LOG it, so a human can confirm if they ever want to — but nothing breaks if
 * they don't.
 *
 * Run weekly (the server schedules it). Reads the GTFS zip the server already
 * downloads; falls back to the bundled Sources/ zip if the live one isn't there.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REF_PATH = path.join(__dirname, '..', 'data', 'heleon-reference.json');
const GTFS_LIVE = process.env.GTFS_ZIP_PATH ||
  (process.env.RENDER ? '/tmp/heleon-gtfs.zip' : path.join(__dirname, '..', 'heleon-gtfs.zip'));
const GTFS_SEED = path.join(__dirname, '..', 'Sources', 'General Transit Feed Specifications (GTFS) 2026.zip');

// Minimal ZIP reader (stored + deflate) — pulls one named entry out of a zip
// without any dependency. Enough for the small GTFS text files.
function readZipEntry(zipBuf, name) {
  let p = 0;
  while (p + 4 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(p);
    if (sig !== 0x04034b50) break; // not a local file header — stop scanning
    const method = zipBuf.readUInt16LE(p + 8);
    const compSize = zipBuf.readUInt32LE(p + 18);
    const nameLen = zipBuf.readUInt16LE(p + 26);
    const extraLen = zipBuf.readUInt16LE(p + 28);
    const fname = zipBuf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    const comp = zipBuf.slice(dataStart, dataStart + compSize);
    if (fname === name) {
      if (method === 0) return comp;
      if (method === 8) return zlib.inflateRawSync(comp);
      throw new Error(`unsupported zip method ${method}`);
    }
    p = dataStart + compSize;
  }
  // Some zips need the central directory (data-descriptor sizes). Fall back to
  // unzip via central dir is overkill here; signal not-found.
  return null;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitCsvLine(l);
    const row = {};
    headers.forEach((h, i) => row[h] = cells[i] != null ? cells[i] : '');
    return row;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur);
  return out;
}

// Best-guess class for an unknown route from HeleOn's numbering convention:
// 1–99 town/inter-town (local), 100s & 200s & 400s neighborhood, flex is curated.
function guessClass(short) {
  const n = parseInt(short, 10);
  if (!Number.isFinite(n)) return 'local';
  if (n >= 100) return 'neighborhood';
  return 'local';
}

function loadGtfsRoutes() {
  let buf = null, src = null;
  for (const cand of [GTFS_LIVE, GTFS_SEED]) {
    try { if (fs.existsSync(cand)) { buf = fs.readFileSync(cand); src = cand; break; } } catch {}
  }
  if (!buf) return { routes: null, src: null };
  const entry = readZipEntry(buf, 'routes.txt');
  if (!entry) return { routes: null, src };
  return { routes: parseCsv(entry.toString('utf8')), src };
}

function main() {
  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  const { routes, src } = loadGtfsRoutes();
  if (!routes) {
    console.warn('[reference] no GTFS routes.txt available — leaving reference file as-is');
    return;
  }
  console.log(`[reference] validating against ${routes.length} routes from ${path.basename(src)}`);

  ref.routeClass = ref.routeClass || {};
  ref.routes = ref.routes || {};
  let added = 0, updated = 0;
  const liveShorts = new Set();

  for (const r of routes) {
    const short = (r.route_short_name || r.route_id || '').trim();
    if (!short) continue;
    liveShorts.add(short);
    // Roster/name/color/url ARE auto-derived from GTFS — always refresh them.
    const next = {
      name: r.route_long_name || short,
      color: r.route_color ? `#${r.route_color}` : null,
      url: r.route_url || null,
      gtfsId: r.route_id,
    };
    if (JSON.stringify(ref.routes[short]) !== JSON.stringify(next)) { ref.routes[short] = next; updated++; }
    // Classification is curated; only fill a guess for genuinely new routes.
    if (!ref.routeClass[short]) {
      ref.routeClass[short] = guessClass(short);
      console.log(`[reference] NEW route ${short} — guessed class '${ref.routeClass[short]}' (confirm in data/heleon-reference.json if desired)`);
      added++;
    }
  }

  // Flag routes that are in our reference but no longer in GTFS (retired) —
  // don't delete (might be seasonal), just note it.
  const retired = Object.keys(ref.routeClass).filter(s => !liveShorts.has(s));
  if (retired.length) console.log(`[reference] not in current GTFS (seasonal/retired?): ${retired.join(', ')}`);

  ref.updatedAt = new Date().toISOString();
  fs.writeFileSync(REF_PATH, JSON.stringify(ref, null, 2) + '\n');
  console.log(`[reference] done — ${updated} route fields refreshed, ${added} new routes added`);
}

try { main(); } catch (e) { console.error('[reference] error:', e.message); process.exit(0); }
