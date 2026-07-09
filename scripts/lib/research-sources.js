'use strict';

const https = require('https');
const { URL } = require('url');

// Global request pacer — serialize outbound calls with a minimum gap so a
// research cycle (many Wikipedia/Commons calls in a row) never bursts hard
// enough to get throttled. Research runs sequentially, so this simple time gate
// is enough.
let _lastReq = 0;
const MIN_GAP_MS = parseInt(process.env.RESEARCH_MIN_GAP_MS || '350', 10);
function pace() {
  const now = Date.now();
  const wait = Math.max(0, _lastReq + MIN_GAP_MS - now);
  _lastReq = now + wait;
  return wait ? new Promise(r => setTimeout(r, wait)) : Promise.resolve();
}

// Wikimedia's API policy requires a descriptive User-Agent (generic strings get
// throttled/blocked). Identify the app with a contact URL.
const USER_AGENT = process.env.RESEARCH_USER_AGENT
  || 'HeleonTracker/1.0 (https://bus-tracker-a36o.onrender.com; big-island-map-agent) node.js';

function fetchTextOnce(url, { timeoutMs = 30000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`GET ${url} ${res.statusCode}`);
          err.status = res.statusCode;
          err.retryAfter = parseInt(res.headers['retry-after'], 10) || 0;
          reject(err);
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error(`timeout ${url}`)); });
    r.end();
  });
}

// Paced fetch with backoff on transient throttling (429/503).
async function fetchText(url, opts = {}) {
  const retries = 3;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();
    try {
      return await fetchTextOnce(url, opts);
    } catch (e) {
      lastErr = e;
      const transient = e && (e.status === 429 || e.status === 503 || /timeout/.test(e.message || ''));
      if (!transient || attempt === retries) throw e;
      const backoff = (e.retryAfter ? e.retryAfter * 1000 : 0) || (800 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

function fetchBufferOnce(url, { timeoutMs = 30000, headers = {}, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, ...headers },
    }, res => {
      if (res.statusCode >= 400) {
        res.resume();
        const err = new Error(`GET ${url} ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
        return;
      }
      const chunks = [];
      let n = 0;
      res.on('data', d => {
        n += d.length;
        if (n > maxBytes) { r.destroy(); reject(new Error(`image too large (>${maxBytes} bytes)`)); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error(`timeout ${url}`)); });
    r.end();
  });
}

// Download an image (with our compliant UA — Wikimedia and most hosts serve us,
// unlike the Horde's own fetcher) and return it base64-encoded for submission to
// the interrogation API. Paced + retried like our other fetches.
async function fetchImageBase64(url, opts = {}) {
  const retries = 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();
    try {
      const { buffer, contentType } = await fetchBufferOnce(url, opts);
      if (!buffer || !buffer.length) throw new Error('empty image');
      return { base64: buffer.toString('base64'), contentType, bytes: buffer.length };
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function headUrl(url, { timeoutMs = 15000 } = {}) {
  await pace();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
    }, res => {
      res.resume();
      resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error(`HEAD timeout ${url}`)); });
    r.end();
  });
}

async function ddgSearch(query) {
  const q = encodeURIComponent(query);
  const text = await fetchText(`https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1`);
  const j = JSON.parse(text);
  const out = [];
  if (j.AbstractURL && j.AbstractText) {
    out.push({ title: j.Heading || query, url: j.AbstractURL, snippet: j.AbstractText });
  }
  for (const t of (j.RelatedTopics || [])) {
    if (t.FirstURL && t.Text) out.push({ title: t.Text.split(' - ')[0], url: t.FirstURL, snippet: t.Text });
    if (Array.isArray(t.Topics)) {
      for (const sub of t.Topics) {
        if (sub.FirstURL) out.push({ title: sub.Text, url: sub.FirstURL, snippet: sub.Text });
      }
    }
  }
  return out.slice(0, 8);
}

async function jinaRead(url) {
  const readerUrl = `https://r.jina.ai/${url}`;
  const text = await fetchText(readerUrl, {
    headers: { Accept: 'text/plain' },
    timeoutMs: 45000,
  });
  return text.slice(0, 12000);
}

// A browser-like UA — DuckDuckGo's HTML endpoint serves a rate-limit challenge
// (empty 202) to unknown agents, so we look like a normal browser here.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Real, keyless web search via DuckDuckGo's HTML endpoint (the instant-answer
// JSON API only covers a tiny set of topics). Returns organic result links so
// items without a Wikipedia article can still be researched from the open web.
// Retries the 202 anti-bot challenge, which clears on a second request.
async function webSearch(query) {
  const endpoints = [
    'https://html.duckduckgo.com/html/?q=',
    'https://lite.duckduckgo.com/lite/?q=',
  ];
  let body = '';
  for (const base of endpoints) {
    for (let attempt = 0; attempt < 3 && !/result__a|result-link/.test(body); attempt++) {
      try {
        body = await fetchText(base + encodeURIComponent(query), {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
          timeoutMs: 20000,
        });
      } catch { body = ''; }
    }
    if (/result__a|result-link/.test(body)) break;
  }
  const out = [];
  const seen = new Set();
  const push = (href, title) => {
    let u = href;
    const um = u.match(/[?&]uddg=([^&]+)/);
    if (um) { try { u = decodeURIComponent(um[1]); } catch {} }
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:\/\//.test(u)) return;
    try {
      const host = new URL(u).hostname;
      if (/duckduckgo\.com$/.test(host)) return;
    } catch { return; }
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, title: decodeEntities(String(title || '').replace(/<[^>]+>/g, '').trim()) });
  };
  const re = /<a[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(body)) && out.length < 6) push(m[1], m[2]);
  return out;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// Full-text Wikipedia search — resolves a loose query (e.g. "CFHT Maunakea") to
// the best-matching real article title. The plain REST summary endpoint needs an
// exact title, so this is what makes research actually find pages.
async function wikiSearch(query) {
  const params = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query,
    srlimit: '5', format: 'json',
  });
  const text = await fetchText(`https://en.wikipedia.org/w/api.php?${params}`);
  const j = JSON.parse(text);
  return ((j.query && j.query.search) || []).map(s => s.title);
}

async function wikiSummary(title) {
  const slug = encodeURIComponent(String(title).replace(/ /g, '_'));
  const text = await fetchText(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
  const j = JSON.parse(text);
  return {
    title: j.title,
    extract: j.extract,
    url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page,
    thumbnail: j.thumbnail && j.thumbnail.source,
  };
}

// Plain-text extract for a known article title. Defaults to a generous slice of
// the article (not just the intro) so there's enough dated text to build a real
// history timeline from.
async function wikiExtract(title, { chars = 8000 } = {}) {
  // NOTE: the TextExtracts `exchars` param is capped at ~1200 by MediaWiki, far
  // too little to build a timeline from. Request the full plain-text article
  // (no exintro / exchars) and slice in JS to keep enough dated content.
  const params = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1',
    redirects: '1', titles: title, format: 'json',
  });
  const text = await fetchText(`https://en.wikipedia.org/w/api.php?${params}`);
  const j = JSON.parse(text);
  const pages = (j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const page = pages.find(p => p.extract);
  if (!page) return null;
  return { title: page.title, extract: String(page.extract).slice(0, chars) };
}


// File titles/descriptions that are almost never a real photo of the subject —
// logos, maps, diagrams, seals, charts, signatures, etc. We skip these so a card
// gets a photograph of the thing, not its logo or a location map.
const IMAGE_JUNK_RE = /\b(logo|icon|map|locator|diagram|schematic|chart|graph|plot|seal|coat[\s_-]?of[\s_-]?arms|flag|banner|signature|qr[\s_-]?code|barcode|screenshot|spectrum|light[\s_-]?curve|orbit|trajectory)\b/i;

// A license-safe Commons photo of the subject. Keyword search returns whatever
// matches the term, so — since we have no vision — we gate on metadata: the
// file's title/description/categories must mention the subject's distinctive
// terms, and obvious non-photos (logos, maps, diagrams) are rejected. If nothing
// clears the bar we return null: a card with no image beats a wrong image.
async function commonsImage(searchTerm, { mustMatch } = {}) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${searchTerm}`,
    gsrlimit: '12',
    prop: 'imageinfo|categories',
    cllimit: 'max',
    iiprop: 'url|extmetadata|size',
    iiurlwidth: '800',
    format: 'json',
  });
  const text = await fetchText(`https://commons.wikimedia.org/w/api.php?${params}`);
  const j = JSON.parse(text);
  const pages = j.query && j.query.pages ? Object.values(j.query.pages) : [];
  const need = mustMatch instanceof Set ? mustMatch : new Set();
  const clean = v => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const candidates = [];
  for (const p of pages) {
    const info = p.imageinfo && p.imageinfo[0];
    if (!info || !info.url) continue;
    const meta = info.extmetadata || {};
    const license = (meta.LicenseShortName && meta.LicenseShortName.value) || '';
    if (!/cc|public domain|pd/i.test(license)) continue;
    const fileTitle = (p.title || '').replace(/^File:/, '');
    const desc = clean(meta.ImageDescription && meta.ImageDescription.value);
    const objName = clean(meta.ObjectName && meta.ObjectName.value);
    const cats = (p.categories || []).map(c => (c.title || '').replace(/^Category:/, '')).join(' ');
    const haystack = `${fileTitle} ${desc} ${objName} ${cats}`.toLowerCase();
    if (IMAGE_JUNK_RE.test(fileTitle) || IMAGE_JUNK_RE.test(cats)) continue;
    // Relevance: at least one distinctive subject term must appear in the file's
    // own metadata. Skip the gate only when we have no distinctive terms at all.
    if (need.size) {
      let hits = 0;
      for (const t of need) if (haystack.includes(t)) hits++;
      if (!hits) continue;
      candidates.push({ p, info, meta, license, fileTitle, hits, w: info.width || 0 });
    } else {
      candidates.push({ p, info, meta, license, fileTitle, hits: 0, w: info.width || 0 });
    }
  }
  // Best = most subject-term matches, then widest image.
  candidates.sort((a, b) => b.hits - a.hits || b.w - a.w);
  const best = candidates[0];
  if (!best) return null;
  const author = clean(best.meta.Artist && best.meta.Artist.value) || 'Wikimedia Commons';
  return {
    url: best.info.thumburl || best.info.url,
    credit: `${author} — ${best.license} (Wikimedia Commons)`,
    caption: best.fileTitle || searchTerm,
    license: best.license,
    pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(best.p.title)}`,
  };
}

function countYears(s) {
  return new Set((String(s || '').match(/\b(1[789]\d\d|20\d\d)\b/g) || [])).size;
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Generic geography/category words that don't identify a specific article, so
// they shouldn't count toward matching a candidate Wikipedia page.
const GENERIC_TOKENS = new Set([
  'maunakea', 'mauna', 'kea', 'loa', 'hawaii', 'hawaiian', 'island', 'big',
  'telescope', 'telescopes', 'observatory', 'observatories', 'station', 'facility',
  'the', 'of', 'and', 'for', 'north', 'south', 'east', 'west', 'park', 'ride',
  'hele', 'transit', 'history', 'airport', 'mid', 'level', 'noaa', 'usgs', 'hvo',
]);

function distinctiveTokens(item) {
  return new Set(
    tokenize(`${item.title || ''} ${item.researchQuery || ''}`)
      .filter(t => t.length > 2 && !GENERIC_TOKENS.has(t))
  );
}

// How strongly a candidate article title matches the item's distinctive terms.
function relevanceScore(candidateTitle, distinctSet) {
  const ct = new Set(tokenize(candidateTitle));
  let s = 0;
  for (const d of distinctSet) if (ct.has(d)) s++;
  return s;
}

// Generic umbrella pages that aren't about a specific item. When a title search
// lands on one of these we try the curated research query instead.
function isUmbrella(title) {
  const t = String(title || '').toLowerCase().trim();
  return t.startsWith('list of')
    || ['maunakea observatories', 'mauna kea observatories', 'mauna kea', 'mauna loa'].includes(t);
}

async function addArticle(title, acc) {
  const ex = await wikiExtract(title).catch(() => null);
  if (!ex || !ex.extract || ex.extract.length < 200) return 0;
  if (!acc.resolvedTitle) acc.resolvedTitle = ex.title;
  acc.sourceText += `\n\n--- Wikipedia: ${ex.title} ---\n${ex.extract}`;
  try {
    const sum = await wikiSummary(ex.title);
    if (sum.url) acc.sources.push(sum.url);
    // The article's own lead image is curated to depict that exact subject — the
    // most trustworthy photo we can get without vision. But if that lead image is
    // itself a logo/icon/diagram (filename gives it away), it's the right subject
    // yet a poor card photo, so we down-rank it and let a real Commons photo win.
    if (sum.thumbnail) {
      const looksLikeLogo = IMAGE_JUNK_RE.test(decodeURIComponent(sum.thumbnail));
      acc.photos.push({
        url: sum.thumbnail,
        credit: `Wikipedia — ${ex.title} (CC/PD)`,
        caption: ex.title,
        pri: looksLikeLogo ? 0 : 2,
      });
    }
  } catch {
    acc.sources.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(ex.title.replace(/ /g, '_'))}`);
  }
  return countYears(ex.extract);
}

// Wikipedia-primary, keyless research. Pass 1: lean (1–2 articles). Pass 2+:
// more articles, open-web supplement, and extra Commons queries for partial items.
async function researchItem(item, opts = {}) {
  const { existing, pass = 1 } = opts;
  const query = item.researchQuery || item.title || item.name;
  const acc = { sources: [], photos: [], sourceText: '', resolvedTitle: null };

  const titleDistinct = distinctiveTokens({ title: item.title });
  let tHits = [];
  try { tHits = await wikiSearch(item.title || query); } catch {}
  let primary = tHits[0] || null;

  const needFallback = !primary || isUmbrella(primary)
    || (titleDistinct.size > 0 && relevanceScore(primary, titleDistinct) === 0);

  let qHits = [];
  if (needFallback && (item.researchQuery && item.researchQuery !== item.title)) {
    try { qHits = await wikiSearch(item.researchQuery); } catch {}
    const cand = titleDistinct.size > 0
      ? qHits.find(h => !isUmbrella(h) && relevanceScore(h, titleDistinct) > 0)
      : qHits.find(h => !isUmbrella(h));
    if (cand) primary = cand;
    else if (!primary) primary = qHits[0] || null;
  }

  const ordered = [...new Set([primary, ...tHits, ...qHits].filter(Boolean))];
  const maxArticles = pass >= 3 ? 4 : pass >= 2 ? 3 : 2;
  let years = 0;
  const used = new Set();
  for (const title of ordered) {
    if (used.size >= maxArticles) break;
    if (used.has(title)) continue;
    if (titleDistinct.size > 0 && title !== primary && relevanceScore(title, titleDistinct) === 0) continue;
    used.add(title);
    years += await addArticle(title, acc);
    if (years >= 4 && pass < 2) break;
  }

  const needWeb = !acc.sourceText || (pass >= 2 && years < 4);
  if (needWeb) {
    try {
      const searchQ = pass >= 2
        ? `${item.researchQuery || query} history Hawaii`
        : (item.researchQuery || query);
      const hits = await webSearch(searchQ);
      const limit = pass >= 3 ? 5 : 3;
      for (const h of hits.slice(0, limit)) {
        if (acc.sourceText.length > 8000) break;
        let body = '';
        try { body = await jinaRead(h.url); } catch { continue; }
        if (!body || body.length < 200) continue;
        if (!acc.resolvedTitle) acc.resolvedTitle = h.title || null;
        acc.sourceText += `\n\n--- Web: ${h.title || h.url} (${h.url}) ---\n${body.slice(0, 3500)}`;
        acc.sources.push(h.url);
      }
    } catch { /* web fallback is best-effort */ }
  }

  const mustMatch = new Set([
    ...distinctiveTokens({ title: item.title, researchQuery: item.researchQuery }),
    ...tokenize(acc.resolvedTitle || '').filter(t => t.length > 2 && !GENERIC_TOKENS.has(t)),
  ]);
  const photoTerms = [...new Set([
    acc.resolvedTitle,
    item.title,
    item.researchQuery,
    ...(pass >= 2 ? [`${item.title} Hawaii`, `${acc.resolvedTitle || item.title} historic`] : []),
  ].filter(Boolean))];
  for (const term of photoTerms.slice(0, pass >= 2 ? 4 : 2)) {
    const photo = await commonsImage(term, { mustMatch }).catch(() => null);
    if (photo) acc.photos.push({ ...photo, pri: 1 });
  }

  if (existing && Array.isArray(existing.photos)) {
    for (const p of existing.photos) {
      if (p && p.url) acc.photos.push({ ...p, pri: 2 });
    }
  }

  const seen = new Set();
  const candidatePhotos = acc.photos
    .filter(p => p && p.url && !seen.has(p.url) && seen.add(p.url))
    .sort((a, b) => (b.pri || 0) - (a.pri || 0));

  return {
    query,
    pass,
    resolvedTitle: acc.resolvedTitle,
    sourceText: acc.sourceText.trim(),
    sources: [...new Set(acc.sources.filter(Boolean))],
    candidatePhotos,
  };
}

module.exports = {
  fetchText,
  fetchImageBase64,
  headUrl,
  ddgSearch,
  webSearch,
  jinaRead,
  wikiSearch,
  wikiSummary,
  wikiExtract,
  commonsImage,
  researchItem,
};
