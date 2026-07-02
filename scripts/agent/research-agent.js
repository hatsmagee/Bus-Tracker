'use strict';

const { audit } = require('../audit-map-items');
const { researchItem } = require('../lib/research-sources');
const { generateText, heartbeat } = require('../lib/aihorde');
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

// Split source text into clean sentences, dropping our "--- marker ---" lines
// and Wikipedia "== Section ==" headers (turned into sentence breaks so a
// heading never merges into the sentence that follows it).
function sentencesOf(text) {
  return String(text || '')
    .replace(/---[^\n]*---/g, ' ')
    .replace(/={2,}[^=\n]+={2,}/g, ' . ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map(s => s.trim().replace(/^[.\s]+/, ''))
    .filter(s => s.length > 25);
}

// Trim to a max length at a word boundary so we never cut mid-word.
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// Deterministically build a history timeline from real, sourced sentences that
// mention a year (1700–2099). No fabrication — every entry is a real sentence
// from the researched sources, tagged with the best source URL. This is what
// makes enrichment reliable without depending on a weak free-tier LLM.
function deriveHistory(research) {
  const src = research.sources[0] || (research.resolvedTitle
    ? `https://en.wikipedia.org/wiki/${encodeURIComponent(research.resolvedTitle.replace(/ /g, '_'))}`
    : '');
  const seenYears = new Set();
  const out = [];
  for (const sentence of sentencesOf(research.sourceText)) {
    const m = sentence.match(/\b(1[789]\d\d|20\d\d)\b/);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    if (year < 1700 || year > new Date().getFullYear() + 1) continue;
    if (seenYears.has(year)) continue;
    seenYears.add(year);
    out.push({ year, text: clip(sentence, 240), source: src });
    if (out.length >= 6) break;
  }
  return out.sort((a, b) => a.year - b.year);
}

// A concise summary from the Wikipedia extract (first 1–2 sentences), falling
// back to the first substantive sentence of any source.
function deriveSummary(research) {
  const wiki = research.sourceText.match(/--- Wikipedia:[^\n]*---\n([\s\S]*?)(?:\n\n---|$)/);
  const base = wiki ? wiki[1] : research.sourceText;
  const sents = sentencesOf(base);
  let summary = '';
  for (const s of sents) {
    summary = summary ? `${summary} ${s}` : s;
    if (summary.length > 80) break;
  }
  return clip(summary, 320);
}

// Optional LLM polish for the summary only (a short, easy task). Best-effort:
// any failure falls back to the deterministic summary. Kept tiny to fit the
// keyless AI Horde budget.
async function polishSummary(item, research, fallback) {
  try {
    const prompt = `In ONE factual sentence, summarize "${item.title}" using only this text. No preamble.\n\n${research.sourceText.slice(0, 1200)}`;
    const { text } = await generateText(prompt, { maxLength: 120 });
    const line = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    if (line.length > 40 && line.length < 400) return line;
  } catch { /* fall back */ }
  return fallback;
}

async function synthesizeEntry(item, research) {
  const history = deriveHistory(research);
  if (history.length < 2) {
    return { skip: true, reason: `only ${history.length} dated events found in sources` };
  }

  let summary = deriveSummary(research);
  let model = 'deterministic';
  // Only spend an LLM call to improve the summary when a key is configured
  // (anonymous generation is slow); otherwise the extract-based summary is used.
  if (process.env.AIHORDE_API_KEY) {
    const polished = await polishSummary(item, research, summary);
    if (polished !== summary) { summary = polished; model = 'aihorde+extract'; }
  }
  if (!summary) summary = `${item.title} — see sources for details.`;

  const entry = {
    title: item.title,
    summary,
    history,
    photos: (research.candidatePhotos || []).slice(0, 3).map(p => ({
      url: p.url, credit: p.credit, caption: p.caption || item.title,
    })),
    links: research.sources.slice(0, 4).map(u => ({ label: 'Source', url: u })),
    provenance: {
      sources: research.sources,
      resolvedTitle: research.resolvedTitle || null,
      model,
      generatedAt: new Date().toISOString(),
      reviewed: false,
    },
    status: 'ok',
  };

  const errs = validateEntry(item.key, entry);
  if (errs.length) throw new Error(`validation: ${errs.join('; ')}`);
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

  // Synthesis is deterministic (extract-based) and only touches the LLM to
  // polish summaries when an AI Horde key is configured. So only require the
  // Horde to be up in that case — otherwise a Horde outage shouldn't stop the
  // continuous, source-driven enrichment.
  if (process.env.AIHORDE_API_KEY) {
    const hb = await heartbeat();
    if (!hb.ok) {
      recordFailure(state, `horde down: ${hb.error}`);
      return { ok: false, error: `AI Horde unavailable: ${hb.error}` };
    }
  }

  // audit() returns { report, queue } where `queue` is an ARRAY of work items.
  const { queue } = audit();
  const queueItems = Array.isArray(queue) ? queue : (queue.items || []);
  const work = queueItems.slice(0, budget);
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

  return { ok: true, enriched: results.length, keys: results, queueRemaining: Math.max(0, queueItems.length - work.length) };
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
