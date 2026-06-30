'use strict';
/**
 * Weekly schedule scraper for HeleOn (Hawaii County Mass Transit).
 *
 * Crawls the public schedules index, follows each route's schedule page, and
 * downloads the human-readable timetable PDFs (the `home/showdocument?id=NNNN`
 * links — e.g. Route 60 Hilo–Honoka'a–Waimea is id 304971). PDFs are saved under
 * data/schedules/ with a manifest so we can detect changes week to week.
 *
 * The agency site sits behind Akamai edge protection, which blocks datacenter
 * IPs and non-browser clients (you'll see "Access Denied / errors.edgesuite.net").
 * We send realistic browser headers to get past the easy filter; if Akamai still
 * blocks (common from cloud hosts), the scraper logs a clear, non-fatal warning
 * and exits 0 — the app's machine-readable schedule data comes from the GTFS feed
 * (refreshed separately by the server), so a blocked PDF mirror is cosmetic.
 *
 * Usage:
 *   node scripts/scrape-schedules.js            # crawl + download new/changed PDFs
 *   node scripts/scrape-schedules.js --list     # just print discovered PDF URLs
 *
 * Schedule it weekly (see README) — routes/timetables change rarely.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = 'www.heleonbus.hawaiicounty.gov';
const ORIGIN = `https://${HOST}`;
const INDEX = `${ORIGIN}/getting-around/bus-schedules-and-maps`;
const OUT_DIR = path.join(__dirname, '..', 'data', 'schedules');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

// Headers that mimic a real Chrome navigation — enough to pass Akamai's cheap
// bot filter when the request comes from an allowed network.
function browserHeaders(extra) {
  return Object.assign({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
  }, extra || {});
}

function fetch(url, { binary = false, headers = {} } = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: browserHeaders(Object.assign({ Referer: ORIGIN + '/' }, headers)),
      timeout: 30000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetch(next, { binary, headers }, depth + 1));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function isBlocked(r) {
  const t = r.body.toString('latin1').slice(0, 400);
  return r.status === 403 || /Access Denied|edgesuite\.net/i.test(t);
}

// Pull absolute URLs for schedule pages and showdocument PDFs out of an HTML page.
function extractLinks(html, base) {
  const hrefs = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try { hrefs.add(new URL(m[1], base).href); } catch {}
  }
  return [...hrefs];
}

async function crawl() {
  console.log(`[scrape] index: ${INDEX}`);
  const idx = await fetch(INDEX);
  if (isBlocked(idx)) {
    console.warn('[scrape] BLOCKED by Akamai at the index page (datacenter IP?). ' +
      'Schedule DATA still comes from the GTFS feed; PDF mirror skipped. Exiting 0.');
    return { blocked: true, pdfs: [] };
  }
  const html = idx.body.toString('utf8');
  const links = extractLinks(html, INDEX);

  // Route schedule pages live under /getting-around/bus-schedules-and-maps/…
  const routePages = links.filter(u =>
    u.includes('/getting-around/bus-schedules-and-maps/') && u !== INDEX);
  // Some PDFs may be linked straight from the index.
  const pdfs = new Set(links.filter(u => /\/showdocument\?id=\d+/i.test(u)));

  console.log(`[scrape] found ${routePages.length} route pages on the index`);
  for (const page of routePages) {
    try {
      const r = await fetch(page);
      if (isBlocked(r)) { console.warn(`[scrape] blocked at ${page} — skipping`); continue; }
      extractLinks(r.body.toString('utf8'), page)
        .filter(u => /\/showdocument\?id=\d+/i.test(u))
        .forEach(u => pdfs.add(u));
    } catch (e) { console.warn(`[scrape] ${page}: ${e.message}`); }
    await new Promise(s => setTimeout(s, 500)); // be polite
  }
  return { blocked: false, pdfs: [...pdfs] };
}

function loadManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; } }

async function download(pdfs) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = loadManifest();
  let changed = 0, unchanged = 0, failed = 0;
  for (const url of pdfs) {
    const id = (url.match(/id=(\d+)/) || [])[1] || crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
    try {
      const r = await fetch(url, { binary: true, headers: { 'Sec-Fetch-Dest': 'document' } });
      if (isBlocked(r) || r.status !== 200) { console.warn(`[scrape] pdf ${id}: HTTP ${r.status}${isBlocked(r) ? ' (blocked)' : ''}`); failed++; continue; }
      const hash = crypto.createHash('sha256').update(r.body).digest('hex');
      const prev = manifest[id];
      const file = path.join(OUT_DIR, `route-${id}.pdf`);
      if (prev && prev.hash === hash && fs.existsSync(file)) { unchanged++; }
      else {
        fs.writeFileSync(file, r.body);
        console.log(`[scrape] saved route-${id}.pdf (${Math.round(r.body.length / 1024)} KB)${prev ? ' [updated]' : ' [new]'}`);
        changed++;
      }
      manifest[id] = { url, hash, bytes: r.body.length, fetchedAt: Date.now() };
    } catch (e) { console.warn(`[scrape] pdf ${id}: ${e.message}`); failed++; }
    await new Promise(s => setTimeout(s, 400));
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[scrape] done — ${changed} new/updated, ${unchanged} unchanged, ${failed} failed`);
}

(async () => {
  const { blocked, pdfs } = await crawl();
  if (blocked) process.exit(0);
  console.log(`[scrape] discovered ${pdfs.length} schedule PDFs`);
  if (process.argv.includes('--list')) { pdfs.forEach(u => console.log('  ' + u)); process.exit(0); }
  if (!pdfs.length) { console.warn('[scrape] no PDFs discovered (site layout may have changed)'); process.exit(0); }
  await download(pdfs);
})().catch(e => { console.error('[scrape] fatal:', e.message); process.exit(1); });
