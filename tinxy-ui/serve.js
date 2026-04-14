const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const BASE = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
};

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src https://backend.tinxy.in",
    "style-src 'self'",
    "script-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

http.createServer((req, res) => {
  // Strip query string and decode URI
  let rawPath;
  try {
    rawPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  const urlPath  = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.normalize(path.join(BASE, urlPath));

  // Block path traversal: resolved path must stay within BASE
  if (!filePath.startsWith(BASE + path.sep) && filePath !== BASE) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath);

  // Only serve whitelisted file extensions
  if (!MIME[ext]) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], ...SECURITY_HEADERS });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Dudu Life Control running on http://localhost:${PORT}`));
