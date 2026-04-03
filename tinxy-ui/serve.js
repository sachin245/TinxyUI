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

http.createServer((req, res) => {
  let filePath = path.join(BASE, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Tinxy UI running on http://localhost:${PORT}`));
