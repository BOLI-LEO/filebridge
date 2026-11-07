'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PORT = 47890;
const DEFAULT_SYNC_PORT = 47891;
const DEFAULT_INBOX = '临时收件箱';

function normalizeManualPeers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item.ip !== 'string') continue;
    const ip = item.ip.trim().slice(0, 64);
    const port = Number(item.port);
    if (!ip || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (out.some((peer) => peer.ip === ip && peer.port === port)) continue;
    out.push({ ip, port });
  }
  return out;
}

let filesHelper = null;
function relClean(value) {
  if (!filesHelper) {
    try {
      filesHelper = require('./files');
    } catch {
      filesHelper = null;
    }
  }
  if (filesHelper) return filesHelper.cleanRel(value);
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeProjects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const clean = relClean(item).replace(/^\/+|\/+$/g, '');
    if (!clean || clean.includes('..')) continue;
    if (out.includes(clean)) continue;
    out.push(clean);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeDelivery(value, fallbackPath) {
  const raw = value && typeof value === 'object' ? value : {};
  let target = relClean(raw.path).replace(/^\/+|\/+$/g, '');
  if (!target) target = fallbackPath;
  return {
    path: target,
    quick: raw.quick === true,
  };
}

function defaultRoot() {
  return path.join(os.homedir(), 'FileBridge');
}

function pickDeviceName() {
  try {
    const host = os.hostname().replace(/\.local$/i, '').trim();
    return host || 'FileBridge 设备';
  } catch {
    return 'FileBridge 设备';
  }
}

function cleanDeviceName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
}

function cleanAccessCode(code) {
  return String(code || '')
    .replace(/[^0-9A-Za-z_-]/g, '')
    .slice(0, 32);
}

function clampPort(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

class Store {
  constructor(dir, overrides = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.clipboardFile = path.join(dir, 'clipboard.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load(overrides);
    this.save();
  }

  load(overrides) {
    let raw = {};
    try {
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      raw = JSON.parse(text);
    } catch {
      raw = {};
    }

    const data = {
      deviceId: raw.deviceId || crypto.randomUUID(),
      deviceName: cleanDeviceName(raw.deviceName) || pickDeviceName(),
      port: clampPort(raw.port, DEFAULT_PORT),
      syncPort: clampPort(raw.syncPort, DEFAULT_SYNC_PORT),
      root: typeof raw.root === 'string' && raw.root.trim() ? raw.root : defaultRoot(),
      accessCode: cleanAccessCode(raw.accessCode),
      autoSync: raw.autoSync !== false,
      inbox: relClean(raw.inbox).replace(/^\/+|\/+$/g, '') || DEFAULT_INBOX,
      projects: normalizeProjects(raw.projects),
      delivery: normalizeDelivery(raw.delivery, relClean(raw.inbox).replace(/^\/+|\/+$/g, '') || DEFAULT_INBOX),
      manualPeers: normalizeManualPeers(raw.manualPeers),
      createdAt: raw.createdAt || Date.now(),
    };

    if (overrides.root) data.root = overrides.root;
    if (overrides.port) data.port = clampPort(overrides.port, data.port);
    if (overrides.syncPort) data.syncPort = clampPort(overrides.syncPort, data.syncPort);
    if (overrides.deviceName) data.deviceName = cleanDeviceName(overrides.deviceName);
    if (overrides.accessCode !== undefined) data.accessCode = cleanAccessCode(overrides.accessCode);
    if (overrides.autoSync !== undefined) data.autoSync = Boolean(overrides.autoSync);

    data.root = path.resolve(data.root);
    fs.mkdirSync(data.root, { recursive: true });

    try {
      fs.mkdirSync(path.join(data.root, data.inbox), { recursive: true });
    } catch {
      data.inbox = DEFAULT_INBOX;
    }

    // 过滤已经不存在或被移走的固定项目
    data.projects = data.projects.filter((project) => {
      try {
        return fs.statSync(path.join(data.root, project)).isDirectory();
      } catch {
        return false;
      }
    });

    // 投递位置失效时回落到收件箱
    try {
      if (!fs.statSync(path.join(data.root, data.delivery.path)).isDirectory()) {
        data.delivery.path = data.inbox;
      }
    } catch {
      data.delivery.path = data.inbox;
    }

    // 清理上次异常退出遗留的临时文件（同步/上传中断的残片）
    this.cleanupTempFiles(data.root, 24 * 60 * 60 * 1000);

    return data;
  }

  cleanupTempFiles(root, maxAgeMs) {
    const now = Date.now();
    const walk = (dir, depth) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, depth + 1);
          continue;
        }
        if (!/\.(fb-upload|fb-sync)[^/]*\.part$/i.test(entry.name)) continue;
        try {
          if (now - fs.statSync(abs).mtimeMs > maxAgeMs) fs.unlinkSync(abs);
        } catch {
          /* ignore */
        }
      }
    };
    walk(root, 0);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.data[key];
  }

  ensureInbox() {
    const inbox = this.data.inbox || DEFAULT_INBOX;
    fs.mkdirSync(path.join(this.data.root, inbox), { recursive: true });
    return inbox;
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'deviceName') this.data.deviceName = cleanDeviceName(value) || this.data.deviceName;
      else if (key === 'accessCode') this.data.accessCode = cleanAccessCode(value);
      else if (key === 'autoSync') this.data.autoSync = Boolean(value);
      else if (key === 'root') this.data.root = path.resolve(String(value));
      else if (key === 'port') this.data.port = clampPort(value, this.data.port);
      else if (key === 'syncPort') this.data.syncPort = clampPort(value, this.data.syncPort);
      else if (key === 'projects') this.data.projects = normalizeProjects(value);
      else if (key === 'manualPeers') this.data.manualPeers = normalizeManualPeers(value);
      else if (key === 'delivery') this.data.delivery = normalizeDelivery(value, this.data.inbox);
      else if (key === 'inbox') {
        const inbox = relClean(value).replace(/^\/+|\/+$/g, '');
        if (inbox) {
          this.data.inbox = inbox;
          try {
            fs.mkdirSync(path.join(this.data.root, inbox), { recursive: true });
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.save();
    return this.data;
  }
}

module.exports = {
  Store,
  DEFAULT_PORT,
  DEFAULT_SYNC_PORT,
  DEFAULT_INBOX,
  defaultRoot,
  pickDeviceName,
  cleanDeviceName,
  cleanAccessCode,
  clampPort,
  normalizeProjects,
  normalizeDelivery,
  normalizeManualPeers,
};
