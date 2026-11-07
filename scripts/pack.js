#!/usr/bin/env node
'use strict';

/**
 * 打包脚本：
 *   node scripts/pack.js mac   → dist/FileBridge.app + dist/FileBridge-mac-arm64.zip (+ dmg)
 *   node scripts/pack.js win   → dist/FileBridge-win-x64.zip
 *   node scripts/pack.js all
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ELECTRON_VERSION = require(path.join(ROOT, 'node_modules/electron/package.json')).version;
const APP_NAME = 'FileBridge';
const PRODUCT = 'FileBridge';

function run(bin, args, options = {}) {
  return execFileSync(bin, args, { stdio: 'inherit', ...options });
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyPayload(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['package.json', 'main.js', 'preload.js', 'README.md']) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, file));
  }
  for (const dir of ['server', 'renderer', 'assets']) {
    fs.cpSync(path.join(ROOT, dir), path.join(dest, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
  copyProdModules(dest);
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'qrcode-generator', 'package.json'))) {
    // 有些依赖库在运行时读取 license/README，整目录已复制，无需额外处理
  }
}

function copyProdModules(dest) {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { cwd: ROOT, encoding: 'utf8' });
  const seen = new Set();
  for (const line of out.split('\n')) {
    const abs = line.trim();
    if (!abs) continue;
    const rel = path.relative(ROOT, abs);
    if (!rel.startsWith(`node_modules${path.sep}`)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(abs, target, { recursive: true });
  }
  console.log(`  已复制 ${seen.size} 个生产依赖目录`);
}

function findCacheZip(platformArch) {
  const cacheDir = path.join(os.homedir(), 'Library/Caches/electron');
  const match = `electron-v${ELECTRON_VERSION}-${platformArch}.zip`;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.name === match) found.push(abs);
    }
  };
  walk(cacheDir, 0);
  return found[0] || '';
}

function makeIcns() {
  const png = path.join(ROOT, 'assets', 'app-icon.png');
  if (!fs.existsSync(png)) return '';
  const iconset = path.join(DIST, 'app-icon.iconset');
  rimraf(iconset);
  fs.mkdirSync(iconset, { recursive: true });
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of sizes) {
    run('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
  const icns = path.join(DIST, `${APP_NAME}.icns`);
  run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  rimraf(iconset);
  return icns;
}

function buildMac() {
  const zip = findCacheZip('darwin-arm64');
  let electronApp = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
  if (zip) {
    const work = path.join(DIST, 'mac-build');
    rimraf(work);
    fs.mkdirSync(work, { recursive: true });
    run('ditto', ['-x', '-k', zip, work], { stdio: 'inherit' });
    electronApp = path.join(work, 'Electron.app');
  }
  if (!fs.existsSync(electronApp)) throw new Error('未找到 Electron.app，请先 npm install');
  const appDir = path.join(DIST, `${PRODUCT}.app`);
  rimraf(appDir);
  run('ditto', [electronApp, appDir], { stdio: 'inherit' });

  const resources = path.join(appDir, 'Contents', 'Resources');
  const appPayload = path.join(resources, 'app');
  rimraf(appPayload);
  copyPayload(appPayload);

  const icns = makeIcns();
  if (icns) {
    fs.copyFileSync(icns, path.join(resources, `${APP_NAME}.icns`));
  }

  const macosExecutable = path.join(appDir, 'Contents', 'MacOS', 'Electron');
  const renamedExecutable = path.join(appDir, 'Contents', 'MacOS', APP_NAME);
  if (fs.existsSync(macosExecutable)) fs.renameSync(macosExecutable, renamedExecutable);

  const plist = path.join(appDir, 'Contents', 'Info.plist');
  const plistSet = (key, value) => {
    try {
      run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
    } catch {
      run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'ignore' });
    }
  };
  plistSet('CFBundleExecutable', APP_NAME);
  plistSet('CFBundleDisplayName', APP_NAME);
  plistSet('CFBundleName', APP_NAME);
  plistSet('CFBundleIdentifier', 'com.leoleo.filebridge');
  plistSet('CFBundleShortVersionString', '1.0.0');
  plistSet('CFBundleVersion', '1.0.0');
  if (icns) plistSet('CFBundleIconFile', `${APP_NAME}.icns`);
  plistSet('NSLocalNetworkUsageDescription', 'FileBridge 需要访问局域网，用于发现和同步同一 Wi-Fi 下的设备');
  try {
    run('/usr/libexec/PlistBuddy', ['-c', 'Add :NSBonjourServices array', plist], { stdio: 'ignore' });
  } catch { /* 已存在 */ }
  try {
    run('/usr/libexec/PlistBuddy', ['-c', 'Add :NSBonjourServices:0 string _filebridge._tcp', plist], { stdio: 'ignore' });
  } catch { /* 已存在 */ }

  try {
    run('xattr', ['-cr', appDir], { stdio: 'ignore' });
    run('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' });
    run('codesign', ['--verify', '--deep', '--strict', appDir], { stdio: 'ignore' });
    console.log('  ad-hoc 签名校验通过');
  } catch (error) {
    console.log('（签名失败：', error.message, '）');
  }

  const zipPath = path.join(DIST, `${PRODUCT}-mac-arm64.zip`);
  rimraf(zipPath);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDir, zipPath], { stdio: 'inherit' });

  // DMG：里面放 App + Applications 快捷方式，用户拖进去即安装
  const dmgStage = path.join(DIST, 'dmg-stage');
  rimraf(dmgStage);
  fs.mkdirSync(dmgStage, { recursive: true });
  run('ditto', [appDir, path.join(dmgStage, `${PRODUCT}.app`)], { stdio: 'inherit' });
  try {
    fs.symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
  } catch {
    /* ignore */
  }
  const dmgPath = path.join(DIST, `${PRODUCT}-mac-arm64.dmg`);
  try {
    rimraf(dmgPath);
    run('hdiutil', ['create', '-volname', PRODUCT, '-srcfolder', dmgStage, '-ov', '-format', 'UDZO', dmgPath], { stdio: 'ignore' });
  } catch (error) {
    console.log('（跳过 dmg：', error.message, '）');
  }
  rimraf(dmgStage);

  // PKG：双击安装器，自动装到 /Applications
  const pkgRoot = path.join(DIST, 'pkg-root');
  rimraf(pkgRoot);
  fs.mkdirSync(path.join(pkgRoot, 'Applications'), { recursive: true });
  run('ditto', [appDir, path.join(pkgRoot, 'Applications', `${PRODUCT}.app`)], { stdio: 'inherit' });
  const pkgPath = path.join(DIST, `${PRODUCT}-1.0.0.pkg`);
  try {
    rimraf(pkgPath);
    run('pkgbuild', [
      '--root', pkgRoot,
      '--identifier', 'com.leoleo.filebridge',
      '--version', '1.0.0',
      '--install-location', '/',
      '--ownership', 'recommended',
      pkgPath,
    ], { stdio: 'inherit' });
  } catch (error) {
    console.log('（跳过 pkg：', error.message, '）');
  }
  rimraf(pkgRoot);
  console.log(`\n✅ macOS 打包完成：\n  ${appDir}\n  ${zipPath}${fs.existsSync(dmgPath) ? `\n  ${dmgPath}` : ''}`);
}

function buildWin() {
  const zip = findCacheZip('win32-x64');
  if (!zip) throw new Error('未找到 electron win32-x64 缓存包，请先在有网络的环境执行一次 npm install');
  const work = path.join(DIST, 'win-build');
  rimraf(work);
  fs.mkdirSync(work, { recursive: true });
  run('unzip', ['-q', zip, '-d', work], { stdio: 'inherit' });

  const appPayload = path.join(work, 'resources', 'app');
  copyPayload(appPayload);
  const exe = path.join(work, 'electron.exe');
  const targetExe = path.join(work, `${PRODUCT}.exe`);
  if (fs.existsSync(exe)) fs.renameSync(exe, targetExe);

  fs.writeFileSync(
    path.join(work, 'README-Windows.txt'),
    [
      'FileBridge for Windows（免安装）',
      '',
      '1. 首次运行前，Windows 防火墙弹窗请选择「允许访问」（专用网络即可）。',
      '2. 双击 FileBridge.exe 启动。',
      '3. 如果 SmartScreen 提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。',
      '4. 共享目录默认在 C:\\Users\\<你的用户名>\\FileBridge。',
      '5. 手机与电脑连同一个 Wi-Fi，扫描主窗口「手机访问」里的二维码即可打开。',
      '6. 与 Mac 同步：两台设备都打开 FileBridge、连同一网络；异地时都装 Tailscale。',
      '',
      '数据目录：%APPDATA%\\FileBridge（设置、隧道 token、剪贴板等）',
    ].join('\r\n'),
  );

  const outZip = path.join(DIST, `${PRODUCT}-win-x64.zip`);
  rimraf(outZip);
  run('zip', ['-qr', '-X', outZip, '.'], { cwd: work, stdio: 'inherit' });
  console.log(`\n✅ Windows 打包完成：\n  ${outZip}`);
  console.log('   解压后双击 FileBridge.exe 即可运行');
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  const target = process.argv[2] || 'all';
  if (target === 'mac' || target === 'all') buildMac();
  if (target === 'win' || target === 'all') buildWin();
}

main();
