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

async function generateText(prompt, { model, maxLength = 800, temperature = 0.4 } = {}) {
  const chosen = model || await pickModel();
  const submit = await req('POST', '/generate/text/async', {
    prompt,
    models: [chosen],
    params: {
      max_context_length: 4096,
      max_length: maxLength,
      temperature,
      top_p: 0.9,
      rep_pen: 1.1,
      n: 1,
    },
    trusted_workers: true,
    slow_workers: false,
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

function extractJson(text) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('horde: could not parse JSON from model output');
  }
}

module.exports = {
  apiKey,
  listTextModels,
  pickModel,
  heartbeat,
  generateText,
  extractJson,
  isBlockedModel,
  POLL_MS,
  TIMEOUT_MS,
};
