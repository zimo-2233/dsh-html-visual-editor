import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../..', import.meta.url)));
const port = Number(process.argv[3] || 8977);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json'};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let target = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || url.pathname === '/index.html') target = path.join(root, 'dsh-html-visual-editor/test/browser/bridge-harness.html');
  if (url.pathname === '/demo.html') target = path.join(root, 'html-visual-editor-demo.html');
  if (url.pathname === '/engine.browser.js') target = path.join(root, 'dsh-html-visual-editor/test/browser/engine.browser.js');
  if (url.pathname === '/engine.browser.0.1.0.js') target = path.join(root, 'dsh-html-visual-editor/test/browser/engine.browser.0.1.0.js');
  if (!target.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(target, (error, data) => {
    if (error) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(data);
  });
});
server.listen(port, '127.0.0.1', () => console.log('harness server: http://127.0.0.1:' + port + '/'));
