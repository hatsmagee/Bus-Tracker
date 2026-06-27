#!/usr/bin/env node
// Proxy server for Hele-On Bus Tracker
// Forwards /proxy/* requests to myheleonbus.org/api/rtpi with CORS headers

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const UPSTREAM = 'myheleonbus.org';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Proxy /proxy?path=... -> https://myheleonbus.org/api/rtpi?path=...
  if (url.pathname === '/proxy') {
    const apiPath = url.searchParams.get('path') || '';
    const upstreamUrl = `/api/rtpi?path=${encodeURIComponent(apiPath)}`;

    const proxyReq = https.request({
      hostname: UPSTREAM,
      path: upstreamUrl,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://myheleonbus.org/' },
    }, (proxyRes) => {
      const headers = { ...corsHeaders(), 'Content-Type': 'application/json' };
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      res.writeHead(502, corsHeaders());
      res.end(JSON.stringify({ error: e.message }));
    });
    proxyReq.end();
    return;
  }

  // Serve static files from same directory
  let filePath = path.join(__dirname, url.pathname === '/' ? 'heleon-tracker.html' : url.pathname);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Hele-On Bus Tracker proxy running at http://localhost:${PORT}/`);
});
