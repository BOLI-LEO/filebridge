'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Cloudflare Tunnel 管理。
 *
 * 两种模式：
 * - token：在 Cloudflare Zero Trust 面板建好 tunnel，把 token 填进来，
 *   再给域名加一条 CNAME 指向 <tunnel-id>.cfargotunnel.com。
 * - quick：不需要账号，cloudflared tunnel --url 生成 trycloudflare.com 临时地址，
 *   适合临时用；重启后地址会变。
 *
 * token 只保存在本机 app 数据目录的 tunnel.json，不通过 API 回传。
 */
class TunnelManager {
  constructor({ dir, port, broadcast, log, extraBinaryPaths = [] }) {
    this.file = path.join(dir, 'tunnel.json');
    this.dir = dir;
    this.port = port;
    this.broadcast = broadcast || (() => {});
    this.log = log || (() => {});
    this.extraBinaryPaths = extraBinaryPaths;
    this.config = this.load();
    this.child = null;
    this.status = {
      state: 'stopped',
      running: false,
      mode: this.config.mode || 'token',
      hostname: this.config.hostname || '',
      url: '',
      error: '',
      startedAt: 0,
      binary: '',
      binaryFound: false,
    };
    this.status.binary = this.findBinary() || '';
    this.status.binaryFound = Boolean(this.status.binary);
    this.stderrTail = [];
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const raw = JSON.parse(text);
      return {
        mode: ['quick', 'local', 'token'].includes(raw.mode) ? raw.mode : 'token',
        token: typeof raw.token === 'string' ? raw.token : '',
        hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
        localId: typeof raw.localId === 'string' ? raw.localId : '',
        credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile : '',
        autostart: raw.autostart === true,
      };
    } catch {
      return { mode: 'token', token: '', hostname: '', autostart: false };
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    } catch (error) {
      this.log(`[tunnel] 保存配置失败: ${error.message}`);
    }
  }

  findBinary() {
    const candidates = [];
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const envPath = String(process.env.PATH || '').split(path.delimiter);
    for (const dir of envPath) {
      if (dir) candidates.push(path.join(dir, exe));
    }
    candidates.push(
      path.join(os.homedir(), 'bin', exe),
      path.join(os.homedir(), '.local', 'bin', exe),
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      ...this.extraBinaryPaths,
    );
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || '';
      const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
      candidates.push(
        path.join(local, 'cloudflared', exe),
        path.join(pf, 'cloudflared', exe),
        path.join(local, 'Microsoft', 'WinGet', 'Links', exe),
      );
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  maskToken(token) {
    if (!token) return '';
    return token.length <= 10 ? '******' : `${token.slice(0, 6)}…${token.slice(-4)}`;
  }

  getStatus() {
    return {
      ...this.status,
      hasToken: Boolean(this.config.token),
      tokenMasked: this.maskToken(this.config.token),
      config: {
        mode: this.config.mode,
        hostname: this.config.hostname,
        autostart: this.config.autostart,
        hasToken: Boolean(this.config.token),
        localId: this.config.localId,
        hasCredentials: Boolean(this.config.credentialsFile && fs.existsSync(this.config.credentialsFile)),
      },
    };
  }

  updateConfig(patch = {}) {
    if (['token', 'quick', 'local'].includes(patch.mode)) this.config.mode = patch.mode;
    if (typeof patch.token === 'string') this.config.token = patch.token.trim();
    if (typeof patch.hostname === 'string') this.config.hostname = patch.hostname.trim().toLowerCase();
    if (typeof patch.localId === 'string') this.config.localId = patch.localId.trim();
    if (typeof patch.credentialsFile === 'string') this.config.credentialsFile = patch.credentialsFile.trim();
    if (typeof patch.autostart === 'boolean') this.config.autostart = patch.autostart;
    this.save();
    this.status.mode = this.config.mode;
    this.status.hostname = this.config.hostname;
    this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
    return this.getStatus();
  }

  pickPublicUrl() {
    if (this.config.mode === 'quick') return this.status.url;
    if (this.config.hostname) return `https://${this.config.hostname}`;
    return '';
  }

  async start() {
    if (this.child) return this.getStatus();
    const binary = this.findBinary();
    this.status.binary = binary;
    this.status.binaryFound = Boolean(binary);
    if (!binary) {
      this.status.state = 'error';
      this.status.error = '未找到 cloudflared 可执行文件';
      this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
      throw new Error('未找到 cloudflared，请先安装（brew install cloudflared 或从 Cloudflare 官网下载）');
    }

    const args = ['--no-autoupdate'];
    if (this.config.mode === 'local') {
      if (!this.config.localId || !this.config.credentialsFile || !fs.existsSync(this.config.credentialsFile)) {
        this.status.state = 'error';
        this.status.error = '本机隧道缺少 credentials 文件';
        this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
        throw new Error('本机隧道配置不完整（缺少 credentials 文件）');
      }
      const configPath = path.join(this.dir, 'cloudflared-config.yml');
      const lines = [
        `tunnel: ${this.config.localId}`,
        `credentials-file: ${this.config.credentialsFile}`,
        'ingress:',
      ];
      if (this.config.hostname) {
        lines.push(`  - hostname: ${this.config.hostname}`, `    service: http://127.0.0.1:${this.port}`);
      }
      lines.push('  - service: http_status:404');
      fs.writeFileSync(configPath, `${lines.join('\n')}\n`);
      args.push('--config', configPath, 'tunnel', 'run', this.config.localId);
    } else if (this.config.mode === 'quick') {
      args.push('tunnel', '--url', `http://127.0.0.1:${this.port}`);
    } else {
      if (!this.config.token) {
        this.status.state = 'error';
        this.status.error = '尚未填写 Tunnel token';
        this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
        throw new Error('请先在设置里填写 Cloudflare Tunnel token');
      }
      args.push('tunnel', 'run', '--token', this.config.token);
    }

    this.stderrTail = [];
    this.status = {
      ...this.status,
      state: 'starting',
      running: false,
      error: '',
      url: this.config.mode === 'quick' ? '' : this.getStatus().url,
      startedAt: Date.now(),
    };
    this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    const onLine = (line) => {
      const text = String(line).trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();

      const quick = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (quick) {
        this.status.url = quick[0];
        this.status.state = 'running';
        this.status.running = true;
      }
      if (/Registered tunnel connection|Connection.*registered|Updated to new configuration/i.test(text)) {
        this.status.state = 'running';
        this.status.running = true;
        this.status.error = '';
        if (this.config.mode !== 'quick') this.status.url = this.pickPublicUrl();
      }
      if (/\bERR\b|failed|error/i.test(text) && /cloudflared|tunnel|dial|connect/i.test(text)) {
        this.status.error = text.replace(/^[0-9TZ:.\-]+ ?/, '').slice(0, 220);
      }
      this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
    };

    const attach = (stream) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) onLine(line);
      });
    };
    attach(child.stderr);
    attach(child.stdout);

    child.on('error', (error) => {
      this.status.state = 'error';
      this.status.running = false;
      this.status.error = error.message;
      this.child = null;
      this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
    });

    child.on('exit', (code, signal) => {
      const unexpected = this.status.state === 'running' || this.status.state === 'starting';
      this.child = null;
      this.status.running = false;
      this.status.state = code === 0 ? 'stopped' : 'error';
      if (unexpected && code !== 0) {
        this.status.error = this.status.error || `cloudflared 退出（code ${code}${signal ? `, ${signal}` : ''}）`;
      }
      this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
      this.log(`[tunnel] cloudflared 已退出: code=${code}`);
    });

    // 启动超时提示
    setTimeout(() => {
      if (this.status.state === 'starting' && !this.status.error) {
        this.status.error = 'cloudflared 启动超时，请检查网络或 token';
        this.status.state = 'error';
        this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
      }
    }, 25000);

    return this.getStatus();
  }

  async stop() {
    if (!this.child) {
      this.status.state = 'stopped';
      this.status.running = false;
      this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
      return this.getStatus();
    }
    const child = this.child;
    this.child = null;
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 4000);
    } catch {
      /* ignore */
    }
    this.status.state = 'stopped';
    this.status.running = false;
    this.status.error = '';
    this.broadcast({ type: 'tunnel', tunnel: this.getStatus() });
    return this.getStatus();
  }

  async dispose() {
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { TunnelManager };
