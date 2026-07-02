'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateMapItemsDoc, readJsonFile } = require('./lib/map-items-schema');
const { headUrl } = require('./lib/research-sources');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH, ROOT } = require('./lib/paths');

async function headAllPhotos(doc) {
  const errs = [];
  for (const [key, entry] of Object.entries(doc.items || {})) {
    for (const [i, p] of (entry.photos || []).entries()) {
      try {
        const r = await headUrl(p.url);
        if (r.status === 404 || r.status >= 400) {
          errs.push(`${key}: photo[${i}] HEAD ${r.status} ${p.url}`);
        }
      } catch (e) {
        errs.push(`${key}: photo[${i}] HEAD failed: ${e.message}`);
      }
    }
  }
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
