'use strict';

const https = require('https');

const GH_TOKEN = () => process.env.AGENT_GITHUB_TOKEN || process.env.BACKUP_GITHUB_TOKEN;
const GH_REPO = () => process.env.AGENT_GITHUB_REPO || process.env.BACKUP_GITHUB_REPO || 'hatsmagee/Bus-Tracker';
const GH_BRANCH = () => process.env.AGENT_GITHUB_BRANCH || process.env.BACKUP_GITHUB_BRANCH || 'main';

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${GH_TOKEN()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'heleon-tracker-agent',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: text, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(90000, () => { r.destroy(); reject(new Error('github timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

function ghReq(method, apiPath, body) {
  const payload = body ? JSON.stringify(body) : null;
  return req({
    hostname: 'api.github.com',
    path: apiPath,
    method,
    headers: {
      ...ghHeaders(),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
  }, payload);
}

function isConfigured() {
  return !!(GH_TOKEN() && GH_REPO());
}

async function getRefSha(ref = `heads/${GH_BRANCH()}`) {
  const r = await ghReq('GET', `/repos/${GH_REPO()}/git/ref/${ref}`);
  if (r.status !== 200) throw new Error(`github getRef ${r.status}: ${r.body.slice(0, 160)}`);
  return r.json.object.sha;
}

async function createBranch(branchName, fromSha) {
  const r = await ghReq('POST', `/repos/${GH_REPO()}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`github createBranch ${r.status}: ${r.body.slice(0, 160)}`);
  }
  return r.json;
}

async function getFileSha(filePath, branch) {
  const r = await ghReq('GET', `/repos/${GH_REPO()}/contents/${encodeURIComponent(filePath)}?ref=${branch}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`github getFile ${r.status}: ${r.body.slice(0, 160)}`);
  return r.json.sha;
}

async function putFileOnBranch(filePath, contentBuf, { branch, message }) {
  const sha = await getFileSha(filePath, branch).catch(() => null);
  const body = {
    message,
    content: contentBuf.toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  };
  const r = await ghReq('PUT', `/repos/${GH_REPO()}/contents/${encodeURIComponent(filePath)}`, body);
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`github putFile ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return r.json;
}

async function openPR({ branch, title, body }) {
  const r = await ghReq('POST', `/repos/${GH_REPO()}/pulls`, {
    title,
    head: branch,
    base: GH_BRANCH(),
    body: body || '',
  });
  if (r.status !== 201) throw new Error(`github openPR ${r.status}: ${r.body.slice(0, 200)}`);
  return r.json;
}

async function mergePR(prNumber, { commitTitle, commitMessage } = {}) {
  const r = await ghReq('PUT', `/repos/${GH_REPO()}/pulls/${prNumber}/merge`, {
    merge_method: 'squash',
    commit_title: commitTitle,
    commit_message: commitMessage,
  });
  if (r.status !== 200) throw new Error(`github mergePR ${r.status}: ${r.body.slice(0, 200)}`);
  return r.json;
}

async function deleteBranch(branchName) {
  const r = await ghReq('DELETE', `/repos/${GH_REPO()}/git/refs/heads/${branchName}`);
  if (r.status !== 204 && r.status !== 200) {
    console.warn(`[github] deleteBranch ${branchName} ${r.status}: ${r.body.slice(0, 120)}`);
  }
}

async function getRawFile(filePath, ref = GH_BRANCH()) {
  const r = await ghReq('GET', `/repos/${GH_REPO()}/contents/${encodeURIComponent(filePath)}?ref=${ref}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`github getRaw ${r.status}`);
  const j = r.json;
  if (j.content) return Buffer.from(j.content, j.encoding || 'base64');
  return null;
}

async function postDeployHook() {
  const hook = process.env.RENDER_DEPLOY_HOOK;
  if (!hook) return { ok: false, skipped: true };
  const u = new URL(hook);
  const r = await req({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': 0 } });
  return { ok: r.status >= 200 && r.status < 300, status: r.status };
}

function stagingBranchName() {
  return `agent/staging-${Date.now()}`;
}

module.exports = {
  isConfigured,
  getRefSha,
  createBranch,
  putFileOnBranch,
  openPR,
  mergePR,
  deleteBranch,
  getRawFile,
  postDeployHook,
  stagingBranchName,
  GH_REPO,
  GH_BRANCH,
};
