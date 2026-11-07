#!/usr/bin/env node
'use strict';

/**
 * 不带 Electron 的独立服务入口。
 * 用途：无界面运行、自动化测试、排查网络问题。
 *
 *   node server/standalone.js [--data-dir DIR] [--root DIR] [--port N] [--sync-port N] [--code X] [--no-sync]
 */

const path = require('path');
const os = require('os');

const { Store } = require('./config');
const { createServer } = require('./index');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'no-sync') {
      args.autoSync = false;
      continue;
    }
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args['data-dir'] || process.env.FB_DATA_DIR || path.join(os.homedir(), '.filebridge'));
  const store = new Store(dataDir, {
    root: args.root || process.env.FB_ROOT,
    port: args.port || process.env.FB_PORT,
    syncPort: args['sync-port'] || process.env.FB_SYNC_PORT,
    accessCode: args.code !== undefined ? args.code : process.env.FB_CODE,
    autoSync: args.autoSync !== undefined ? args.autoSync : undefined,
  });

  const app = createServer({
    store,
    rendererDir: path.join(__dirname, '..', 'renderer'),
    assetsDir: path.join(__dirname, '..', 'assets'),
    isElectron: false,
    onOpenFolder: null,
    log: (...messages) => console.log(...messages),
  });

  const instance = await app.start(store.get('port'));
  const payload = {
    ok: true,
    port: instance.port,
    url: `http://127.0.0.1:${instance.port}/`,
    root: store.get('root'),
    dataDir,
  };
  // 供测试脚本与外部工具解析
  console.log(`FILEBRIDGE_READY ${JSON.stringify(payload)}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await instance.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[filebridge] 启动失败:', error);
  process.exit(1);
});
