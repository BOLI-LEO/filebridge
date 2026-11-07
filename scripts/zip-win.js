#!/usr/bin/env node
'use strict';

/** 把 dist/win-unpacked 打成 dist/FileBridge-win-x64.zip */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(DIST, 'win-unpacked');
const STAGE = path.join(DIST, 'zip-stage');
const OUT = path.join(DIST, 'FileBridge-win-x64.zip');

if (!fs.existsSync(SRC)) {
  console.error('找不到 dist/win-unpacked，请先执行 npx electron-builder --win nsis --x64');
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(SRC, path.join(STAGE, 'FileBridge-win-x64'), { recursive: true });
fs.writeFileSync(
  path.join(STAGE, 'FileBridge-win-x64', 'README-Windows.txt'),
  [
    'FileBridge for Windows（免安装）',
    '1. 双击 FileBridge.exe 启动。',
    '2. 防火墙弹窗选「允许专用网络」。',
    '3. SmartScreen 提示时点「更多信息 → 仍要运行」。',
    '4. 共享目录可在「设置 → 共享目录 → 更改」修改。',
    '5. 访问口令与另一台设备保持一致。',
    '',
  ].join('\n'),
);

fs.rmSync(OUT, { force: true });
try {
  execFileSync('zip', ['-qr', '-X', OUT, 'FileBridge-win-x64'], { cwd: STAGE, stdio: 'inherit' });
} catch (error) {
  console.error('打包需要 zip 命令（macOS/Linux 自带；Windows 可用 Compress-Archive）');
  process.exit(1);
} finally {
  fs.rmSync(STAGE, { recursive: true, force: true });
}
console.log(`✅ 已生成 ${OUT}`);
