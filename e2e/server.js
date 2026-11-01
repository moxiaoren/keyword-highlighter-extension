'use strict';
/* 本地静态服务器：把 fixtures/ 通过 http:// 提供（content_scripts 的 <all_urls> 不匹配 file://） */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/favicon.ico') {                 // 避免 404 噪声混进"页面无报错"断言
        res.writeHead(204).end();
        return;
      }
      const file = path.join(ROOT, urlPath === '/' ? 'list.html' : urlPath.replace(/^\/+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, origin: 'http://127.0.0.1:' + port }));
  });
}

module.exports = { start };
