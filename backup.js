'use strict';
/**
 * Durable, FREE off-box backup of the SQLite database — so history survives even
 * when the host has an ephemeral filesystem (e.g. Render's free tier wipes /tmp
 * on every deploy/restart/spin-down). Without this the DB — and therefore all
 * accumulated trip history, arrivals and learned typical times — is lost on each
 * deploy. With it, the app restores the latest snapshot on boot and keeps the
 * record permanent at zero cost.
 *
 * Two backends, picked by environment (no key ⇒ disabled, app still runs):
 *
 *   1. GitHub repo (recommended, free, no credit card). Set:
 *        BACKUP_GITHUB_TOKEN   a fine-grained PAT with contents:read+write
 *        BACKUP_GITHUB_REPO    "owner/repo" to store snapshots in
 *        BACKUP_GITHUB_PATH    optional, default "backups/heleon.db"
 *        BACKUP_GITHUB_BRANCH  optional, default "main"
 *      INCREMENTAL: the DB is split into fixed-size shards; only shards whose
 *      content changed since the last upload are pushed (gzipped), plus a small
 *      manifest listing shard hashes for reassembly. SQLite is page-oriented,
 *      so a day of new rows touches a handful of shards, not the whole file.
 *      After each upload the branch history is squashed to a single commit
 *      (guarded — only when the repo contains nothing but backups) so the
 *      backup repo never balloons.
 *
 *   2. S3-compatible object store (Backblaze B2 / Cloudflare R2 / etc). Set:
 *        BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_KEY
 *        BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET BACKUP_S3_REGION (default us-east-1)
 *      S3 objects overwrite in place (no history problem) so this backend
 *      stays a single gzipped snapshot.
 *
 * The snapshot is the raw sql.js export (a normal SQLite file). Restore just
 * writes it to DB_PATH before openDb() reads it.
 */
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

// Scheduled uploads default to once a day: SIGTERM (deploy/spin-down/nightly
// sleep) force-uploads a final snapshot, so the daily timer only insures
// against a hard crash. Override with BACKUP_MIN_INTERVAL_MIN.
const MIN_UPLOAD_MS = Math.max(5, parseInt(process.env.BACKUP_MIN_INTERVAL_MIN, 10) || 1440) * 60 * 1000;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
// Shard granularity: smaller shards = less re-upload per change but more API
// calls. 512 KB raw (~100-150 KB gzipped) is a good balance for a ~40 MB DB.
const SHARD_SIZE = Math.max(64, parseInt(process.env.BACKUP_SHARD_KB, 10) || 512) * 1024;

// ── GitHub Contents API backend ────────────────────────────────────────────────
const GH_TOKEN  = process.env.BACKUP_GITHUB_TOKEN;
const GH_REPO   = process.env.BACKUP_GITHUB_REPO;
const GH_PATH   = process.env.BACKUP_GITHUB_PATH   || 'backups/heleon.db';
const GH_BRANCH = process.env.BACKUP_GITHUB_BRANCH || 'main';
const GH_SHARD_DIR = `${GH_PATH}.shards`;
const GH_MANIFEST  = `${GH_PATH}.manifest.json`;

// ── S3 backend ─────────────────────────────────────────────────────────────────
const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT; // e.g. https://s3.us-west-004.backblazeb2.com
const S3_BUCKET   = process.env.BACKUP_S3_BUCKET;
const S3_KEY      = process.env.BACKUP_S3_KEY || 'heleon.db';
const S3_ACCESS   = process.env.BACKUP_S3_ACCESS_KEY;
const S3_SECRET   = process.env.BACKUP_S3_SECRET;
const S3_REGION   = process.env.BACKUP_S3_REGION || 'us-east-1';

function backend() {
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS && S3_SECRET) return 's3';
  if (GH_TOKEN && GH_REPO) return 'github';
  return null;
}
const isEnabled = () => backend() != null;

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

// ── GitHub ──────────────────────────────────────────────────────────────────────
function ghHeaders(extra) {
  return {
    'Authorization': `Bearer ${GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'heleon-tracker-backup',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(extra || {}),
  };
}
function ghApi(method, apiPath, bodyObj, extraHeaders) {
  const body = bodyObj ? JSON.stringify(bodyObj) : null;
  return req({
    hostname: 'api.github.com',
    path: apiPath,
    method,
    headers: ghHeaders({
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(extraHeaders || {}),
    }),
  }, body);
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

async function ghGetRaw(filePath) {
  const r = await ghApi('GET', `/repos/${GH_REPO}/contents/${encPath(filePath)}?ref=${GH_BRANCH}`,
    null, { 'Accept': 'application/vnd.github.raw' });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`github get ${filePath} ${r.status}`);
  return r.body;
}
// name → blob sha for every file in a repo directory ({} when the dir is absent).
async function ghListShas(dirPath) {
  const r = await ghApi('GET', `/repos/${GH_REPO}/contents${dirPath ? '/' + encPath(dirPath) : ''}?ref=${GH_BRANCH}`);
  if (r.status === 404) return {};
  if (r.status !== 200) throw new Error(`github list ${dirPath} ${r.status}`);
  const out = {};
  for (const f of JSON.parse(r.body.toString())) out[f.name] = f.sha;
  return out;
}
async function ghPutFile(filePath, buf, sha, message) {
  const r = await ghApi('PUT', `/repos/${GH_REPO}/contents/${encPath(filePath)}`, {
    message, content: buf.toString('base64'), branch: GH_BRANCH, ...(sha ? { sha } : {}),
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`github put ${filePath} ${r.status}: ${r.body.toString().slice(0, 160)}`);
  }
  return JSON.parse(r.body.toString()).content.sha;
}
async function ghDeleteFile(filePath, sha, message) {
  const r = await ghApi('DELETE', `/repos/${GH_REPO}/contents/${encPath(filePath)}`, {
    message, sha, branch: GH_BRANCH,
  });
  if (r.status !== 200) throw new Error(`github delete ${filePath} ${r.status}`);
}

// Squash the branch to a single parentless commit so the backup repo never
// accumulates a snapshot-per-upload history. GUARD: refuses to touch a repo
// whose root contains anything besides the backup directory (and repo
// boilerplate) — squashing rewrites history for the whole branch, and this
// must never nuke a repo that also holds real code.
async function ghSquashHistory() {
  const rootAllow = new Set([
    GH_PATH.split('/')[0], GH_SHARD_DIR.split('/')[0], GH_MANIFEST.split('/')[0],
    'README.md', '.gitignore', 'LICENSE',
  ]);
  const rootR = await ghApi('GET', `/repos/${GH_REPO}/contents?ref=${GH_BRANCH}`);
  if (rootR.status !== 200) throw new Error(`github root list ${rootR.status}`);
  const entries = JSON.parse(rootR.body.toString());
  const strangers = entries.filter(e => !rootAllow.has(e.name)).map(e => e.name);
  if (strangers.length) {
    console.log(`[backup] history squash skipped — repo has non-backup content (${strangers.slice(0, 5).join(', ')})`);
    return;
  }
  const refR = await ghApi('GET', `/repos/${GH_REPO}/git/ref/${encodeURIComponent('heads/' + GH_BRANCH)}`);
  if (refR.status !== 200) throw new Error(`github ref ${refR.status}`);
  const headSha = JSON.parse(refR.body.toString()).object.sha;
  const commitR = await ghApi('GET', `/repos/${GH_REPO}/git/commits/${headSha}`);
  if (commitR.status !== 200) throw new Error(`github commit ${commitR.status}`);
  const head = JSON.parse(commitR.body.toString());
  if (!head.parents || head.parents.length === 0) return; // already a single root commit
  const newR = await ghApi('POST', `/repos/${GH_REPO}/git/commits`, {
    message: `db snapshot ${new Date().toISOString()} (history squashed)`,
    tree: head.tree.sha,
    parents: [],
  });
  if (newR.status !== 201) throw new Error(`github new commit ${newR.status}`);
  const newSha = JSON.parse(newR.body.toString()).sha;
  const patchR = await ghApi('PATCH', `/repos/${GH_REPO}/git/refs/${encodeURIComponent('heads/' + GH_BRANCH)}`, {
    sha: newSha, force: true,
  });
  if (patchR.status !== 200) throw new Error(`github ref update ${patchR.status}`);
  console.log('[backup] github history squashed to a single commit');
}

// Cached remote state so repeat snapshots in one process life only upload deltas.
// { shas: {name→sha}, manifest: {shardSize,totalLen,hashes[]}, legacyChecked }
let ghState = null;
const shardName = i => `s${String(i).padStart(4, '0')}.gz`;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

async function ghLoadState() {
  if (ghState) return ghState;
  const shas = await ghListShas(GH_SHARD_DIR);
  let manifest = null;
  try {
    const m = await ghGetRaw(GH_MANIFEST);
    if (m) manifest = JSON.parse(m.toString());
  } catch { manifest = null; }
  ghState = { shas, manifest, legacyChecked: false };
  return ghState;
}

async function ghUploadIncremental(buf) {
  const st = await ghLoadState();
  const count = Math.ceil(buf.length / SHARD_SIZE) || 1;
  const hashes = [];
  const changed = [];
  for (let i = 0; i < count; i++) {
    const raw = buf.subarray(i * SHARD_SIZE, Math.min((i + 1) * SHARD_SIZE, buf.length));
    const h = sha256(raw);
    hashes.push(h);
    const prev = st.manifest && st.manifest.shardSize === SHARD_SIZE ? st.manifest.hashes[i] : undefined;
    if (h !== prev || !st.shas[shardName(i)]) changed.push({ i, raw });
  }
  let sentBytes = 0;
  for (const { i, raw } of changed) {
    const gz = zlib.gzipSync(raw, { level: 6 });
    const name = shardName(i);
    st.shas[name] = await ghPutFile(`${GH_SHARD_DIR}/${name}`, gz, st.shas[name] || null, `db shard ${i}`);
    sentBytes += gz.length;
  }
  // DB shrank → drop shards past the new tail so restore can't concat stale data.
  for (const name of Object.keys(st.shas)) {
    const idx = parseInt(name.slice(1, 5), 10);
    if (Number.isFinite(idx) && idx >= count) {
      try { await ghDeleteFile(`${GH_SHARD_DIR}/${name}`, st.shas[name], `drop stale shard ${idx}`); } catch {}
      delete st.shas[name];
    }
  }
  const manifest = { v: 1, shardSize: SHARD_SIZE, totalLen: buf.length, count, hashes, updatedAt: new Date().toISOString() };
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  if (st.manifestSha === undefined) {
    try {
      const dir = GH_MANIFEST.split('/').slice(0, -1).join('/');
      st.manifestSha = (await ghListShas(dir))[GH_MANIFEST.split('/').pop()] || null;
    } catch { st.manifestSha = null; }
  }
  st.manifestSha = await ghPutFile(GH_MANIFEST, manifestBuf, st.manifestSha, 'db manifest');
  st.manifest = manifest;
  // One-time migration: remove the legacy monolithic snapshot file.
  if (!st.legacyChecked) {
    st.legacyChecked = true;
    try {
      const dir = GH_PATH.split('/').slice(0, -1).join('/') || '.';
      const legacySha = (await ghListShas(dir))[GH_PATH.split('/').pop()];
      if (legacySha) await ghDeleteFile(GH_PATH, legacySha, 'remove legacy monolithic snapshot');
    } catch {}
  }
  try { await ghSquashHistory(); } catch (e) { console.log(`[backup] squash skipped: ${e.message}`); }
  return { changed: changed.length, count, sentBytes };
}

async function ghRestoreIncremental() {
  const m = await ghGetRaw(GH_MANIFEST);
  if (!m) return null;
  const manifest = JSON.parse(m.toString());
  const parts = [];
  for (let i = 0; i < manifest.count; i++) {
    const gz = await ghGetRaw(`${GH_SHARD_DIR}/${shardName(i)}`);
    if (!gz) throw new Error(`shard ${i} missing`);
    const raw = zlib.gunzipSync(gz);
    if (sha256(raw) !== manifest.hashes[i]) throw new Error(`shard ${i} hash mismatch`);
    parts.push(raw);
  }
  const buf = Buffer.concat(parts);
  if (buf.length !== manifest.totalLen) throw new Error(`assembled ${buf.length} ≠ manifest ${manifest.totalLen}`);
  return buf;
}

// Legacy single-file restore (pre-shard snapshots, raw or gzipped).
async function ghRestoreLegacy() {
  return ghGetRaw(GH_PATH);
}

// ── S3 (SigV4, single PUT/GET — no SDK) ──────────────────────────────────────────
function sha256hex(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function s3Signed(method, payload) {
  const url = new URL(`${S3_ENDPOINT}/${S3_BUCKET}/${S3_KEY}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;
  const payloadHash = sha256hex(payload || Buffer.alloc(0));
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest))].join('\n');
  let k = hmac('AWS4' + S3_SECRET, dateStamp);
  k = hmac(k, S3_REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return {
    hostname: host, path: url.pathname, method,
    headers: {
      'Host': host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
      'Authorization': auth, ...(payload ? { 'Content-Length': payload.length } : {}),
    },
  };
}
async function s3Upload(buf) {
  const r = await req(s3Signed('PUT', buf), buf);
  if (r.status !== 200) throw new Error(`s3 put ${r.status}: ${r.body.toString().slice(0, 160)}`);
}
async function s3Restore() {
  const r = await req(s3Signed('GET', Buffer.alloc(0)));
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`s3 get ${r.status}`);
  return r.body;
}

// ── Public API ────────────────────────────────────────────────────────────────
async function restore() {
  const b = backend();
  if (!b) return null;
  try {
    let buf = null;
    if (b === 's3') {
      buf = await s3Restore();
    } else {
      try { buf = await ghRestoreIncremental(); }
      catch (e) { console.error(`[backup] sharded restore failed (${e.message}) — trying legacy snapshot`); }
      if (!buf) buf = await ghRestoreLegacy();
    }
    // Older snapshots were raw SQLite; single-file ones may be gzipped. Auto-detect.
    if (buf && buf.length > 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) buf = zlib.gunzipSync(buf);
    if (buf && buf.length > 0) { console.log(`[backup] restored ${Math.round(buf.length / 1024)} KB from ${b}`); return buf; }
    console.log(`[backup] no snapshot found in ${b} (fresh start)`);
    return null;
  } catch (e) { console.error(`[backup] restore failed (${b}):`, e.message); return null; }
}
let lastUpload = 0, uploading = false, lastUploadHash = null;
async function snapshot(buf, { force = false } = {}) {
  const b = backend();
  if (!b || uploading) return;
  const now = Date.now();
  if (!force && now - lastUpload < MIN_UPLOAD_MS) return;
  // Skip entirely when the DB hasn't changed since the last successful upload.
  const hash = sha256(buf);
  if (hash === lastUploadHash) { lastUpload = now; return; }
  uploading = true;
  try {
    if (b === 's3') {
      const gz = zlib.gzipSync(buf, { level: 6 });
      await s3Upload(gz);
      console.log(`[backup] snapshot uploaded to s3 (${Math.round(buf.length / 1024)} KB → ${Math.round(gz.length / 1024)} KB gz)`);
    } else {
      const r = await ghUploadIncremental(buf);
      console.log(`[backup] incremental snapshot to github: ${r.changed}/${r.count} shards changed, ${Math.round(r.sentBytes / 1024)} KB sent`);
    }
    lastUpload = now;
    lastUploadHash = hash;
  } catch (e) { console.error(`[backup] snapshot failed (${b}):`, e.message); }
  finally { uploading = false; }
}

module.exports = { isEnabled, restore, snapshot, backend };
