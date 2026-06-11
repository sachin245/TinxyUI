/**
 * Dudu Life Control server
 *
 * Static file server + a thin reverse proxy to the Tinxy cloud API.
 *
 * Auth model: the browser holds the user's Tinxy API token (saved in
 * localStorage) and sends it as `Authorization: Bearer <token>` on every
 * request. This server simply forwards that header to backend.tinxy.in —
 * it does not store any token of its own. The proxy exists only to avoid
 * cross-origin (CORS) issues and to keep a strict `connect-src 'self'` CSP.
 *
 * Env vars:
 *   PORT   listen port (default 3456)
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');

const BASE = __dirname;

// ── .env loader (zero-dependency) ─────────────────────────────────────────────
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(BASE, '.env'));
loadEnvFile(path.join(BASE, '..', '.env'));

const PORT       = process.env.PORT || 3456;
const TINXY_BASE = 'https://backend.tinxy.in';

// ── Static file config ────────────────────────────────────────────────────────
const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json':        'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.json']);
// HTML and the service worker must always revalidate so deploys roll out promptly.
const NO_CACHE = new Set(['/index.html', '/sw.js']);

function securityHeaders(req) {
  const headers = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'self'",
      "connect-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };
  if (isSecure(req))
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJson(req, res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...securityHeaders(req),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── Tinxy API proxy ───────────────────────────────────────────────────────────
// Forwards the client's own Authorization header to Tinxy. The server holds no
// token; an absent/invalid token simply yields Tinxy's own 401/403 response.
async function handleApiProxy(req, res, pathname, search) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Method not allowed' }); return;
  }

  const auth = req.headers['authorization'] || '';
  if (!/^Bearer\s+.+/i.test(auth)) {
    sendJson(req, res, 401, { error: 'Missing API token' }); return;
  }

  const upstreamPath = pathname.slice('/api'.length);
  if (!upstreamPath.startsWith('/v2/')) {
    sendJson(req, res, 403, { error: 'Forbidden path' }); return;
  }

  let body;
  if (req.method === 'POST') {
    try { body = await readBody(req); }
    catch { sendJson(req, res, 413, { error: 'Body too large' }); return; }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch(`${TINXY_BASE}${upstreamPath}${search}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body,
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      ...securityHeaders(req),
    });
    res.end(text);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    sendJson(req, res, 502, { error: timedOut ? 'Tinxy backend timed out' : 'Tinxy backend unreachable' });
  } finally {
    clearTimeout(timer);
  }
}

// ── Static files ──────────────────────────────────────────────────────────────
function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders(req)); res.end('Method not allowed'); return;
  }

  const urlPath  = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(BASE, urlPath));

  // Block path traversal: resolved path must stay within BASE
  if (!filePath.startsWith(BASE + path.sep) && filePath !== BASE) {
    res.writeHead(403, securityHeaders(req)); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);
  if (!MIME[ext]) {
    res.writeHead(403, securityHeaders(req)); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, securityHeaders(req)); res.end('Not found'); return; }

    const etag = `"${crypto.createHash('sha1').update(data).digest('hex')}"`;
    const cacheControl = NO_CACHE.has(urlPath)
      ? 'no-cache'
      : 'public, max-age=300, must-revalidate';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl, ...securityHeaders(req) });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': MIME[ext],
      'ETag': etag,
      'Cache-Control': cacheControl,
      ...securityHeaders(req),
    };

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    let payload = data;
    if (acceptsGzip && COMPRESSIBLE.has(ext) && data.length > 512) {
      payload = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : payload);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  let pathname, search;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname  = decodeURIComponent(url.pathname);
    search    = url.search;
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  if (pathname === '/healthz') { sendJson(req, res, 200, { ok: true }); return; }
  if (pathname.startsWith('/api/')) { handleApiProxy(req, res, pathname, search); return; }
  handleStatic(req, res, pathname);
}).listen(PORT, () => console.log(`Dudu Life Control running on http://localhost:${PORT}`));
