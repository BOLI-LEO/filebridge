'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const qrcodeLib = require('qrcode-generator');

const files = require('./files');
const { createSync } = require('./sync');
const { TunnelManager } = require('./tunnel');
const docPreview = require('./doc-preview');

const APP_NAME = 'FileBridge';
const VERSION = require('../package.json').version;
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_CLIPBOARD_ITEMS = 50;
const MAX_CLIPBOARD_TEXT = 100 * 1024;
const MAX_TREE_FILES = 40000;

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; base-uri 'none'",
};

function nowIso() {
  return new Date().toISOString();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function lanAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      result.push({ iface, ip: item.address });
    }
  }
  return result;
}

function addressKind(ip) {
  return /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip) ? 'tailscale' : 'lan';
}

function scoreAddress({ iface, ip }) {
  if (/^169\.254\./.test(ip)) return -2;
  if (addressKind(ip) === 'tailscale') return 0;
  if (/^(utun|tun|tap|bridge|vmnet|vboxnet|docker|veth|llw|awdl|anpi|zt)/i.test(iface)) return -1;
  if (/^192\.168\./.test(ip)) return 3;
  if (/^10\./.test(ip)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 1;
}

function pickPrimaryAddress() {
  const list = lanAddresses()
    .map((item) => ({ ...item, score: scoreAddress(item) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return list[0] || null;
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function makeQrSvg(text) {
  try {
    const qr = qrcodeLib(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: '扫码访问' });
  } catch (error) {
    return '';
  }
}

function readJsonBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(files.badRequest('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(files.badRequest('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error && error.status ? error.status : 500;
  const message = error && error.message ? error.message : '服务器内部错误';
  if (status >= 500) console.error('[filebridge]', error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { ok: false, error: message });
}

function rangeHeader(req, size) {
  const raw = req.headers.range;
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(raw).trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === '' && match[2] === '') return { invalid: true };
  if (match[1] === '') {
    // suffix range: bytes=-500
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    if (start > end) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  if (start >= size) return { invalid: true };
  return { start, end };
}

function streamFile(req, res, abs, { inline = false, contentType } = {}) {
  const stat = fs.statSync(abs);
  const total = stat.size;
  const type = contentType || files.mimeOf(abs);
  const name = path.basename(abs);
  const disposition = inline ? 'inline' : 'attachment';

  const headers = {
    'Content-Type': type,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeRFC5987(name)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  };

  const range = rangeHeader(req, total);
  if (range && range.invalid) {
    res.writeHead(416, {
      'Content-Range': `bytes */${total}`,
      ...SECURITY_HEADERS,
    });
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    headers['Content-Length'] = end - start + 1;
    if (req.method === 'HEAD') {
      res.writeHead(206, headers);
      res.end();
      return;
    }
    res.writeHead(206, headers);
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  headers['Content-Length'] = total;
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(abs);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function createServer(options) {
  const {
    store,
    rendererDir,
    assetsDir,
    isElectron = false,
    onOpenFolder = null,
    onOpenPath = null,
    onFloatWindow = null,
    cloudflaredPaths = [],
    log = (...args) => console.log(...args),
  } = options;

  const startedAt = Date.now();
  const clients = new Set();
  let sync = null;
  let server = null;
  let wss = null;
  let heartbeat = null;
  let watcher = null;
  let actualPort = 0;
  let tunnel = null;

  const transfers = [];
  const receivedRecently = new Map();

  const clipboard = loadClipboard(store.clipboardFile);

  function loadClipboard(file) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_CLIPBOARD_ITEMS);
    } catch {
      /* ignore */
    }
    return [];
  }

  function persistClipboard() {
    try {
      fs.writeFileSync(store.clipboardFile, JSON.stringify(clipboard, null, 2));
    } catch (error) {
      log(`[filebridge] 保存剪贴板失败: ${error.message}`);
    }
  }

  function broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const item of clients) {
      if (item.socket.readyState === 1) {
        try {
          item.socket.send(text);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function recordTransfer(rel, size, source) {
    const now = Date.now();
    const existing = transfers.find(
      (item) => item.path === rel && item.size === size && now - item.createdAt < 15 * 60 * 1000,
    );
    if (existing) return existing;
    const item = {
      id: crypto.randomUUID(),
      path: rel,
      name: path.basename(rel),
      size: Number(size) || 0,
      createdAt: now,
      state: 'saved',
      confirmedBy: [],
      source,
    };
    transfers.unshift(item);
    while (transfers.length > 60) transfers.pop();
    broadcast({ type: 'transfer', item });
    return item;
  }

  function confirmTransfer(rel, size, device) {
    if (!rel) return null;
    const item = transfers.find(
      (entry) => entry.path === rel && (size == null || !size || entry.size === size),
    );
    if (!item) return null;
    const id = device && device.id ? device.id : 'peer';
    if (!item.confirmedBy.some((entry) => entry.id === id)) {
      item.confirmedBy.push({ id, name: (device && device.name) || '对端设备', ts: Date.now() });
    }
    item.state = 'confirmed';
    broadcast({ type: 'transfer', item });
    return item;
  }

  function isRecentlyReceived(rel) {
    const ts = receivedRecently.get(rel);
    return Boolean(ts && Date.now() - ts < 15000);
  }

  function markReceived(rel) {
    receivedRecently.set(rel, Date.now());
    if (receivedRecently.size > 600) {
      const cutoff = Date.now() - 60000;
      for (const [key, ts] of receivedRecently) {
        if (ts < cutoff) receivedRecently.delete(key);
      }
    }
  }

  function isAuthorized(req, urlObj) {
    const code = store.get('accessCode');
    if (!code) return true;
    const provided =
      (req.headers['x-access-code'] || '') ||
      (urlObj && urlObj.searchParams.get('code')) ||
      parseCookie(req.headers.cookie || '').fb_code ||
      '';
    return safeEqual(provided, code);
  }

  function currentUrl() {
    const primary = pickPrimaryAddress();
    const ip = primary ? primary.ip : '127.0.0.1';
    const code = store.get('accessCode');
    const base = `http://${ip}:${actualPort}`;
    return code ? `${base}/?code=${encodeURIComponent(code)}` : `${base}/`;
  }

  function infoPayload(urlObj) {
    const code = store.get('accessCode');
    const addresses = lanAddresses()
      .map((item) => ({ ...item, kind: addressKind(item.ip), score: scoreAddress(item) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);
    const primary = addresses[0] || null;
    let chosenIp = primary ? primary.ip : '127.0.0.1';
    const requested = urlObj && urlObj.searchParams.get('address');
    if (requested && addresses.some((item) => item.ip === requested)) chosenIp = requested;
    const base = `http://${chosenIp}:${actualPort}`;
    const displayUrl = code ? `${base}/?code=${encodeURIComponent(code)}` : `${base}/`;
    const tunnelStatus = tunnel ? tunnel.getStatus() : null;
    const publicUrl = tunnelStatus && tunnelStatus.running ? tunnel.pickPublicUrl() : '';
    // 二维码/分享地址优先用局域网（速度最快），没有局域网地址时才回落到公网隧道
    const hasLan = addresses.some((item) => item.kind === 'lan');
    const shareUrl = !hasLan && publicUrl
      ? (code ? `${publicUrl}/?code=${encodeURIComponent(code)}` : `${publicUrl}/`)
      : displayUrl;
    const shareUrlPublic = publicUrl
      ? (code ? `${publicUrl}/?code=${encodeURIComponent(code)}` : `${publicUrl}/`)
      : '';

    return {
      ok: true,
      app: { name: APP_NAME, version: VERSION },
      device: {
        id: store.get('deviceId'),
        name: store.get('deviceName'),
        platform: process.platform,
        hostname: os.hostname(),
        isElectron,
      },
      server: {
        port: actualPort,
        uri: base,
        url: displayUrl,
        publicUrl,
        shareUrl,
        shareUrlPublic,
        addresses,
        root: store.get('root'),
        startedAt,
        uptime: Date.now() - startedAt,
        version: VERSION,
      },
      auth: { required: Boolean(code), authenticated: true },
      sync: {
        enabled: Boolean(store.get('autoSync')),
        peers: sync ? sync.list() : [],
      },
      delivery: store.get('delivery'),
      projects: store.get('projects'),
      inbox: store.get('inbox'),
      clipboard: { count: clipboard.length },
      transfers: transfers.slice(0, 30),
      tunnel: tunnelStatus,
      qr: {
        svg: makeQrSvg(shareUrl),
        url: shareUrl,
      },
    };
  }

  function parseCookie(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
  }

  function setCodeCookie(res) {
    const code = store.get('accessCode');
    if (!code) return;
    res.setHeader(
      'Set-Cookie',
      `fb_code=${encodeURIComponent(code)}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
  }

  // ---------- 静态文件 ----------
  function serveStatic(req, res, urlObj) {
    let pathname = decodeURIComponent(urlObj.pathname);
    if (pathname === '/') pathname = '/index.html';

    if (urlObj.searchParams.get('code') && store.get('accessCode')) {
      if (safeEqual(urlObj.searchParams.get('code'), store.get('accessCode'))) setCodeCookie(res);
    }

    let abs;
    if (pathname.startsWith('/assets/')) {
      abs = path.join(assetsDir, pathname.slice('/assets/'.length));
    } else {
      abs = path.join(rendererDir, pathname.slice(1));
    }
    const baseDir = pathname.startsWith('/assets/') ? assetsDir : rendererDir;
    const relative = path.relative(baseDir, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      sendJson(res, 403, { ok: false, error: '禁止访问' });
      return;
    }

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      sendJson(res, 404, { ok: false, error: '资源不存在' });
      return;
    }
    if (stat.isDirectory()) {
      abs = path.join(abs, 'index.html');
      if (!fs.existsSync(abs)) {
        sendJson(res, 404, { ok: false, error: '资源不存在' });
        return;
      }
    }

    const ext = path.extname(abs).toLowerCase();
    const headers = {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    };
    if (ext === '.html') {
      // 页面本身不缓存 Cookie 设置之外的内容
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  // ---------- API ----------
  async function handleApi(req, res, urlObj) {
    const pathname = urlObj.pathname;

    if (pathname === '/api/auth' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const code = store.get('accessCode');
      if (!code) {
        sendJson(res, 200, { ok: true, required: false });
        return;
      }
      if (!safeEqual(String(body.code || ''), code)) {
        sendJson(res, 401, { ok: false, error: '访问口令不正确' });
        return;
      }
      setCodeCookie(res);
      sendJson(res, 200, { ok: true, required: true });
      return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      const code = store.get('accessCode');
      if (code && !isAuthorized(req, urlObj)) {
        sendJson(res, 200, {
          ok: true,
          app: { name: APP_NAME, version: VERSION },
          device: { name: store.get('deviceName') },
          auth: { required: true, authenticated: false },
          qr: { svg: '', url: '' },
        });
        return;
      }
      sendJson(res, 200, infoPayload());
      return;
    }

    if (!isAuthorized(req, urlObj)) {
      sendJson(res, 401, { ok: false, error: '需要访问口令' });
      return;
    }

    if (pathname === '/api/list' && req.method === 'GET') {
      const rel = urlObj.searchParams.get('path') || '';
      const result = files.listDir(store.get('root'), rel);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/tree' && req.method === 'GET') {
      const list = files.walkFiles(store.get('root'), { limit: MAX_TREE_FILES });
      sendJson(res, 200, {
        ok: true,
        files: list,
        truncated: list.length >= MAX_TREE_FILES,
        tombstones: sync ? sync.getTombstones() : [],
      });
      return;
    }

    if (pathname === '/api/mkdir' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const parent = files.resolveInside(store.get('root'), body.path || '');
      const name = files.sanitizeName(body.name || '新建文件夹');
      if (!name) throw files.badRequest('文件夹名不合法');
      const target = path.join(parent, name);
      if (fs.existsSync(target)) throw files.badRequest('同名文件夹或文件已存在', 409);
      fs.mkdirSync(target);
      sendJson(res, 200, { ok: true, entry: files.entryFor(store.get('root'), target, name) });
      return;
    }

    if (pathname === '/api/rename' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const abs = files.resolveInside(store.get('root'), body.path || '');
      if (abs === path.resolve(store.get('root'))) throw files.badRequest('不能重命名根目录');
      const name = files.sanitizeName(body.name || '');
      if (!name) throw files.badRequest('名称不合法');
      const target = path.join(path.dirname(abs), name);
      if (fs.existsSync(target) && target !== abs) throw files.badRequest('同名文件已存在', 409);
      const oldRel = files.relOf(store.get('root'), abs);
      fs.renameSync(abs, target);
      if (sync) sync.recordTombstones([oldRel]);
      sendJson(res, 200, {
        ok: true,
        entry: files.entryFor(store.get('root'), target, name),
      });
      return;
    }

    if (pathname === '/api/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const root = path.resolve(store.get('root'));
      let deleted = 0;
      const deletedPaths = [];
      for (const rel of paths) {
        let abs;
        try {
          abs = files.resolveInside(root, rel);
        } catch {
          continue;
        }
        if (abs === root) continue;
        try {
          fs.rmSync(abs, { recursive: true, force: true });
          deleted += 1;
          deletedPaths.push(rel);
        } catch (error) {
          throw files.badRequest(`删除失败: ${error.message}`);
        }
      }
      if (deletedPaths.length && sync) {
        sync.recordTombstones(deletedPaths);
        sync.announceAll();
      }
      sendJson(res, 200, { ok: true, deleted });
      return;
    }

    if (pathname === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) {
      handleUpload(req, res, urlObj);
      return;
    }

    if (pathname === '/api/upload-chunk' && req.method === 'POST') {
      handleChunkUpload(req, res, urlObj);
      return;
    }

    if (pathname === '/api/download' && (req.method === 'GET' || req.method === 'HEAD')) {
      const abs = files.resolveInside(store.get('root'), urlObj.searchParams.get('path') || '');
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw files.badRequest('文件不存在', 404);
      }
      if (stat.isDirectory()) throw files.badRequest('不能直接下载文件夹，请打包后再试', 400);
      streamFile(req, res, abs, { inline: false });
      return;
    }

    if (pathname === '/api/preview' && (req.method === 'GET' || req.method === 'HEAD')) {
      const abs = files.resolveInside(store.get('root'), urlObj.searchParams.get('path') || '');
      let descriptor;
      try {
        descriptor = files.previewDescriptor(store.get('root'), urlObj.searchParams.get('path') || '');
      } catch (error) {
        throw error;
      }
      if (descriptor.kind === 'text') {
        const content = files.readTextPreview(descriptor.abs);
        const body = Buffer.from(content);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      streamFile(req, res, descriptor.abs, { inline: true, contentType: descriptor.mime });
      return;
    }

    if (pathname === '/api/doc-preview' && req.method === 'GET') {
      const rel = urlObj.searchParams.get('path') || '';
      const abs = files.resolveInside(store.get('root'), rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw files.badRequest('文件不存在', 404);
      }
      if (stat.isDirectory()) throw files.badRequest('文件夹无法预览');
      const preview = await docPreview.buildPreview(abs);
      sendJson(res, 200, { ok: true, preview });
      return;
    }

    if (pathname === '/api/open-file' && req.method === 'POST') {
      if (!onOpenPath) throw files.badRequest('当前环境不支持用系统应用打开', 400);
      const body = await readJsonBody(req);
      const abs = files.resolveInside(store.get('root'), body.path || '');
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw files.badRequest('文件不存在', 404);
      }
      if (stat.isDirectory()) throw files.badRequest('文件夹无法用系统应用打开');
      await onOpenPath(abs);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/clipboard' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, items: clipboard });
      return;
    }

    if (pathname === '/api/clipboard' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body.text || '').slice(0, MAX_CLIPBOARD_TEXT);
      if (!text.trim()) throw files.badRequest('内容不能为空');
      const item = {
        id: crypto.randomUUID(),
        text,
        ts: Date.now(),
        device: store.get('deviceName'),
      };
      clipboard.unshift(item);
      while (clipboard.length > MAX_CLIPBOARD_ITEMS) clipboard.pop();
      persistClipboard();
      broadcast({ type: 'clipboard', item, items: clipboard });
      sendJson(res, 200, { ok: true, item, items: clipboard });
      return;
    }

    if (pathname === '/api/clipboard' && req.method === 'DELETE') {
      const id = urlObj.searchParams.get('id');
      const before = clipboard.length;
      for (let i = clipboard.length - 1; i >= 0; i -= 1) {
        if (clipboard[i].id === id) clipboard.splice(i, 1);
      }
      if (clipboard.length !== before) {
        persistClipboard();
        broadcast({ type: 'clipboard', items: clipboard });
      }
      sendJson(res, 200, { ok: true, items: clipboard });
      return;
    }

    if (pathname === '/api/delivery' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        delivery: store.get('delivery'),
        inbox: store.get('inbox'),
        projects: store.get('projects'),
      });
      return;
    }

    if (pathname === '/api/delivery' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const root = path.resolve(store.get('root'));
      const target = files.cleanRel(body.path || '').replace(/^\/+|\/+$/g, '');
      const abs = files.resolveInside(root, target);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw files.badRequest('目录不存在', 404);
      }
      if (!stat.isDirectory()) throw files.badRequest('目标不是文件夹');
      store.update({ delivery: { path: target, quick: body.quick === true } });
      broadcast({ type: 'delivery', delivery: store.get('delivery') });
      sendJson(res, 200, { ok: true, delivery: store.get('delivery') });
      return;
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, projects: store.get('projects') });
      return;
    }

    if (pathname === '/api/projects' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const root = path.resolve(store.get('root'));
      const incoming = Array.isArray(body.projects) ? body.projects : [];
      const projects = [];
      for (const item of incoming) {
        const rel = files.cleanRel(item).replace(/^\/+|\/+$/g, '');
        if (!rel || rel.includes('..') || projects.includes(rel)) continue;
        try {
          if (fs.statSync(files.resolveInside(root, rel)).isDirectory()) projects.push(rel);
        } catch {
          /* ignore */
        }
        if (projects.length >= 20) break;
      }
      store.update({ projects });
      broadcast({ type: 'projects', projects });
      sendJson(res, 200, { ok: true, projects });
      return;
    }

    if (pathname === '/api/tree-dirs' && req.method === 'GET') {
      const dirs = files.walkDirs(store.get('root'), { limit: 4000 });
      sendJson(res, 200, { ok: true, dirs });
      return;
    }

    if (pathname === '/api/move' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const root = path.resolve(store.get('root'));
      const toRel = body.to !== undefined ? files.cleanRel(body.to) : store.get('delivery').path;
      const toAbs = files.resolveInside(root, toRel);
      let stat;
      try {
        stat = fs.statSync(toAbs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) throw files.badRequest('目标文件夹不存在', 404);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const moved = [];
      for (const rel of paths) {
        let abs;
        try {
          abs = files.resolveInside(root, rel);
        } catch {
          continue;
        }
        if (abs === root) continue;
        if (abs === toAbs) continue;
        if (toAbs.startsWith(abs + path.sep)) throw files.badRequest('不能移动到自身目录');
        try {
          if (!fs.statSync(abs)) continue;
        } catch {
          continue;
        }
        const dest = files.uniquePath(toAbs, path.basename(abs));
        fs.renameSync(abs, dest);
        moved.push(files.entryFor(root, dest, path.basename(dest)));
      }
      sendJson(res, 200, { ok: true, moved });
      return;
    }

    if (pathname === '/api/transfers' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, items: transfers });
      return;
    }

    if (pathname === '/api/sync/ack' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const item = confirmTransfer(files.cleanRel(body.path || ''), Number(body.size), {
        id: String(body.deviceId || ''),
        name: String(body.deviceName || ''),
      });
      sendJson(res, 200, { ok: true, item });
      return;
    }

    if (pathname === '/api/tunnel' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, tunnel: tunnel ? tunnel.getStatus() : null });
      return;
    }

    if (pathname === '/api/tunnel' && req.method === 'POST') {
      if (!tunnel) throw files.badRequest('当前环境不支持隧道', 400);
      const body = await readJsonBody(req);
      if (body.action === 'config') {
        sendJson(res, 200, { ok: true, tunnel: tunnel.updateConfig(body) });
        return;
      }
      if (body.action === 'start') {
        tunnel.updateConfig(body);
        sendJson(res, 200, { ok: true, tunnel: await tunnel.start() });
        return;
      }
      if (body.action === 'stop') {
        sendJson(res, 200, { ok: true, tunnel: await tunnel.stop() });
        return;
      }
      throw files.badRequest('未知的隧道操作');
    }

    if (pathname === '/api/peers/announce' && req.method === 'POST') {
      if (!sync) throw files.badRequest('同步未启用', 400);
      const body = await readJsonBody(req);
      const remoteIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '').trim();
      const bodyIp = String(body.ip || '').trim();
      const ip = remoteIp && remoteIp !== '127.0.0.1' && remoteIp !== '::1' ? remoteIp : bodyIp;
      const port = Number(body.port);
      if (!ip || !Number.isInteger(port) || port < 1 || port > 65535) throw files.badRequest('参数无效');
      const peer = sync.registerPeer({
        id: body.id,
        name: body.name,
        platform: body.platform,
        ip,
        httpPort: port,
        manual: true,
      });
      if (peer) {
        const saved = (store.get('manualPeers') || []).filter((item) => !(item.ip === ip && Number(item.port) === port));
        saved.push({ ip, port });
        store.update({ manualPeers: saved });
      }
      sendJson(res, 200, { ok: true, peer });
      return;
    }

    if (pathname === '/api/peers/scan' && req.method === 'POST') {
      if (!sync) throw files.badRequest('同步未启用', 400);
      const result = await sync.scanLan();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === '/api/peers/remove' && req.method === 'POST') {
      if (!sync) throw files.badRequest('同步未启用', 400);
      const body = await readJsonBody(req);
      const ip = String(body.ip || '').trim();
      const port = Number(body.port);
      sync.removePeer(ip, port);
      store.update({
        manualPeers: (store.get('manualPeers') || []).filter((item) => !(item.ip === ip && Number(item.port) === Number(port))),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/float-window' && req.method === 'POST') {
      if (!onFloatWindow) throw files.badRequest('仅桌面应用支持悬浮窗', 400);
      const body = await readJsonBody(req);
      const result = await onFloatWindow(String(body.action || 'toggle'));
      sendJson(res, 200, {
        ok: true,
        visible: Boolean(result && result.visible),
        expanded: Boolean(result && result.expanded),
        bounds: (result && result.bounds) || null,
      });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        settings: {
          deviceName: store.get('deviceName'),
          autoSync: store.get('autoSync'),
          accessCode: store.get('accessCode') ? '******' : '',
          port: actualPort,
          configuredPort: store.get('port'),
          syncPort: store.get('syncPort'),
          root: store.get('root'),
          delivery: store.get('delivery'),
          projects: store.get('projects'),
          inbox: store.get('inbox'),
          tunnel: tunnel ? tunnel.getStatus() : null,
        },
      });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.deviceName === 'string') patch.deviceName = body.deviceName;
      if (typeof body.autoSync === 'boolean') patch.autoSync = body.autoSync;
      if (typeof body.accessCode === 'string' && body.accessCode !== '******') {
        patch.accessCode = body.accessCode;
      }
      if (typeof body.root === 'string' && body.root.trim()) {
        const nextRoot = path.resolve(body.root.trim());
        let stat;
        try {
          stat = fs.statSync(nextRoot);
        } catch {
          throw files.badRequest('共享目录不存在', 404);
        }
        if (!stat.isDirectory()) throw files.badRequest('共享目录不是文件夹');
        try {
          fs.accessSync(nextRoot, fs.constants.W_OK);
        } catch {
          throw files.badRequest('共享目录没有写入权限', 403);
        }
        if (nextRoot !== path.resolve(store.get('root'))) {
          store.update({ root: nextRoot });
          try {
            fs.mkdirSync(path.join(nextRoot, store.get('inbox')), { recursive: true });
          } catch {
            /* ignore */
          }
          if (watcher) watcher.close();
          startWatcher();
          if (sync) sync.announce();
        }
      }
      store.update(patch);
      if (sync) {
        sync.announce();
        sync.broadcastPeers();
      }
      sendJson(res, 200, {
        ok: true,
        settings: {
          deviceName: store.get('deviceName'),
          autoSync: store.get('autoSync'),
          accessCode: store.get('accessCode') ? '******' : '',
          port: actualPort,
          root: store.get('root'),
          delivery: store.get('delivery'),
          projects: store.get('projects'),
        },
        restartRequired: patch.accessCode !== undefined,
      });
      return;
    }

    if (pathname === '/api/peers' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, peers: sync ? sync.list() : [] });
      return;
    }

    if (pathname === '/api/peers/add' && req.method === 'POST') {
      if (!sync) throw files.badRequest('同步未启用', 400);
      const body = await readJsonBody(req);
      const ip = String(body.ip || '').trim();
      const port = Number(body.port);
      if (!/^[\d.]+$/.test(ip) || !Number.isInteger(port)) throw files.badRequest('地址或端口不合法');
      const peer = await sync.addPeer(ip, port);
      const saved = (store.get('manualPeers') || []).filter((item) => !(item.ip === ip && Number(item.port) === Number(port)));
      saved.push({ ip, port });
      store.update({ manualPeers: saved });
      sendJson(res, 200, { ok: true, peer });
      return;
    }

    if (pathname === '/api/open-folder' && req.method === 'POST') {
      if (!onOpenFolder) throw files.badRequest('当前环境不支持打开文件夹', 400);
      await onOpenFolder();
      sendJson(res, 200, { ok: true });
      return;
    }

    throw files.badRequest('接口不存在', 404);
  }

  function handleChunkUpload(req, res, urlObj) {
    const root = path.resolve(store.get('root'));
    let parent;
    try {
      parent = files.resolveInside(root, urlObj.searchParams.get('path') || '');
    } catch (error) {
      sendError(res, error);
      return;
    }
    let stat;
    try {
      stat = fs.statSync(parent);
    } catch {
      sendError(res, files.badRequest('目标文件夹不存在', 404));
      return;
    }
    if (!stat.isDirectory()) {
      sendError(res, files.badRequest('目标不是文件夹', 400));
      return;
    }

    const name = files.sanitizeName(urlObj.searchParams.get('name') || '');
    if (!name) {
      sendError(res, files.badRequest('文件名不合法'));
      return;
    }
    const uploadId = String(urlObj.searchParams.get('uploadId') || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) {
      sendError(res, files.badRequest('上传标识不合法'));
      return;
    }
    const index = Number(urlObj.searchParams.get('index'));
    const total = Number(urlObj.searchParams.get('total'));
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 20000 || index < 0 || index >= total) {
      sendError(res, files.badRequest('分片参数不合法'));
      return;
    }

    const temp = path.join(parent, `.fb-upload-${uploadId}.part`);
    let received = 0;
    const out = fs.createWriteStream(temp, { flags: 'a' });
    let finished = false;

    const cleanup = () => {
      out.destroy();
      fs.unlink(temp, () => {});
    };

    req.on('aborted', cleanup);
    req.on('error', () => {
      if (!finished) cleanup();
    });
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > 8 * 1024 * 1024) {
        finished = true;
        cleanup();
        sendError(res, files.badRequest('单个分片不能超过 8MB', 413));
        req.destroy();
      }
    });
    req.pipe(out);

    out.on('error', (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      sendError(res, files.badRequest(`写入失败: ${error.message}`, 500));
    });

    out.on('finish', () => {
      if (finished) return;
      finished = true;
      if (index !== total - 1) {
        sendJson(res, 200, { ok: true, done: false, next: index + 1 });
        return;
      }
      try {
        const target = files.uniquePath(parent, name);
        fs.renameSync(temp, target);
        const entry = files.entryFor(root, target, path.basename(target));
        recordTransfer(entry.path, entry.size, 'upload');
        if (sync) sync.scheduleSync(1200);
        sendJson(res, 200, { ok: true, done: true, entry });
      } catch (error) {
        fs.unlink(temp, () => {});
        sendError(res, files.badRequest(`保存失败: ${error.message}`, 500));
      }
    });
  }

  function handleUpload(req, res, urlObj) {
    const root = path.resolve(store.get('root'));
    let parent;
    try {
      parent = files.resolveInside(root, urlObj.searchParams.get('path') || '');
    } catch (error) {
      sendError(res, error);
      return;
    }
    let stat;
    try {
      stat = fs.statSync(parent);
    } catch {
      sendError(res, files.badRequest('目标文件夹不存在', 404));
      return;
    }
    if (!stat.isDirectory()) {
      sendError(res, files.badRequest('目标不是文件夹', 400));
      return;
    }

    const rawName = urlObj.searchParams.get('name') || '';
    const name = files.sanitizeName(rawName);
    if (!name) {
      sendError(res, files.badRequest('文件名不合法'));
      return;
    }

    const target = files.uniquePath(parent, name);
    const tmp = path.join(parent, `.fb-upload-${crypto.randomBytes(6).toString('hex')}.part`);
    const out = fs.createWriteStream(tmp);
    let finished = false;

    const cleanup = () => {
      out.destroy();
      fs.unlink(tmp, () => {});
    };

    req.on('aborted', cleanup);
    req.on('error', () => {
      if (!finished) cleanup();
    });

    req.pipe(out);

    out.on('error', (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      sendError(res, files.badRequest(`写入失败: ${error.message}`, 500));
    });

    out.on('finish', () => {
      if (finished) return;
      finished = true;
      try {
        fs.renameSync(tmp, target);
        const entry = files.entryFor(root, target, path.basename(target));
        recordTransfer(entry.path, entry.size, 'upload');
        sendJson(res, 200, { ok: true, entry });
        if (sync) sync.scheduleSync(1200);
      } catch (error) {
        fs.unlink(tmp, () => {});
        sendError(res, files.badRequest(`保存失败: ${error.message}`, 500));
      }
    });
  }

  // ---------- 文件监听 ----------
  function startWatcher() {
    const root = store.get('root');
    const known = new Map();
    const maxKnown = 100000;

    const scan = () => {
      const list = files.walkFiles(root, { limit: maxKnown });
      const map = new Map();
      for (const item of list) map.set(item.path, { size: item.size, mtime: item.mtime });
      return map;
    };

    const applyDiff = (next) => {
      const entries = [];
      for (const [rel, meta] of next) {
        const prev = known.get(rel);
        if (!prev) entries.push({ path: rel, action: 'add', size: meta.size, mtime: meta.mtime });
        else if (prev.size !== meta.size || Math.abs(prev.mtime - meta.mtime) > 700) {
          entries.push({ path: rel, action: 'change', size: meta.size, mtime: meta.mtime });
        }
      }
      for (const rel of known.keys()) {
        if (!next.has(rel)) entries.push({ path: rel, action: 'remove' });
      }
      known.clear();
      for (const [rel, meta] of next) known.set(rel, meta);
      return entries;
    };

    known.clear();
    for (const [rel, meta] of scan()) known.set(rel, meta);

    let debounce = null;
    let pending = false;

    const flush = () => {
      debounce = null;
      if (!pending) return;
      pending = false;
      let next;
      try {
        next = scan();
      } catch (error) {
        log(`[filebridge] 扫描共享文件夹失败: ${error.message}`);
        return;
      }
      const entries = applyDiff(next);
      if (!entries.length) return;
      broadcast({ type: 'fs', entries });
      for (const entry of entries) {
        if (entry.action !== 'add') continue;
        if (isRecentlyReceived(entry.path)) continue;
        recordTransfer(entry.path, entry.size, 'fs');
      }
      if (sync) sync.scheduleSync(1500);
    };

    const queue = () => {
      pending = true;
      if (debounce) return;
      debounce = setTimeout(flush, 180);
    };

    let fsWatcher = null;
    try {
      fsWatcher = fs.watch(root, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join('/');
        if (/\.(fb-upload|fb-sync)[^/]*\.part$/i.test(rel)) return;
        queue();
      });
      fsWatcher.on('error', (error) => {
        log(`[filebridge] 文件监听出错: ${error.message}`);
      });
    } catch (error) {
      log(`[filebridge] 无法递归监听，改用轮询: ${error.message}`);
      fsWatcher = null;
    }

    // 保底轮询：即使系统监听漏事件也能最终同步
    const pollTimer = setInterval(() => {
      queue();
    }, fsWatcher ? 8000 : 1200);

    watcher = {
      close() {
        clearInterval(pollTimer);
        if (debounce) clearTimeout(debounce);
        if (fsWatcher) fsWatcher.close();
      },
    };
  }

  // ---------- HTTP 入口 ----------
  const handler = (req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      sendJson(res, 400, { ok: false, error: '请求地址不合法' });
      return;
    }

    if (urlObj.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: APP_NAME, version: VERSION, port: actualPort });
      return;
    }

    if (urlObj.pathname.startsWith('/api/')) {
      Promise.resolve()
        .then(() => handleApi(req, res, urlObj))
        .catch((error) => sendError(res, error));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' });
      return;
    }
    try {
      serveStatic(req, res, urlObj);
    } catch (error) {
      sendError(res, error);
    }
  };

  function listen(port, attempt = 0) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(handler);
      srv.on('error', (error) => {
        if (error.code === 'EADDRINUSE' && attempt < 20) {
          listen(port + 1, attempt + 1).then(resolve, reject);
        } else {
          reject(error);
        }
      });
      srv.listen(port, '0.0.0.0', () => {
        actualPort = srv.address().port;
        resolve(srv);
      });
    });
  }

  async function start(preferredPort) {
    server = await listen(preferredPort || store.get('port'));

    wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket, req) => {
      const item = { socket, isAlive: true };
      clients.add(item);
      socket.on('pong', () => {
        item.isAlive = true;
      });
      socket.on('close', () => {
        clients.delete(item);
        broadcast({ type: 'clients', count: clients.size });
      });
      socket.on('error', () => {
        clients.delete(item);
      });
      try {
        socket.send(
          JSON.stringify({
            type: 'hello',
            device: { id: store.get('deviceId'), name: store.get('deviceName') },
            server: { port: actualPort },
            clients: clients.size,
            peers: sync ? sync.list() : [],
            clipboard: { count: clipboard.length },
          }),
        );
      } catch {
        /* ignore */
      }
      broadcast({ type: 'clients', count: clients.size });
    });

    server.on('upgrade', (req, socket, head) => {
      let urlObj;
      try {
        urlObj = new URL(req.url, 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (urlObj.pathname !== '/ws' || !isAuthorized(req, urlObj)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    heartbeat = setInterval(() => {
      for (const item of clients) {
        if (item.isAlive === false) {
          item.socket.terminate();
          clients.delete(item);
          continue;
        }
        item.isAlive = false;
        try {
          item.socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);

    sync = createSync({
      store,
      httpPort: actualPort,
      broadcast,
      log,
      onReceived: markReceived,
    });
    sync.start();

    // 恢复手动添加的设备（Tailscale / 跨网段）
    for (const peer of store.get('manualPeers') || []) {
      sync.addPeer(peer.ip, peer.port).catch((error) => log(`[sync] 恢复设备失败 ${peer.ip}:${peer.port} - ${error.message}`));
    }

    tunnel = new TunnelManager({
      dir: store.dir,
      port: actualPort,
      broadcast,
      log,
      extraBinaryPaths: cloudflaredPaths,
    });
    if (tunnel.config.autostart && tunnel.status.binaryFound) {
      tunnel.start().catch((error) => log(`[tunnel] 自动启动失败: ${error.message}`));
    }

    startWatcher();

    log(`[filebridge] 服务已启动 http://127.0.0.1:${actualPort} （共享目录 ${store.get('root')}）`);

    return {
      port: actualPort,
      url: `http://127.0.0.1:${actualPort}`,
      getInfo: () => infoPayload(),
      broadcast,
      store,
      get sync() {
        return sync;
      },
      get clients() {
        return clients.size;
      },
      clipboard,
      async close() {
        if (heartbeat) clearInterval(heartbeat);
        if (watcher) watcher.close();
        if (sync) sync.stop();
        if (tunnel) await tunnel.dispose();
        if (wss) {
          for (const item of clients) {
            try {
              item.socket.close();
            } catch {
              /* ignore */
            }
          }
          wss.close();
        }
        await new Promise((resolve) => {
          if (!server) return resolve();
          server.close(() => resolve());
        });
      },
    };
  }

  return { start, store };
}

module.exports = { createServer, APP_NAME, VERSION };
