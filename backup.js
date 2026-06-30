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
 *      The DB is committed (base64) to that path; restored from it on boot.
 *
 *   2. S3-compatible object store (Backblaze B2 / Cloudflare R2 / etc). Set:
 *        BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_KEY
 *        BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET BACKUP_S3_REGION (default us-east-1)
 *
 * The snapshot is the raw sql.js export (a normal SQLite file). Restore just
 * writes it to DB_PATH before openDb() reads it.
 */
const https = require('https');
const crypto = require('crypto');

// ── GitHub Contents API backend ────────────────────────────────────────────────
const GH_TOKEN  = process.env.BACKUP_GITHUB_TOKEN;
const GH_REPO   = process.env.BACKUP_GITHUB_REPO;
const GH_PATH   = process.env.BACKUP_GITHUB_PATH   || 'backups/heleon.db';
const GH_BRANCH = process.env.BACKUP_GITHUB_BRANCH || 'main';

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
function ghHeaders() {
  return {
    'Authorization': `Bearer ${GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'heleon-tracker-backup',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function ghGetSha() {
  const r = await req({
    hostname: 'api.github.com',
    path: `/repos/${GH_REPO}/contents/${encodeURIComponent(GH_PATH)}?ref=${GH_BRANCH}`,
    method: 'GET', headers: ghHeaders(),
  });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`github get ${r.status}: ${r.body.toString().slice(0, 120)}`);
  return JSON.parse(r.body.toString()).sha;
}
async function ghRestore() {
  const r = await req({
    hostname: 'api.github.com',
    path: `/repos/${GH_REPO}/contents/${encodeURIComponent(GH_PATH)}?ref=${GH_BRANCH}`,
    method: 'GET', headers: Object.assign(ghHeaders(), { 'Accept': 'application/vnd.github.raw' }),
  });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`github restore ${r.status}`);
  return r.body; // raw bytes
}
async function ghUpload(buf) {
  const sha = await ghGetSha().catch(() => null);
  const body = JSON.stringify({
    message: `db snapshot ${new Date().toISOString()}`,
    content: buf.toString('base64'),
    branch: GH_BRANCH,
    ...(sha ? { sha } : {}),
  });
  const r = await req({
    hostname: 'api.github.com',
    path: `/repos/${GH_REPO}/contents/${encodeURIComponent(GH_PATH)}`,
    method: 'PUT',
    headers: Object.assign(ghHeaders(), { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
  }, body);
  if (r.status !== 200 && r.status !== 201) throw new Error(`github put ${r.status}: ${r.body.toString().slice(0, 160)}`);
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
    const buf = b === 's3' ? await s3Restore() : await ghRestore();
    if (buf && buf.length > 0) { console.log(`[backup] restored ${Math.round(buf.length / 1024)} KB from ${b}`); return buf; }
    console.log(`[backup] no snapshot found in ${b} (fresh start)`);
    return null;
  } catch (e) { console.error(`[backup] restore failed (${b}):`, e.message); return null; }
}
let lastUpload = 0, uploading = false;
async function snapshot(buf, { force = false } = {}) {
  const b = backend();
  if (!b || uploading) return;
  // Throttle uploads (GitHub/S3 write quotas) — at most one every ~5 min unless forced.
  const now = Date.now();
  if (!force && now - lastUpload < 5 * 60 * 1000) return;
  uploading = true;
  try {
    if (b === 's3') await s3Upload(buf); else await ghUpload(buf);
    lastUpload = now;
    console.log(`[backup] snapshot uploaded to ${b} (${Math.round(buf.length / 1024)} KB)`);
  } catch (e) { console.error(`[backup] snapshot failed (${b}):`, e.message); }
  finally { uploading = false; }
}

module.exports = { isEnabled, restore, snapshot, backend };
