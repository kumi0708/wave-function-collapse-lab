// README 用の図を書き出すための小さな静的サーバー
//   node tools/figure-server.js  →  http://localhost:8790/tools/figures.html?run=1
// figures.html が POST /save?name=xxx.png で送った画像を docs/images/ に保存する。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'images');
fs.mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.json': 'application/json' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/save') {
    const name = u.searchParams.get('name') || '';
    if (!/^[\w.-]+\.(png|jpg|gif|webp)$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      fs.writeFileSync(path.join(out, name), buf);
      console.log(`saved ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
      res.end('ok');
    });
    return;
  }
  let p = path.join(root, decodeURIComponent(u.pathname));
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(+process.env.FIG_PORT || 8790, () => console.log('figure server on', +process.env.FIG_PORT || 8790));
