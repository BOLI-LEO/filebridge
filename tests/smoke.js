#!/usr/bin/env node
'use strict';

/* 后端冒烟测试：接口 / 上传下载 / 预览 / 剪贴板 / 移动 / 双实例同步 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
let failures = 0;
let child = null;

function check(condition, label, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

async function waitServer(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('服务未启动');
}

async function j(port, method, apiPath, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function raw(port, method, apiPath, buffer, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, { method, headers, body: buffer });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

async function startServer() {
  const dataDir = path.join(tmpRoot, 'data');
  const root = path.join(tmpRoot, 'root');
  fs.mkdirSync(root, { recursive: true });
  child = spawn(process.execPath, [path.join(ROOT, 'server/standalone.js'), '--data-dir', dataDir, '--root', root, '--port', '48200', '--no-sync'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitServer(48200);
  return { root };
}

async function main() {
  console.log('FileBridge 冒烟测试\n');
  const { root } = await startServer();

  const hello = await j(48200, 'GET', '/api/health');
  check(hello.data && hello.data.ok, '健康检查');

  const info = await j(48200, 'GET', '/api/info');
  check(info.data.ok && info.data.server.port === 48200, '信息接口');
  check(Array.isArray(info.data.qr.svg) === false && info.data.qr.svg.includes('<svg'), '二维码 SVG');
  check(info.data.tunnel && info.data.tunnel.state === 'stopped', '隧道状态');
  check(Array.isArray(info.data.server.addresses), '地址列表');

  const list0 = await j(48200, 'GET', '/api/list?path=');
  check(list0.data.ok && list0.data.entries.some((e) => e.name === '临时收件箱'), '默认收件箱');

  const mkdir = await j(48200, 'POST', '/api/mkdir', { path: '', name: '课程设计' });
  check(mkdir.data.ok, '新建文件夹');

  const mkdir2 = await j(48200, 'POST', '/api/mkdir', { path: '课程设计', name: '素材' });
  check(mkdir2.data.ok, '新建子文件夹');

  const content = Buffer.from('hello filebridge\n第二行', 'utf8');
  const up = await raw(48200, 'POST', '/api/upload?path=%E8%AF%BE%E7%A8%8B%E8%AE%BE%E8%AE%A1%2F%E7%B4%A0%E6%9D%90&name=%E6%B5%8B%E8%AF%95.txt', content);
  check(up.status === 200, '上传文件');

  const list1 = await j(48200, 'GET', '/api/list?path=%E8%AF%BE%E7%A8%8B%E8%AE%BE%E8%AE%A1%2F%E7%B4%A0%E6%9D%90');
  check(list1.data.entries.some((e) => e.name === '测试.txt'), '列表能读到上传文件');

  const down = await raw(48200, 'GET', '/api/download?path=%E8%AF%BE%E7%A8%8B%E8%AE%BE%E8%AE%A1%2F%E7%B4%A0%E6%9D%90%2F%E6%B5%8B%E8%AF%95.txt');
  check(down.status === 200 && down.buf.equals(content), '下载内容一致');

  const range = await raw(48200, 'GET', '/api/download?path=%E8%AF%BE%E7%A8%8B%E8%AE%BE%E8%AE%A1%2F%E7%B4%A0%E6%9D%90%2F%E6%B5%8B%E8%AF%95.txt', undefined, { Range: 'bytes=0-4' });
  check(range.status === 206 && range.buf.toString() === 'hello', 'Range 断点续传');

  const preview = await raw(48200, 'GET', '/api/preview?path=%E8%AF%BE%E7%A8%8B%E8%AE%BE%E8%AE%A1%2F%E7%B4%A0%E6%9D%90%2F%E6%B5%8B%E8%AF%95.txt');
  check(preview.status === 200 && preview.buf.toString().includes('hello filebridge'), '文本预览');

  const clip = await j(48200, 'POST', '/api/clipboard', { text: '剪贴板测试' });
  check(clip.data.ok && clip.data.items[0].text === '剪贴板测试', '剪贴板发送');
  const clipGet = await j(48200, 'GET', '/api/clipboard');
  check(clipGet.data.items.length === 1, '剪贴板读取');
  const clipDel = await j(48200, 'DELETE', `/api/clipboard?id=${clip.data.item.id}`);
  check(clipDel.data.items.length === 0, '剪贴板删除');

  const delivery = await j(48200, 'PUT', '/api/delivery', { path: '课程设计/素材', quick: false });
  check(delivery.data.ok && delivery.data.delivery.path === '课程设计/素材', '设置投递位置');

  const dirs = await j(48200, 'GET', '/api/tree-dirs');
  check(dirs.data.dirs.some((d) => d.path === '课程设计/素材'), '目录树');

  const move = await j(48200, 'POST', '/api/move', { paths: ['课程设计/素材/测试.txt'], to: '临时收件箱' });
  check(move.data.ok && fs.existsSync(path.join(root, '临时收件箱', '测试.txt')), '移动文件');

  const transfers = await j(48200, 'GET', '/api/transfers');
  check(transfers.data.items.length >= 1, '传输记录');

  const tunnel = await j(48200, 'GET', '/api/tunnel');
  check(tunnel.data.ok, '隧道接口');

  const floatFail = await j(48200, 'POST', '/api/float-window', { action: 'toggle' });
  check(floatFail.status === 400, '独立服务模式不支持悬浮窗');

  const del = await j(48200, 'POST', '/api/delete', { paths: ['临时收件箱/测试.txt'] });
  check(del.data.ok && !fs.existsSync(path.join(root, '临时收件箱', '测试.txt')), '删除文件');

  await testAuth();
  await testSync();

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
}

async function testAuth() {
  console.log('\n访问口令：');
  const dataDir = path.join(tmpRoot, 'auth-data');
  const root = path.join(tmpRoot, 'auth-root');
  fs.mkdirSync(root, { recursive: true });
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/standalone.js'), '--data-dir', dataDir, '--root', root, '--port', '48201', '--code', '123456', '--no-sync'], { stdio: 'ignore' });
  try {
    await waitServer(48201);
    const noAuth = await j(48201, 'GET', '/api/list?path=');
    check(noAuth.status === 401, '无口令被拒绝');
    const authed = await j(48201, 'GET', '/api/list?path=', undefined, { 'x-access-code': '123456' });
    check(authed.status === 200 && authed.data.ok, '带口令可访问');
    const wrong = await j(48201, 'POST', '/api/auth', { code: '000000' });
    check(wrong.status === 401, '错误口令');
  } finally {
    proc.kill('SIGTERM');
  }
}

async function testSync() {
  console.log('\n双实例同步：');
  const { createServer } = require(path.join(ROOT, 'server/index.js'));
  const { Store } = require(path.join(ROOT, 'server/config.js'));
  const aRoot = path.join(tmpRoot, 'sync-a');
  const bRoot = path.join(tmpRoot, 'sync-b');
  fs.mkdirSync(aRoot, { recursive: true });
  fs.mkdirSync(bRoot, { recursive: true });
  const storeA = new Store(path.join(tmpRoot, 'sync-a-data'), { root: aRoot, port: 48210, syncPort: 48310 });
  const storeB = new Store(path.join(tmpRoot, 'sync-b-data'), { root: bRoot, port: 48211, syncPort: 48311 });
  const a = await createServer({ store: storeA, rendererDir: path.join(ROOT, 'renderer'), assetsDir: path.join(ROOT, 'assets'), log: () => {} }).start(48210);
  const b = await createServer({ store: storeB, rendererDir: path.join(ROOT, 'renderer'), assetsDir: path.join(ROOT, 'assets'), log: () => {} }).start(48211);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await a.sync.addPeer('127.0.0.1', 48211);
    const payload = Buffer.from('sync me');
    await raw(48211, 'POST', '/api/upload?path=&name=sync.txt', payload);
    let ok = false;
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(path.join(aRoot, 'sync.txt'))) {
        ok = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check(ok, 'A 自动收到 B 的文件');
    if (ok) {
      const text = fs.readFileSync(path.join(aRoot, 'sync.txt'), 'utf8');
      check(text === 'sync me', '同步内容一致');
    }
  } finally {
    await a.close();
    await b.close();
  }
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(() => {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  });
