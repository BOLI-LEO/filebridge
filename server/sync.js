'use strict';

const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const files = require('./files');

const APP_ID = 'filebridge';
const PROTOCOL = 1;
const PEER_TTL = 15000;
const ANNOUNCE_INTERVAL = 3000;
const SYNC_INTERVAL = 8000;
const FILES_PER_ROUND = 25;
const BYTES_PER_ROUND = 1_500_000_000;

/**
 * 局域网设备发现 + 双向文件镜像。
 *
 * - UDP 广播发现同网段其他 FileBridge 实例
 * - 每轮拉取对端文件清单，比对后自动下载缺失/变更的文件
 * - 删除通过墓碑（tombstone）同步，避免已删除文件被对端重新拉回；冲突时保留双方副本
 */
class PeerSync {
  constructor({ store, httpPort, broadcast, log, onReceived }) {
    this.store = store;
    this.httpPort = httpPort;
    this.broadcast = broadcast || (() => {});
    this.log = log || (() => {});
    this.onReceived = onReceived || (() => {});
    this.peers = new Map();
    this.timers = [];
    this.udp = null;
    this.stopped = false;
    this.syncingAll = false;
    this.scheduled = null;
    this.manualPeers = new Map();
    this.scanning = false;
    this.lastScan = null;
    this.tombstoneFile = path.join(store.dir, 'tombstones.json');
    this.tombstones = new Map();
    this.loadTombstones();
  }

  loadTombstones() {
    try {
      const text = fs.readFileSync(this.tombstoneFile, 'utf8').replace(/^\uFEFF/, '');
      const list = JSON.parse(text);
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const item of Array.isArray(list) ? list : []) {
        const rel = files.cleanRel(item && item.path);
        const at = Number(item && item.deletedAt);
        if (!rel || !Number.isFinite(at) || at < cutoff) continue;
        this.tombstones.set(rel, at);
      }
    } catch {
      /* 没有墓碑文件 */
    }
  }

  saveTombstones() {
    try {
      fs.writeFileSync(this.tombstoneFile, JSON.stringify(this.getTombstones()), 'utf8');
    } catch {
      /* ignore */
    }
  }

  getTombstones() {
    return [...this.tombstones.entries()].map(([rel, deletedAt]) => ({ path: rel, deletedAt }));
  }

  tombstoneFor(rel) {
    let at = this.tombstones.get(rel);
    if (at) return at;
    // 父目录被删也算（例如删除整个文件夹）
    let current = rel;
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'));
      at = this.tombstones.get(current);
      if (at) return at;
    }
    return 0;
  }

  recordTombstones(relPaths) {
    const now = Date.now();
    let changed = false;
    for (const raw of relPaths || []) {
      const rel = files.cleanRel(raw);
      if (!rel) continue;
      this.tombstones.set(rel, now);
      changed = true;
    }
    if (changed) this.saveTombstones();
  }

  applyRemoteTombstones(list) {
    const root = path.resolve(this.store.get('root'));
    let changed = false;
    for (const item of Array.isArray(list) ? list : []) {
      const rel = files.cleanRel(item && item.path);
      const at = Number(item && item.deletedAt);
      if (!rel || !Number.isFinite(at)) continue;
      const known = this.tombstones.get(rel) || 0;
      if (at > known) {
        this.tombstones.set(rel, at);
        changed = true;
      }
      let abs;
      try {
        abs = files.resolveInside(root, rel);
      } catch {
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.mtimeMs > at + 1500) continue; // 删除后又被修改/重建，保留
      try {
        fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (changed) this.saveTombstones();
  }

  start() {
    this.stopped = false;
    this.startDiscovery();
    this.timers.push(setInterval(() => this.announce(), ANNOUNCE_INTERVAL));
    this.timers.push(
      setInterval(() => {
        this.expirePeers();
      }, 5000),
    );
    this.timers.push(
      setInterval(() => {
        this.syncAll('timer');
      }, SYNC_INTERVAL),
    );
    // 校园网经常屏蔽 UDP 广播，这里用 HTTP 扫描兜底，IP 变化后自动重新找到对端
    if (this.store.get('autoSync')) {
      this.timers.push(setTimeout(() => this.scanLan(), 4000));
      this.timers.push(setInterval(() => this.scanLan(), 180000));
      // 把自己的当前 IP 通告给已知对端；对方 IP 变了也能被纠正
      this.timers.push(setTimeout(() => this.announceAll(), 3000));
      this.timers.push(setInterval(() => this.announceAll(), 45000));
    }
    this.scheduleSync(2500);
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers = [];
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
      this.udp = null;
    }
  }

  setHttpPort(port) {
    this.httpPort = port;
    this.announce();
  }

  startDiscovery() {
    const port = this.store.get('syncPort');
    try {
      this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (error) {
      this.log(`[sync] 无法创建 UDP socket: ${error.message}`);
      return;
    }
    this.udp.on('error', (error) => {
      this.log(`[sync] UDP 错误: ${error.message}（将仅使用手动添加的设备）`);
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
      this.udp = null;
    });
    this.udp.on('message', (buffer, rinfo) => {
      try {
        const packet = JSON.parse(buffer.toString('utf8'));
        this.handleAnnounce(packet, rinfo.address);
      } catch {
        /* 忽略非法数据包 */
      }
    });
    try {
      this.udp.bind(port, () => {
        try {
          this.udp.setBroadcast(true);
        } catch {
          /* ignore */
        }
        this.announce();
      });
    } catch (error) {
      this.log(`[sync] UDP 端口 ${port} 不可用: ${error.message}`);
    }
  }

  announce() {
    if (!this.udp) return;
    const packet = Buffer.from(
      JSON.stringify({
        app: APP_ID,
        v: PROTOCOL,
        id: this.store.get('deviceId'),
        name: this.store.get('deviceName'),
        platform: process.platform,
        httpPort: this.httpPort,
        syncPort: this.store.get('syncPort'),
        ts: Date.now(),
      }),
    );
    try {
      this.udp.send(packet, 0, packet.length, this.store.get('syncPort'), '255.255.255.255');
    } catch {
      /* ignore */
    }
  }

  handleAnnounce(packet, ip) {
    if (!packet || packet.app !== APP_ID || packet.v !== PROTOCOL) return;
    if (!packet.id || packet.id === this.store.get('deviceId')) return;
    if (!Number.isInteger(packet.httpPort) || packet.httpPort < 1 || packet.httpPort > 65535) return;

    const existing = this.peers.get(packet.id);
    if (existing) {
      const changed =
        existing.name !== packet.name ||
        existing.busy !== false ||
        existing.online !== true ||
        existing.lastError !== '';
      Object.assign(existing, {
        name: packet.name || existing.name,
        platform: packet.platform || existing.platform,
        httpPort: packet.httpPort,
        ip,
        lastSeen: Date.now(),
        online: true,
        lastError: '',
      });
      if (changed) this.broadcastPeers();
      return;
    }

    this.peers.set(packet.id, {
      id: packet.id,
      name: packet.name || ip,
      platform: packet.platform || 'unknown',
      httpPort: packet.httpPort,
      ip,
      lastSeen: Date.now(),
      online: true,
      busy: false,
      status: 'idle',
      lastError: '',
      lastSync: 0,
      received: 0,
    });
    this.log(`[sync] 发现设备 ${packet.name} (${ip}:${packet.httpPort})`);
    this.broadcastPeers();
    this.scheduleSync(1500);
  }

  registerPeer({ id, name, platform, ip, httpPort, manual = false }) {
    if (!id || id === this.store.get('deviceId') || !httpPort) return;
    this.peers.set(id, {
      id,
      name: name || ip,
      platform: platform || 'unknown',
      httpPort,
      ip,
      lastSeen: Date.now(),
      online: true,
      manual,
      busy: false,
      status: 'idle',
      lastError: '',
      lastSync: 0,
      received: 0,
    });
    this.broadcastPeers();
    this.scheduleSync(800);
    return this.peers.get(id);
  }

  /** 手动添加设备（用于跨网段 / 本机双实例测试） */
  async addPeer(ip, httpPort) {
    const info = await this.fetchJson({ ip, httpPort }, '/api/info').catch(() => null);
    if (!info || !info.device || !info.device.id) {
      throw new Error(`无法连接到 ${ip}:${httpPort}`);
    }
    return this.registerPeer({
      id: info.device.id,
      name: info.device.name,
      platform: info.device.platform,
      ip,
      httpPort,
      manual: true,
    });
  }

  expirePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (peer.manual) continue; // 手动添加的设备不因收不到广播而掉线
      if (peer.online && now - peer.lastSeen > PEER_TTL) {
        peer.online = false;
        peer.status = 'offline';
        changed = true;
      }
      if (!peer.online && now - peer.lastSeen > 10 * 60 * 1000) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcastPeers();
  }

  removePeer(ip, httpPort) {
    for (const [id, peer] of this.peers) {
      if (peer.ip === ip && Number(peer.httpPort) === Number(httpPort)) this.peers.delete(id);
    }
    this.broadcastPeers();
  }

  localSubnets() {
    const subnets = new Set();
    const selfIps = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        if (/^169\.254\./.test(item.address)) continue;
        if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(item.address)) continue;
        selfIps.add(item.address);
        subnets.add(item.address.split('.').slice(0, 3).join('.'));
      }
    }
    return { subnets: [...subnets], selfIps };
  }

  quickJson(ip, port, apiPath, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
      const code = this.store.get('accessCode');
      const headers = code ? { 'x-access-code': code } : {};
      const req = http.request({ host: ip, port, path: apiPath, method: 'GET', headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  async scanLan() {
    if (this.stopped || this.scanning) return this.lastScan;
    if (!this.store.get('autoSync')) return this.lastScan;
    this.scanning = true;
    const started = Date.now();
    const { subnets, selfIps } = this.localSubnets();
    const hosts = [];
    for (const subnet of subnets) {
      for (let host = 1; host < 255; host += 1) {
        const ip = `${subnet}.${host}`;
        if (selfIps.has(ip)) continue;
        hosts.push(ip);
      }
    }
    const found = [];
    let index = 0;
    const worker = async () => {
      while (index < hosts.length) {
        const ip = hosts[index];
        index += 1;
        try {
          const health = await this.quickJson(ip, 47890, '/api/health', 420);
          if (!health || !health.ok) continue;
          const port = Number(health.port) || 47890;
          const info = await this.quickJson(ip, port, '/api/info', 700);
          if (!info || !info.device || !info.device.id) continue;
          if (info.device.id === this.store.get('deviceId')) continue;
          const peer = this.registerPeer({
            id: info.device.id,
            name: info.device.name,
            platform: info.device.platform,
            ip,
            httpPort: port,
            manual: true,
          });
          if (peer) found.push({ id: info.device.id, name: info.device.name, ip, port });
        } catch {
          /* 忽略单台主机失败 */
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: 24 }, () => worker()));
    } finally {
      this.scanning = false;
    }
    this.lastScan = { found, scanned: hosts.length, subnets, at: Date.now(), duration: Date.now() - started };
    if (found.length) {
      this.log(`[sync] 局域网扫描发现 ${found.length} 台设备`);
      this.scheduleSync(1000);
    }
    return this.lastScan;
  }

  localIpv4() {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (/virtualbox|vmware|vethernet|hyper-v|docker|utun|loopback|bridge|virtual/i.test(name)) continue;
      for (const item of list || []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        if (/^169\.254\./.test(item.address)) continue;
        if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(item.address)) continue;
        return item.address;
      }
    }
    return '127.0.0.1';
  }

  async announceTo(peer) {
    const payload = JSON.stringify({
      id: this.store.get('deviceId'),
      name: this.store.get('deviceName'),
      platform: process.platform,
      ip: this.localIpv4(),
      port: Number(this.httpPort) || 47890,
    });
    await new Promise((resolve) => {
      const code = this.store.get('accessCode');
      const headers = { 'content-type': 'application/json' };
      if (code) headers['x-access-code'] = code;
      const req = http.request({
        host: peer.ip,
        port: peer.httpPort,
        path: '/api/peers/announce',
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
        timeout: 3000,
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve());
      req.on('close', resolve);
      req.end(payload);
    });
  }

  announceAll() {
    if (this.stopped) return;
    for (const peer of this.peers.values()) {
      this.announceTo(peer).catch(() => {});
    }
  }

  list() {
    return [...this.peers.values()]
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        platform: peer.platform,
        ip: peer.ip,
        httpPort: peer.httpPort,
        online: peer.online,
        busy: peer.busy,
        status: peer.status,
        lastError: peer.lastError,
        lastSync: peer.lastSync,
        received: peer.received,
        link: /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(peer.ip) ? 'tailscale' : 'lan',
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  broadcastPeers() {
    this.broadcast({ type: 'peers', peers: this.list() });
  }

  scheduleSync(delay = 1200) {
    if (this.stopped) return;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.syncAll('change');
    }, delay);
  }

  async syncAll(reason) {
    if (this.stopped) return;
    if (!this.store.get('autoSync')) return;
    if (this.syncingAll) return;
    this.syncingAll = true;
    try {
      for (const peer of this.peers.values()) {
        if (!peer.online || peer.busy) continue;
        await this.syncPeer(peer);
      }
    } finally {
      this.syncingAll = false;
    }
    if (reason === 'change') this.scheduleSync(2500);
  }

  requestOptions(peer, apiPath) {
    const code = this.store.get('accessCode');
    const headers = {};
    if (code) headers['x-access-code'] = code;
    return {
      host: peer.ip,
      port: peer.httpPort,
      path: apiPath,
      method: 'GET',
      headers,
      timeout: 10000,
    };
  }

  fetchJson(peer, apiPath) {
    return new Promise((resolve, reject) => {
      const req = http.request(this.requestOptions(peer, apiPath), (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) {
            req.destroy(new Error('响应过大'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', reject);
      req.end();
    });
  }

  async syncPeer(peer) {
    peer.busy = true;
    peer.status = 'syncing';
    this.broadcastPeers();
    try {
      const tree = await this.fetchJson(peer, '/api/tree');
      if (!tree || !Array.isArray(tree.files)) throw new Error('对端文件清单无效');
      this.applyRemoteTombstones(tree.tombstones || []);
      const root = this.store.get('root');
      const candidates = tree.files
        .filter((file) => file && typeof file.path === 'string' && Number.isFinite(file.size))
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

      let count = 0;
      let bytes = 0;
      for (const remote of candidates) {
        if (count >= FILES_PER_ROUND || bytes >= BYTES_PER_ROUND) break;
        const rel = files.cleanRel(remote.path);
        if (!rel) continue;
        const deletedAt = this.tombstoneFor(rel);
        if (deletedAt && Number(remote.mtime || 0) <= deletedAt) continue;
        let abs;
        try {
          abs = files.resolveInside(root, rel);
        } catch {
          continue;
        }

        let local = null;
        try {
          local = fs.statSync(abs);
        } catch {
          local = null;
        }
        if (local && local.isDirectory()) continue;
        if (local && local.size === remote.size) continue;

        let dest = abs;
        if (local) {
          // 同名但内容不同：保留双方，另存一份冲突副本，避免死循环覆盖
          const ext = path.extname(abs);
          const base = path.basename(abs, ext);
          const safePeerName = files.sanitizeName(peer.name) || '另一台设备';
          dest = path.join(path.dirname(abs), `${base} (来自 ${safePeerName})${ext}`);
          if (fs.existsSync(dest)) continue;
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await this.download(peer, rel, dest, remote);
        this.onReceived(files.relOf(root, dest));
        count += 1;
        bytes += remote.size;
        peer.received += 1;
        this.broadcast({
          type: 'sync',
          peer: { id: peer.id, name: peer.name },
          status: 'received',
          path: files.relOf(root, dest),
          size: remote.size,
        });
      }

      peer.status = 'idle';
      peer.lastError = '';
      peer.lastSync = Date.now();
    } catch (error) {
      peer.status = 'error';
      peer.lastError = error.message || String(error);
      this.log(`[sync] 与 ${peer.name} 同步失败: ${peer.lastError}`);
    } finally {
      peer.busy = false;
      this.broadcastPeers();
    }
  }

  sendAck(peer, rel, size) {
    const code = this.store.get('accessCode');
    const payload = JSON.stringify({
      path: rel,
      size,
      deviceId: this.store.get('deviceId'),
      deviceName: this.store.get('deviceName'),
    });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (code) headers['x-access-code'] = code;
    try {
      const req = http.request(
        {
          host: peer.ip,
          port: peer.httpPort,
          path: '/api/sync/ack',
          method: 'POST',
          headers,
          timeout: 8000,
        },
        (res) => {
          res.resume();
        },
      );
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end(payload);
    } catch {
      /* ignore */
    }
  }

  download(peer, rel, dest, meta) {
    const tmp = `${dest}.fb-sync.part`;
    const encoded = encodeURIComponent(rel);
    return new Promise((resolve, reject) => {
      const req = http.request(this.requestOptions(peer, `/api/download?path=${encoded}`), (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载失败 HTTP ${res.statusCode}`));
          return;
        }
        let received = 0;
        const out = fs.createWriteStream(tmp);
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          out.destroy();
          fs.unlink(tmp, () => reject(error));
        };
        res.on('data', (chunk) => {
          received += chunk.length;
        });
        res.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
          if (settled) return;
          settled = true;
          try {
            if (Number.isFinite(meta.size) && received !== meta.size) {
              throw new Error(`文件大小不一致 (${received}/${meta.size})`);
            }
            fs.renameSync(tmp, dest);
            if (meta.mtime) {
              const when = new Date(meta.mtime);
              fs.utimesSync(dest, when, when);
            }
            this.sendAck(peer, rel, meta.size);
            resolve(dest);
          } catch (error) {
            fs.unlink(tmp, () => reject(error));
          }
        });
        res.pipe(out);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (error) => {
        fs.unlink(tmp, () => reject(error));
      });
      req.end();
    });
  }
}

function createSync(options) {
  return new PeerSync(options);
}

module.exports = { PeerSync, createSync, APP_ID, PROTOCOL };
