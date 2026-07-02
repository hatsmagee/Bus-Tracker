'use strict';

const { audit } = require('../audit-map-items');
const { researchItem } = require('../lib/research-sources');
const { generateText, extractJson, heartbeat } = require('../lib/aihorde');
const { validateEntry } = require('../lib/map-items-schema');
const { readJsonFile, writeJsonFile, emptyDoc } = require('../lib/map-items-schema');
const { checkNoKeysGuard } = require('../lib/no-keys-guard');
const {
  loadState, saveState, recordFailure, circuitOk, bumpEnriched, loadQueue,
} = require('../lib/agent-state');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH } = require('../lib/paths');

const BUDGET = parseInt(process.env.AGENT_ITEM_BUDGET || '3', 10);

function agentEnabled() {
  return process.env.AGENT_ENABLED === '1' || process.env.AGENT_ENABLED === 'true';
}

function buildPrompt(item, research) {
  return `You are a factual research editor for a Hawaiʻi Island map encyclopedia.
Use ONLY the SOURCE TEXT below. If sources are insufficient, respond with exactly: {"skip":true,"reason":"insufficient sources"}

Output strict JSON only (no markdown fences):
{
  "title": "display name",
  "summary": "1-2 sentences",
  "history": [{"year": 1990, "text": "event", "source": "url or name"}],
  "photos": [{"url": "https://...", "credit": "author — license", "caption": "..."}],
  "links": [{"label": "...", "url": "..."}]
}

Rules:
- Every history entry needs a real year and a source from the provided text/URLs.
- Only include photos from the CANDIDATE PHOTOS list (do not invent URLs).
- Do not fabricate facts, dates, or URLs.
- Minimum 2 history entries if not skipping.

ITEM KEY: ${item.key}
ITEM TITLE: ${item.title}

SOURCE URLS:
${research.sources.join('\n')}

SOURCE TEXT:
${research.sourceText.slice(0, 9000)}

CANDIDATE PHOTOS:
${JSON.stringify(research.candidatePhotos, null, 2)}
`;
}

async function synthesizeEntry(item, research) {
  const { text, model } = await generateText(buildPrompt(item, research), { maxLength: 1200 });
  const parsed = extractJson(text);
  if (parsed.skip) return { skip: true, reason: parsed.reason || 'insufficient sources' };

  const entry = {
    title: parsed.title || item.title,
    summary: parsed.summary || '',
    history: Array.isArray(parsed.history) ? parsed.history : [],
    photos: Array.isArray(parsed.photos) ? parsed.photos : research.candidatePhotos.map(p => ({
      url: p.url, credit: p.credit, caption: p.caption || item.title,
    })),
    links: Array.isArray(parsed.links) ? parsed.links : research.sources.slice(0, 3).map(u => ({ label: 'Source', url: u })),
    provenance: {
      sources: research.sources,
      model,
      generatedAt: new Date().toISOString(),
      reviewed: false,
    },
    status: 'ok',
  };

  const errs = validateEntry(item.key, entry);
  if (errs.length) throw new Error(`validation: ${errs.join('; ')}`);
  if (entry.history.length < 2) throw new Error('validation: fewer than 2 history entries');
  return { entry };
}

async function runResearchCycle({ budget = BUDGET, force = false } = {}) {
  if (!force && !agentEnabled()) {
    return { ok: false, error: 'AGENT_ENABLED is false' };
  }

  const guard = checkNoKeysGuard();
  if (!guard.ok) return { ok: false, error: guard.error };

  let state = loadState();
  if (!circuitOk(state)) {
    return { ok: false, error: 'circuit breaker open — manual reset required' };
  }

  const hb = await heartbeat();
  if (!hb.ok) {
    recordFailure(state, `horde down: ${hb.error}`);
    return { ok: false, error: `AI Horde unavailable: ${hb.error}` };
  }

  const { queue } = audit();
  const work = (queue.items || []).slice(0, budget);
  if (!work.length) {
    state.lastResearchAt = new Date().toISOString();
    saveState(state);
    return { ok: true, enriched: 0, message: 'queue empty' };
  }

  const staged = readJsonFile(MAP_ITEMS_STAGED_PATH, emptyDoc());
  const results = [];

  for (const item of work) {
    try {
      console.log(`[agent] researching ${item.key} (${item.reason})`);
      const research = await researchItem(item);
      if (!research.sourceText || research.sources.length < 1) {
        console.log(`[agent] skip ${item.key}: no sources`);
        continue;
      }
      const synth = await synthesizeEntry(item, research);
      if (synth.skip) {
        console.log(`[agent] skip ${item.key}: ${synth.reason}`);
        continue;
      }
      staged.items[item.key] = synth.entry;
      bumpEnriched(state);
      results.push(item.key);
      writeJsonFile(MAP_ITEMS_STAGED_PATH, staged);
    } catch (e) {
      console.error(`[agent] failed ${item.key}:`, e.message);
      recordFailure(state, e.message);
    }
  }

  state = loadState();
  state.lastResearchAt = new Date().toISOString();
  state.lastTopic = results.length ? results[results.length - 1] : state.lastTopic;
  saveState(state);

  return { ok: true, enriched: results.length, keys: results, queueRemaining: Math.max(0, (queue.items || []).length - work.length) };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  runResearchCycle({ force })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runResearchCycle, synthesizeEntry };
