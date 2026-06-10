/**
 * Dudu Life Control server
 *
 * Static file server + authenticated proxy to the Tinxy cloud API.
 * The Tinxy bearer token lives ONLY here (env: TINXY_API_TOKEN) — the
 * browser authenticates with a shared password (env: UI_PASSWORD) and
 * gets a signed, HttpOnly session cookie.
 *
 * Env vars:
 *   PORT             listen port                      (default 3456)
 *   TINXY_API_TOKEN  Tinxy bearer token               (required for /api)
 *   UI_PASSWORD      shared dashboard password        (required for login)
 *   SESSION_SECRET   HMAC key for session cookies     (random per boot if unset)
 *
 * Vars can also be placed in a .env file next to this file or at the
 * repo root (KEY=VALUE lines) — handy for the Pi/EC2 PM2 deployments.
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

const PORT           = process.env.PORT || 3456;
const TINXY_BASE     = 'https://backend.tinxy.in';
const API_TOKEN      = process.env.TINXY_API_TOKEN || '';
const UI_PASSWORD    = process.env.UI_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME    = 'tinxy_session';

if (!API_TOKEN)   console.warn('[warn] TINXY_API_TOKEN not set — /api proxy disabled');
if (!UI_PASSWORD) console.warn('[warn] UI_PASSWORD not set — login disabled');
if (!process.env.SESSION_SECRET)
  console.warn('[warn] SESSION_SECRET not set — sessions reset on every restart');

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

// ── Session cookies ───────────────────────────────────────────────────────────
function signExpiry(exp) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
}

function makeSessionCookie(req) {
  const exp   = Date.now() + SESSION_TTL_MS;
  const value = `${exp}.${signExpiry(exp)}`;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function hasValidSession(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return false;
  const [expStr, sig] = match.slice(COOKIE_NAME.length + 1).split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const expected = signExpiry(exp);
  return sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function passwordMatches(candidate) {
  if (!UI_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(UI_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Login rate limiting (per IP) ──────────────────────────────────────────────
const LOGIN_WINDOW_MS  = 15 * 60 * 1000;
const LOGIN_MAX_TRIES  = 10;
const loginAttempts    = new Map(); // ip → { count, resetAt }

function loginThrottled(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_TRIES;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
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
async function handleApiProxy(req, res, pathname, search) {
  if (!hasValidSession(req)) { sendJson(req, res, 401, { error: 'Not logged in' }); return; }
  if (!API_TOKEN)            { sendJson(req, res, 503, { error: 'Server missing TINXY_API_TOKEN' }); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Method not allowed' }); return;
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
        'Authorization': `Bearer ${API_TOKEN}`,
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

// ── Auth endpoints ────────────────────────────────────────────────────────────
async function handleAuth(req, res, pathname) {
  if (pathname === '/auth/check' && req.method === 'GET') {
    if (hasValidSession(req)) sendJson(req, res, 200, { ok: true });
    else sendJson(req, res, 401, { error: 'Not logged in' });
    return;
  }

  if (pathname === '/auth/login' && req.method === 'POST') {
    if (!UI_PASSWORD) { sendJson(req, res, 503, { error: 'Server missing UI_PASSWORD' }); return; }
    if (loginThrottled(clientIp(req))) {
      sendJson(req, res, 429, { error: 'Too many attempts — try again in a few minutes' });
      return;
    }
    let password = '';
    try { password = String(JSON.parse(await readBody(req)).password ?? ''); }
    catch { sendJson(req, res, 400, { error: 'Invalid request' }); return; }

    if (!passwordMatches(password)) {
      sendJson(req, res, 401, { error: 'Incorrect password' });
      return;
    }
    sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': makeSessionCookie(req) });
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  sendJson(req, res, 404, { error: 'Not found' });
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
  if (pathname.startsWith('/auth/')) { handleAuth(req, res, pathname); return; }
  if (pathname.startsWith('/api/'))  { handleApiProxy(req, res, pathname, search); return; }
  handleStatic(req, res, pathname);
}).listen(PORT, () => console.log(`Dudu Life Control running on http://localhost:${PORT}`));
