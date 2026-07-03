'use strict';

const https = require('https');

const HORDE_HOST = 'aihorde.net';
const HORDE_BASE = '/api/v2';
const ANON_KEY = '0000000000';
const POLL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;
const LLAMA2_RE = /llama[\s_-]?2/i;

function apiKey() {
  return process.env.AIHORDE_API_KEY || ANON_KEY;
}

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HORDE_HOST,
      path: `${HORDE_BASE}${apiPath}`,
      method,
      headers: {
        apikey: apiKey(),
        'Content-Type': 'application/json',
        'User-Agent': 'heleon-tracker-agent',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) {
          reject(new Error(`horde ${method} ${apiPath} ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        resolve(json);
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => { r.destroy(); reject(new Error('horde request timeout')); });
    if (payload) r.write(payload);
    r.end();
  });
}

function isBlockedModel(name) {
  return LLAMA2_RE.test(String(name || ''));
}

function scoreModel(m) {
  const name = String(m.name || m.model || '');
  if (isBlockedModel(name)) return -1;
  let s = 0;
  if (/mistral|llama[\s_-]?3|qwen|gemma|hermes|yi/i.test(name)) s += 10;
  if (m.count) s += Math.min(5, Math.log10(m.count + 1));
  return s;
}

async function listTextModels() {
  const data = await req('GET', '/status/models?type=text');
  const models = Array.isArray(data) ? data : (data.models || []);
  return models.filter(m => scoreModel(m) >= 0).sort((a, b) => scoreModel(b) - scoreModel(a));
}

async function pickModel() {
  const models = await listTextModels();
  if (!models.length) throw new Error('horde: no usable text models (all blocked or unavailable)');
  return models[0].name || models[0].model;
}

async function heartbeat() {
  try {
    const h = await req('GET', '/status/heartbeat');
    return { ok: true, ...h };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function generateText(prompt, { model, maxLength = 512, temperature = 0.4, maxContext } = {}) {
  const chosen = model || await pickModel();
  // AI Horde charges kudos up-front scaled by max_context_length; anonymous
  // (keyless) clients are rejected (403 KudosUpfront) for large requests. With a
  // key you can afford more. Keep the default small so keyless research works.
  const hasKey = !!process.env.AIHORDE_API_KEY;
  const ctx = maxContext || (hasKey ? 4096 : 1024);
  const submit = await req('POST', '/generate/text/async', {
    prompt,
    models: [chosen],
    params: {
      max_context_length: ctx,
      max_length: maxLength,
      temperature,
      top_p: 0.9,
      rep_pen: 1.1,
      n: 1,
    },
    trusted_workers: true,
    slow_workers: true,
  });
  const jobId = submit.id;
  if (!jobId) throw new Error(`horde: no job id: ${JSON.stringify(submit).slice(0, 200)}`);

  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(POLL_MS);
    const st = await req('GET', `/generate/text/status/${jobId}`);
    if (st.done && st.generations && st.generations.length) {
      const gen = st.generations[0];
      return {
        text: gen.text || '',
        model: gen.model || chosen,
        jobId,
        kudos: st.kudos,
      };
    }
    if (st.faulted) throw new Error(`horde: job faulted: ${JSON.stringify(st).slice(0, 200)}`);
  }
  throw new Error(`horde: job ${jobId} timed out after ${TIMEOUT_MS}ms`);
}

// ─── IMAGE INTERROGATION (Alchemy / caption) ───────────────────────────────
// Ask a vision worker what an image actually depicts, so we can confirm a photo
// shows the subject (a telescope on a mountain) and not something wrong (a
// toaster, or a different bridge). Keyless + async: submit → poll → caption.
//
// The public endpoint can't fetch hotlink-protected hosts (e.g. Wikimedia), so
// callers pass the image as base64 (we download it ourselves with a good UA).
// Time isn't a constraint here — the agent runs all day — so this is patient:
// long timeout, steady polling, and retries around transient hiccups.
const INTERROGATE_TIMEOUT_MS = 8 * 60 * 1000;
const INTERROGATE_POLL_MS = 5000;

async function reqRetry(method, apiPath, body, { tries = 4, base = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await req(method, apiPath, body);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      // Retry only transient conditions: rate limit, kudos backpressure, 5xx,
      // and network/timeout blips. Anything else (e.g. 400 bad input) is fatal.
      const transient = /\b(429|50\d|timeout|ECONN|ETIMEDOUT|socket|EAI_AGAIN)\b/i.test(msg)
        || /KudosUpfront|maintenance|too many/i.test(msg);
      if (!transient || attempt === tries - 1) throw e;
      await sleep(Math.min(30000, base * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Return a plain caption string for a base64-encoded image, or throw. Robust to
// transient submit/poll failures; gives up cleanly after INTERROGATE_TIMEOUT_MS.
async function interrogateCaption(imageBase64, { timeoutMs = INTERROGATE_TIMEOUT_MS, pollMs = INTERROGATE_POLL_MS } = {}) {
  if (!imageBase64 || typeof imageBase64 !== 'string') throw new Error('interrogate: no image');
  const submit = await reqRetry('POST', '/interrogate/async', {
    forms: [{ name: 'caption' }],
    source_image: imageBase64,
    slow_workers: true,
  });
  const jobId = submit && submit.id;
  if (!jobId) throw new Error(`interrogate: no job id: ${JSON.stringify(submit).slice(0, 160)}`);

  const started = Date.now();
  let softErrors = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    let st;
    try {
      st = await req('GET', `/interrogate/status/${jobId}`);
    } catch (e) {
      // Tolerate a burst of status blips without aborting the whole job.
      if (++softErrors > 10) throw e;
      continue;
    }
    softErrors = 0;
    const form = (st.forms || []).find(f => f.form === 'caption') || (st.forms || [])[0];
    if (st.state === 'done' || (form && form.state === 'done')) {
      const cap = form && form.result && (form.result.caption || form.result.text);
      if (cap) return String(cap).trim();
      throw new Error('interrogate: done but no caption in result');
    }
    if (st.state === 'faulted' || (form && form.state === 'faulted')) {
      throw new Error(`interrogate: job faulted: ${JSON.stringify(st).slice(0, 160)}`);
    }
  }
  throw new Error(`interrogate: job ${jobId} timed out after ${timeoutMs}ms`);
}

// Best-effort trailing-comma cleanup + truncation repair so we can recover a
// usable object from a weak/truncated model response (common on the free tier).
function repairJson(s) {
  let t = s.replace(/,\s*([}\]])/g, '$1');
  // If brackets are unbalanced (truncated output), close them in order.
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of t) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  // Drop a dangling `"key":` or trailing comma before closing.
  t = t.replace(/,\s*$/, '').replace(/"\s*[\w-]*"?\s*:\s*$/, '').replace(/,\s*$/, '');
  while (stack.length) {
    const open = stack.pop();
    t += open === '{' ? '}' : ']';
  }
  return t;
}

// Return the first balanced {...} object substring starting at `from`, or null.
// Handles trailing prose after valid JSON (common: model emits JSON then adds a
// "Correction:" note).
function firstBalancedObject(s, from = 0) {
  const start = s.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start); // unbalanced/truncated — let repairJson finish it
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : raw;
  const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };

  let out = tryParse(candidate);
  if (out !== undefined) return out;

  const balanced = firstBalancedObject(candidate);
  if (balanced != null) {
    out = tryParse(balanced);
    if (out !== undefined) return out;
    out = tryParse(repairJson(balanced));
    if (out !== undefined) return out;
  }
  out = tryParse(repairJson(candidate));
  if (out !== undefined) return out;

  throw new Error(`horde: could not parse JSON from model output: ${raw.slice(0, 240).replace(/\s+/g, ' ')}`);
}

module.exports = {
  apiKey,
  listTextModels,
  pickModel,
  heartbeat,
  generateText,
  interrogateCaption,
  extractJson,
  isBlockedModel,
  POLL_MS,
  TIMEOUT_MS,
};
