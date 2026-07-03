'use strict';

const { audit } = require('../audit-map-items');
const { researchItem, fetchImageBase64 } = require('../lib/research-sources');
const { generateText, heartbeat, interrogateCaption } = require('../lib/aihorde');
const { validateEntry } = require('../lib/map-items-schema');
const { readJsonFile, writeJsonFile, emptyDoc } = require('../lib/map-items-schema');
const { checkNoKeysGuard } = require('../lib/no-keys-guard');
const {
  loadState, saveState, recordFailure, circuitOk, bumpEnriched, loadQueue,
} = require('../lib/agent-state');
const { MAP_ITEMS_PATH, MAP_ITEMS_STAGED_PATH } = require('../lib/paths');

const BUDGET = parseInt(process.env.AGENT_ITEM_BUDGET || '3', 10);
// How long to wait before retrying an item we couldn't source/synthesize, so the
// queue advances past un-enrichable items instead of grinding on them forever.
const SKIP_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  parseInt(process.env.AGENT_SKIP_COOLDOWN_MS, 10) || 7 * 24 * 60 * 60 * 1000
);

function agentEnabled() {
  return process.env.AGENT_ENABLED === '1' || process.env.AGENT_ENABLED === 'true';
}

// Web-page boilerplate that must never become "history": nav, legal, cookie and
// subscription chrome. The open-web fallback reads arbitrary pages, so we drop
// these outright. Wikipedia text effectively never trips these.
const BOILERPLATE_RE = /\b(cookie|privacy policy|terms of (?:use|service)|all rights reserved|copyright|©|sign in|log in|subscribe|newsletter|advertisement|your (?:browser|email)|enable javascript|404|home\s*›)\b/i;

// A sentence is usable prose if it's mostly letters/spaces (not a table row,
// URL, phone list, or nav breadcrumb) and reads like a sentence.
function looksLikeProse(s) {
  if (BOILERPLATE_RE.test(s)) return false;
  const letters = (s.match(/[a-z]/gi) || []).length;
  if (letters / s.length < 0.6) return false;
  const words = s.split(/\s+/).filter(w => /[a-z]/i.test(w));
  return words.length >= 5;
}

// Split source text into clean sentences, dropping our "--- marker ---" lines
// and Wikipedia "== Section ==" headers (turned into sentence breaks so a
// heading never merges into the sentence that follows it), plus web boilerplate.
function sentencesOf(text) {
  return String(text || '')
    .replace(/---[^\n]*---/g, ' ')
    .replace(/={2,}[^=\n]+={2,}/g, ' . ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map(s => s.trim().replace(/^[.\s]+/, ''))
    .filter(s => s.length > 25 && looksLikeProse(s));
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

// ─── IMAGE VERIFICATION (vision) ────────────────────────────────────────────
// Metadata gets us the right *instance* (a file whose title/description names
// this exact subject); vision confirms the right *kind of thing* — that the
// picture is actually a telescope/wind turbine/airport and not a logo, a map, or
// something unrelated. We caption each candidate with AI Horde and check the
// caption against words we'd expect for the item's category. Best-effort: if the
// Horde is unreachable we keep the metadata-selected photos rather than stall.
const VERIFY_IMAGES = process.env.AGENT_VERIFY_IMAGES !== '0' && process.env.AGENT_VERIFY_IMAGES !== 'false';

const CATEGORY_TERMS = {
  summit: ['telescope', 'observatory', 'dome', 'domes', 'antenna', 'dish', 'mountain', 'building', 'structure', 'astronomical', 'array', 'radio'],
  lco: ['telescope', 'observatory', 'dome', 'building', 'mountain', 'structure'],
  power: ['wind', 'turbine', 'windmill', 'blade', 'blades', 'solar', 'panel', 'panels', 'array', 'dam', 'hydro', 'power', 'plant', 'station', 'farm', 'energy', 'field', 'tower', 'pipe', 'steam'],
  volcano: ['volcano', 'crater', 'lava', 'mountain', 'smoke', 'eruption', 'summit', 'caldera', 'steam', 'rock', 'landscape', 'ash'],
  ocean: ['buoy', 'ocean', 'sea', 'water', 'wave', 'waves', 'boat', 'ship', 'coast', 'beach', 'harbor'],
  airport: ['airport', 'runway', 'plane', 'airplane', 'aircraft', 'terminal', 'airfield', 'tarmac', 'jet', 'hangar'],
  hub: ['bus', 'station', 'building', 'street', 'terminal', 'parking', 'road', 'sign', 'plaza', 'shop', 'store', 'building'],
  pnr: ['parking', 'lot', 'car', 'cars', 'road', 'sign', 'building', 'street'],
  sat: ['satellite', 'space', 'telescope', 'spacecraft', 'orbit', 'station', 'solar'],
  airquality: ['city', 'town', 'street', 'building', 'landscape', 'sky', 'mountain', 'aerial'],
};

function catOf(key) { return String(key || '').split(':')[0]; }

// Words the caption should plausibly contain for this item to be "the right kind
// of thing": the category vocabulary plus the item's own distinctive terms.
function expectedTerms(item) {
  const set = new Set(CATEGORY_TERMS[catOf(item.key)] || []);
  for (const t of String(`${item.title || ''} ${item.researchQuery || ''}`).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 3) set.add(t);
  }
  return set;
}

function captionScore(caption, expected) {
  const words = new Set(String(caption || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let matched = [];
  for (const t of expected) if (words.has(t)) matched.push(t);
  return { ok: matched.length > 0, matched };
}

// Caption each candidate photo and keep the ones vision confirms. A trusted
// Wikipedia lead image (pri 2) survives a generic/no-match caption (it's the
// article's own curated image); un-trusted Commons/logo images must pass or be
// dropped — a card with no photo beats a wrong photo. If the Horde never
// answered for any photo, we keep the metadata selection untouched.
async function verifyPhotos(item, photos) {
  if (!VERIFY_IMAGES || !photos || !photos.length) return photos || [];
  const expected = expectedTerms(item);
  const checked = [];
  let hordeAnswered = false;
  for (const p of photos.slice(0, 3)) {
    try {
      const img = await fetchImageBase64(p.url, { maxBytes: 6 * 1024 * 1024 });
      const caption = await interrogateCaption(img.base64);
      hordeAnswered = true;
      const { ok, matched } = captionScore(caption, expected);
      console.log(`[agent] vision ${item.key}: "${caption}" -> ${ok ? 'match(' + matched.join(',') + ')' : 'NO MATCH'}`);
      checked.push({ ...p, verifiedCaption: caption, visionOk: ok });
    } catch (e) {
      console.log(`[agent] vision ${item.key}: check failed (${e.message}) — keeping on metadata`);
      checked.push({ ...p, visionOk: null });
    }
  }
  if (!hordeAnswered) return photos; // vision unavailable → trust metadata

  const approved = checked.filter(p => p.visionOk === true);
  if (approved.length) return approved;
  // Nothing matched: keep a trusted article lead image (authoritative despite a
  // generic caption); otherwise drop rather than show a possibly-wrong photo.
  const trustedLead = checked.find(p => (p.pri || 0) >= 2);
  return trustedLead ? [trustedLead] : [];
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

  // Confirm the photos actually depict the subject before publishing them.
  const verified = await verifyPhotos(item, research.candidatePhotos || []);
  const photos = verified.slice(0, 3).map(p => ({
    url: p.url,
    credit: p.credit,
    caption: p.caption || item.title,
    ...(p.verifiedCaption ? { alt: p.verifiedCaption } : {}),
  }));

  const entry = {
    title: item.title,
    summary,
    history,
    photos,
    links: research.sources.slice(0, 4).map(u => ({ label: 'Source', url: u })),
    provenance: {
      sources: research.sources,
      resolvedTitle: research.resolvedTitle || null,
      model,
      imageChecks: verified.map(p => ({ url: p.url, caption: p.verifiedCaption || null, visionOk: p.visionOk === undefined ? null : p.visionOk })),
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

  const staged = readJsonFile(MAP_ITEMS_STAGED_PATH, emptyDoc());

  // Advance through the queue: skip items already staged (awaiting publish) and
  // ones we recently tried but couldn't source, so each cycle reaches NEW work
  // instead of re-grinding the same front-of-queue items. Without this, staged
  // work caps at the per-cycle budget and can never reach the publish batch size.
  state.skipped = state.skipped || {};
  const now = Date.now();
  const recentlySkipped = k => state.skipped[k] && (now - state.skipped[k]) < SKIP_COOLDOWN_MS;
  const work = queueItems
    .filter(i => !staged.items[i.key] && !recentlySkipped(i.key))
    .slice(0, budget);
  if (!work.length) {
    state.lastResearchAt = new Date().toISOString();
    saveState(state);
    return { ok: true, enriched: 0, message: 'no fresh work (all staged or recently skipped)' };
  }

  const results = [];
  const markSkip = k => { state.skipped[k] = Date.now(); };

  for (const item of work) {
    try {
      console.log(`[agent] researching ${item.key} (${item.reason})`);
      const research = await researchItem(item);
      if (!research.sourceText || research.sources.length < 1) {
        console.log(`[agent] skip ${item.key}: no sources`);
        markSkip(item.key);
        continue;
      }
      const synth = await synthesizeEntry(item, research);
      if (synth.skip) {
        console.log(`[agent] skip ${item.key}: ${synth.reason}`);
        markSkip(item.key);
        continue;
      }
      staged.items[item.key] = synth.entry;
      delete state.skipped[item.key];
      bumpEnriched(state);
      results.push(item.key);
      writeJsonFile(MAP_ITEMS_STAGED_PATH, staged);
    } catch (e) {
      console.error(`[agent] failed ${item.key}:`, e.message);
      recordFailure(state, e.message);
    }
  }

  // Keep mutating (and finally persisting) the same state object we've been
  // updating in the loop — reloading here would drop in-memory skip bookkeeping
  // when a cycle produced only skips.
  state.lastResearchAt = new Date().toISOString();
  state.lastTopic = results.length ? results[results.length - 1] : state.lastTopic;
  saveState(state);

  const remaining = queueItems.filter(i => !staged.items[i.key] && !recentlySkipped(i.key)).length;
  return { ok: true, enriched: results.length, keys: results, queueRemaining: remaining };
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
