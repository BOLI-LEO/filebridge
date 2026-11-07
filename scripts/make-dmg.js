#!/usr/bin/env node
'use strict';

/**
 * 生成 macOS 安装镜像：左侧 App，右侧 Applications 快捷方式，
 * 带背景图和窗口布局。需要 appdmg（devDependency）。
 */
const path = require('path');
const fs = require('fs');
const appdmg = require('appdmg');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'FileBridge.app');
const OUT = path.join(DIST, 'FileBridge-mac-arm64.dmg');

if (!fs.existsSync(APP)) {
  console.error('找不到 dist/FileBridge.app，请先执行 npm run pack:mac:app');
  process.exit(1);
}

const spec = {
  title: 'FileBridge',
  icon: path.join(ROOT, 'assets', 'app-icon.icns'),
  background: path.join(ROOT, 'assets', 'dmg-background.png'),
  'icon-size': 96,
  window: {
    size: { width: 640, height: 420 },
    position: { x: 200, y: 120 },
  },
  contents: [
    { x: 180, y: 230, type: 'file', path: APP },
    { x: 460, y: 230, type: 'link', path: '/Applications' },
  ],
  format: 'UDZO',
};

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const emitter = appdmg({ target: OUT, basepath: ROOT, specification: spec });
emitter.on('progress', (info) => {
  if (info.type === 'step-begin') console.log(`  [dmg] ${info.title}`);
});
emitter.on('error', (error) => {
  console.error('创建 DMG 失败:', error);
  process.exit(1);
});
emitter.on('finish', () => {
  console.log(`✅ DMG 已生成: ${OUT}`);
});
