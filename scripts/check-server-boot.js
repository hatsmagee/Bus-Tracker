#!/usr/bin/env node
'use strict';
// Real integration check: boot heleon-server.js on a throwaway port with the
// merged (live + staged) map-items data and confirm it actually serves
// /healthz and /api/map-items before we let the agent push to main. This is the
// strongest "did we break the server?" gate — it catches runtime errors that a
// syntax check (node --check) can't.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { readJsonFile } = require('./lib/map-items-schema');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH, ROOT, TMP_AGENT, ensureAgentTmp } = require('./lib/paths');

function get(port, p) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p }, resp => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
    });
    r.on('error', () => resolve({ status: 0 }));
    r.setTimeout(4000, () => { r.destroy(); resolve({ status: 0 }); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function checkServerBoot({ timeoutMs = 45000 } = {}) {
  ensureAgentTmp();
  const live = readJsonFile(MAP_ITEMS_PATH, { items: {} });
  const staged = readJsonFile(MAP_ITEMS_STAGED_PATH, { items: {} });
  const merged = { ...live, items: { ...(live.items || {}), ...(staged.items || {}) } };
  const mergedPath = path.join(TMP_AGENT, 'map-items.bootcheck.json');
  fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2) + '\n');

  const port = 19000 + Math.floor(Math.random() * 800);
  const child = spawn('node', [path.join(ROOT, 'heleon-server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), AGENT_ENABLED: 'false', MAP_ITEMS_PATH: mergedPath },
    stdio: 'ignore',
  });

  let crashed = null;
  child.on('exit', (code, sig) => { if (code) crashed = `server exited early (code ${code}${sig ? ', ' + sig : ''})`; });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (crashed) return { ok: false, error: crashed };
      await sleep(1500);
      const h = await get(port, '/healthz');
      if (h.status !== 200) continue;
      const m = await get(port, '/api/map-items');
      if (m.status !== 200) continue;
      try {
        const j = JSON.parse(m.body);
        if (j && typeof j === 'object' && j.items) return { ok: true, port };
      } catch { /* not ready yet */ }
    }
    return { ok: false, error: `server did not serve /healthz + /api/map-items within ${timeoutMs}ms` };
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    try { fs.unlinkSync(mergedPath); } catch {}
  }
}

if (require.main === module) {
  checkServerBoot()
    .then(r => {
      console.log(r.ok ? `[boot-check] OK (port ${r.port})` : `[boot-check] FAIL: ${r.error}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch(e => { console.error('[boot-check] error:', e.message); process.exit(1); });
}

module.exports = { checkServerBoot };
