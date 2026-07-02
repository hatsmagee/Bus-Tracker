'use strict';

const https = require('https');
const { URL } = require('url');

function fetchText(url, { timeoutMs = 30000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'heleon-tracker-agent', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GET ${url} ${res.statusCode}`));
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

function headUrl(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'HEAD',
      headers: { 'User-Agent': 'heleon-tracker-agent' },
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

// Full-text Wikipedia search — resolves a loose query (e.g. "CFHT Maunakea") to
// the best-matching real article title. The plain REST summary endpoint needs an
// exact title, so this is what makes research actually find pages.
async function wikiSearch(query) {
  const params = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query,
    srlimit: '5', format: 'json', origin: '*',
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

// Plain-text intro extract for a known article title — the main source text.
async function wikiExtract(title) {
  const params = new URLSearchParams({
    action: 'query', prop: 'extracts', exintro: '1', explaintext: '1',
    redirects: '1', titles: title, format: 'json', origin: '*',
  });
  const text = await fetchText(`https://en.wikipedia.org/w/api.php?${params}`);
  const j = JSON.parse(text);
  const pages = (j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const page = pages.find(p => p.extract);
  return page ? { title: page.title, extract: page.extract } : null;
}

async function commonsImage(searchTerm) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${searchTerm}`,
    gsrlimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '800',
    format: 'json',
    origin: '*',
  });
  const text = await fetchText(`https://commons.wikimedia.org/w/api.php?${params}`);
  const j = JSON.parse(text);
  const pages = j.query && j.query.pages ? Object.values(j.query.pages) : [];
  for (const p of pages) {
    const info = p.imageinfo && p.imageinfo[0];
    if (!info || !info.url) continue;
    const meta = info.extmetadata || {};
    const license = (meta.LicenseShortName && meta.LicenseShortName.value) || '';
    const author = (meta.Artist && meta.Artist.value.replace(/<[^>]+>/g, '').trim()) || 'Wikimedia Commons';
    if (!/cc|public domain|pd/i.test(license)) continue;
    return {
      url: info.thumburl || info.url,
      credit: `${author} — ${license} (Wikimedia Commons)`,
      caption: p.title ? p.title.replace('File:', '') : searchTerm,
      license,
      pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
    };
  }
  return null;
}

async function researchItem(item) {
  const query = item.researchQuery || item.title || item.name;
  const sources = [];
  const photos = [];
  let sourceText = '';
  let resolvedTitle = null;

  // 1) Wikipedia is the reliable, keyless backbone: search resolves the loose
  //    query to a real article, then we pull its intro extract + summary.
  try {
    const titles = await wikiSearch(query);
    for (const title of titles.slice(0, 2)) {
      const ex = await wikiExtract(title).catch(() => null);
      if (ex && ex.extract && ex.extract.length > 120) {
        if (!resolvedTitle) resolvedTitle = ex.title;
        sourceText += `\n\n--- Wikipedia: ${ex.title} ---\n${ex.extract}`;
        try {
          const sum = await wikiSummary(ex.title);
          if (sum.url) sources.push(sum.url);
          if (sum.thumbnail) photos.push({
            url: sum.thumbnail,
            credit: `Wikipedia — ${ex.title} (CC/PD)`,
            caption: ex.title,
          });
        } catch {
          sources.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(ex.title.replace(/ /g, '_'))}`);
        }
      }
    }
  } catch {}

  // 2) DuckDuckGo instant answers as a supplementary source (best-effort; its
  //    Instant Answer API is sparse, so we never depend on it).
  try {
    const hits = await ddgSearch(`${query} Hawaii history`);
    for (const h of hits.slice(0, 3)) {
      if (!h.url) continue;
      sources.push(h.url);
      try {
        const body = await jinaRead(h.url);
        sourceText += `\n\n--- ${h.title} (${h.url}) ---\n${body.slice(0, 2500)}`;
      } catch {
        if (h.snippet) sourceText += `\n\n--- ${h.title} ---\n${h.snippet}`;
      }
    }
  } catch {}

  // 3) A license-safe Commons photo, seeded with the resolved article title for
  //    a better match than the raw query.
  const photo = await commonsImage(resolvedTitle || query).catch(() => null);
  if (photo) photos.push(photo);

  // De-dupe photos by url.
  const seen = new Set();
  const candidatePhotos = photos.filter(p => p && p.url && !seen.has(p.url) && seen.add(p.url));

  return {
    query,
    resolvedTitle,
    sourceText: sourceText.trim(),
    sources: [...new Set(sources.filter(Boolean))],
    candidatePhotos,
  };
}

module.exports = {
  fetchText,
  headUrl,
  ddgSearch,
  jinaRead,
  wikiSearch,
  wikiSummary,
  wikiExtract,
  commonsImage,
  researchItem,
};
