#!/usr/bin/env node
'use strict';

/**
 * 本地开发用的前端服务器：托管 frontend/ 静态资源，并把 /api 转发给后端。
 *
 * 为什么需要它：后端按"前后端分离"的要求只提供 /api，不再托管静态资源；
 * 而前端用的是同源相对路径（/api/xxx）。如果直接用一个纯静态服务器
 * （例如 python -m http.server 5500）打开前端，请求会打到 5500 上而不是后端。
 * 这个脚本把两者拼在一起，本地开发也能保持"同源"，
 * 于是既不需要配 CORS，也不需要改前端代码。
 *
 * 用法：
 *   node tools/serve-frontend.js                 # 前端 5500，后端 127.0.0.1:3000
 *   node tools/serve-frontend.js --port 8080
 *   node tools/serve-frontend.js --backend 127.0.0.1:3000
 *   FRONTEND_PORT=8080 node tools/serve-frontend.js
 *
 * 只依赖 Node 内置模块，不需要 npm install。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'frontend');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(argValue('--port', process.env.FRONTEND_PORT || 5500));
const BACKEND = argValue('--backend', process.env.BACKEND_ADDR || '127.0.0.1:3000');
const [BACKEND_HOST, BACKEND_PORT] = BACKEND.split(':');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 把 /api/** 原样转发给后端，保留方法、请求头与请求体。 */
function proxy(req, res) {
  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  const upstream = http.request(
    { host: BACKEND_HOST, port: BACKEND_PORT, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        code: 9002,
        message: `无法连接后端 ${BACKEND}（${err.code || err.message}）。请确认后端已启动：bash tools/run-backend.sh`,
        data: null,
      })
    );
  });
  req.pipe(upstream);
}

/** 静态文件；路径不存在或越界时回落到 index.html（前端是单页应用）。 */
async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.resolve(ROOT, '.' + urlPath);

  // 防目录穿越：解析后必须仍在 frontend/ 之内
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    stat = null;
  }
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = await fsp.stat(filePath).catch(() => null);
  }
  if (!stat) {
    filePath = path.join(ROOT, 'index.html');
    stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) {
      res.writeHead(404).end('frontend/index.html not found');
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    proxy(req, res);
    return;
  }
  serveStatic(req, res).catch((err) => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务器内部错误：' + err.message);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`前端已启动： http://127.0.0.1:${PORT}`);
  console.log(`静态资源目录： ${ROOT}`);
  console.log(`/api 转发到：  http://${BACKEND}`);
  console.log('');
  console.log('请确认后端已在运行（另开一个终端）： bash tools/run-backend.sh');
  console.log('按 Ctrl + C 停止。');
});
