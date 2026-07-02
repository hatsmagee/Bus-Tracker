'use strict';

const fs = require('fs');
const github = require('./lib/github');
const { runSmoke } = require('./smoke-test');
const { readJsonFile, writeJsonFile } = require('./lib/map-items-schema');
const { loadState, saveState, recordFailure } = require('./lib/agent-state');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH } = require('./lib/paths');
const { checkNoKeysGuard } = require('./lib/no-keys-guard');

function agentEnabled() {
  return process.env.AGENT_ENABLED === '1' || process.env.AGENT_ENABLED === 'true';
}

async function publish({ force = false } = {}) {
  if (!force && !agentEnabled()) {
    return { ok: false, error: 'AGENT_ENABLED is false' };
  }

  const guard = checkNoKeysGuard();
  if (!guard.ok) return { ok: false, error: guard.error };

  if (!github.isConfigured()) {
    return { ok: false, error: 'GitHub not configured (AGENT_GITHUB_TOKEN + AGENT_GITHUB_REPO)' };
  }

  let state = loadState();
  if (state.circuitOpen) {
    return { ok: false, error: 'circuit breaker open' };
  }

  const staged = readJsonFile(MAP_ITEMS_STAGED_PATH, { items: {} });
  const stagedKeys = Object.keys(staged.items || {});
  if (!stagedKeys.length) {
    return { ok: true, message: 'nothing staged' };
  }

  const smoke = await runSmoke({ minItems: 0 });
  if (!smoke.ok) {
    recordFailure(state, `smoke failed: ${(smoke.errors || []).join('; ')}`);
    return { ok: false, error: 'smoke test failed', errors: smoke.errors };
  }

  const branch = github.stagingBranchName();
  let mainSha;
  try {
    mainSha = await github.getRefSha();
    await github.createBranch(branch, mainSha);

    const live = readJsonFile(MAP_ITEMS_PATH, { items: {} });
    const merged = {
      ...live,
      items: { ...(live.items || {}), ...(staged.items || {}) },
      source: 'agent',
    };
    const buf = Buffer.from(JSON.stringify(merged, null, 2) + '\n');

    const topic = stagedKeys.slice(0, 3).join(', ') + (stagedKeys.length > 3 ? '…' : '');
    const nSources = stagedKeys.reduce((n, k) => {
      const p = staged.items[k].provenance;
      return n + (p && p.sources ? p.sources.length : 0);
    }, 0);
    const msg = `[agent] ${topic} — ${nSources} sources`;

    await github.putFileOnBranch('data/map-items.json', buf, { branch, message: msg });

    const pr = await github.openPR({
      branch,
      title: msg,
      body: `Automated map-item enrichment.\n\nItems: ${stagedKeys.join(', ')}\n\nSmoke-tested before merge.`,
    });

    await github.mergePR(pr.number, { commitTitle: msg });

    writeJsonFile(MAP_ITEMS_PATH, merged);
    writeJsonFile(MAP_ITEMS_STAGED_PATH, { ...staged, items: {} });

    const hook = await github.postDeployHook();

    state = loadState();
    state.lastPublishAt = new Date().toISOString();
    state.lastPublishSha = mainSha;
    state.lastPrNumber = pr.number;
    state.lastError = null;
    saveState(state);

    console.log(`[publish] merged PR #${pr.number}, deploy hook: ${hook.ok ? 'ok' : 'skipped'}`);
    return { ok: true, pr: pr.number, branch, items: stagedKeys, deployHook: hook };
  } catch (e) {
    try { await github.deleteBranch(branch); } catch {}
    recordFailure(loadState(), e.message);
    return { ok: false, error: e.message };
  }
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  publish({ force })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { publish };
