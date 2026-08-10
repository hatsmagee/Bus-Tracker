'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateMapItemsDoc, readJsonFile } = require('./lib/map-items-schema');
const { headUrl } = require('./lib/research-sources');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH, ROOT } = require('./lib/paths');

// A photo URL that verified OK stays OK; re-HEADing the whole catalog on every
// run is what got us rate-limited in the first place. Remember the good ones so
// each run only checks what's new or previously unproven.
const PHOTO_OK_CACHE = path.join(ROOT, 'data', '.photo-head-cache.json');
const PHOTO_OK_TTL_MS = 14 * 24 * 3600 * 1000;

function loadPhotoCache() {
  try {
    const j = JSON.parse(fs.readFileSync(PHOTO_OK_CACHE, 'utf8'));
    return (j && typeof j.ok === 'object') ? j.ok : {};
  } catch { return {}; }
}
function savePhotoCache(ok) {
  try {
    fs.mkdirSync(path.dirname(PHOTO_OK_CACHE), { recursive: true });
    fs.writeFileSync(PHOTO_OK_CACHE, JSON.stringify({ ok }));
  } catch { /* cache is an optimization; never fail the gate over it */ }
}

// 429/503 mean "ask me later", not "this image is missing" — the old code counted
// them as breakage, so a burst of Wikimedia throttling could fail a push that had
// nothing wrong with it. Retry those with backoff and only report a hard 4xx.
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function headWithRetry(url, tries = 4) {
  let last = '';
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(Math.min(8000, 500 * 2 ** attempt));
    try {
      const r = await headUrl(url);
      if (r.status < 400) return { ok: true };
      if (!RETRY_STATUS.has(r.status)) return { ok: false, hard: `HEAD ${r.status}` };
      last = `HEAD ${r.status}`;
    } catch (e) {
      last = `HEAD failed: ${e.message}`;
    }
  }
  return { ok: false, soft: last };
}

async function headAllPhotos(doc) {
  const errs = [];
  const ok = loadPhotoCache();
  const now = Date.now();
  let checked = 0, cached = 0, skipped = 0;

  for (const [key, entry] of Object.entries(doc.items || {})) {
    for (const [i, p] of (entry.photos || []).entries()) {
      if (!p || !p.url) continue;
      if (ok[p.url] && now - ok[p.url] < PHOTO_OK_TTL_MS) { cached++; continue; }
      checked++;
      const r = await headWithRetry(p.url);
      if (r.ok) { ok[p.url] = now; continue; }
      if (r.hard) errs.push(`${key}: photo[${i}] ${r.hard} ${p.url}`);
      // Soft failure (still throttled after retries): report but don't fail the
      // gate — we can't tell a rate limit from a real outage, and blocking a
      // push on someone else's throttling is worse than a warning.
      else { skipped++; console.warn(`[smoke] warn (not fatal): ${key}: photo[${i}] ${r.soft} ${p.url}`); }
    }
  }

  savePhotoCache(ok);
  console.log(`[smoke] photos: ${checked} checked, ${cached} cached, ${skipped} unverifiable (throttled)`);
  return errs;
}

function parseJsonFiles(files) {
  const errs = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      errs.push(`${f}: JSON parse error: ${e.message}`);
    }
  }
  return errs;
}

function verifyHasItems(doc, minItems = 0) {
  const n = Object.keys(doc.items || {}).length;
  if (n < minItems) return [`items: expected >= ${minItems}, got ${n}`];
  return [];
}

function syntaxCheckServer() {
  const r = spawnSync('node', ['--check', path.join(ROOT, 'heleon-server.js')], { encoding: 'utf8' });
  if (r.status !== 0) return [`heleon-server.js syntax: ${r.stderr || r.stdout}`];
  return [];
}

async function runSmoke({ stagedPath = MAP_ITEMS_STAGED_PATH, livePath = MAP_ITEMS_PATH, minItems = 0 } = {}) {
  const errs = [];

  const staged = readJsonFile(stagedPath, { items: {} });
  const live = readJsonFile(livePath, { items: {} });
  const merged = {
    ...live,
    items: { ...(live.items || {}), ...(staged.items || {}) },
  };

  errs.push(...parseJsonFiles([stagedPath, livePath]));
  errs.push(...syntaxCheckServer());
  errs.push(...validateMapItemsDoc(merged));
  errs.push(...verifyHasItems(merged, minItems));
  errs.push(...await headAllPhotos(merged));

  if (errs.length) {
    console.error('[smoke] FAILED:\n' + errs.map(e => `  - ${e}`).join('\n'));
    return { ok: false, errors: errs };
  }

  console.log('[smoke] OK');
  return { ok: true, itemCount: Object.keys(merged.items).length };
}

if (require.main === module) {
  runSmoke({ minItems: parseInt(process.env.SMOKE_MIN_ITEMS || '0', 10) })
    .then(r => process.exit(r.ok ? 0 : 1))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runSmoke, headAllPhotos };
