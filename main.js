'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./server/config');
const { createServer } = require('./server');

const APP_NAME = 'FileBridge';
const COLLAPSED_WIDTH = 44;
const COLLAPSED_HEIGHT = 44;
const PANEL_WIDTH = 272;
const PANEL_HEIGHT = 320;

let store = null;
let server = null;
let mainWindow = null;
let splashWindow = null;
let floatWindow = null;
let tray = null;
let quitting = false;
let shuttingDown = false;
let floatExpanded = false;
let floatDragOffset = null;
let floatDragging = false;
let floatDragTimer = null;
let floatDragMoved = false;
let floatDragStartPoint = null;
let floatState = { x: null, y: null, expanded: false };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  start().catch((error) => {
    dialog.showErrorBox('FileBridge 启动失败', String((error && error.stack) || error));
    app.quit();
  });
}

function baseUrl() {
  if (!server) return 'http://127.0.0.1:47890';
  const code = store.get('accessCode');
  return `http://127.0.0.1:${server.port}/${code ? `?code=${encodeURIComponent(code)}` : ''}`;
}

function loadFloatState() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'float-window.json'), 'utf8'));
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) floatState.x = raw.x;
    if (Number.isFinite(raw.y)) floatState.y = raw.y;
    floatState.expanded = raw.expanded === true;
  } catch {
    /* 首次运行 */
  }
}

function floatAlive() {
  return Boolean(floatWindow) && !floatWindow.isDestroyed();
}

function saveFloatState() {
  if (!floatAlive()) return;
  try {
    const bounds = floatWindow.getBounds();
    if (floatExpanded) {
      floatState.x = bounds.x;
      floatState.y = bounds.y;
    }
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'float-window.json'),
      JSON.stringify({ ...floatState, x: floatState.x, y: floatState.y, expanded: floatExpanded }, null, 2),
    );
  } catch {
    /* ignore */
  }
}

async function start() {
  await app.whenReady();
  app.setName(APP_NAME);
  if (process.platform === 'darwin') {
    // 确保是普通前台应用（有 Dock 图标），而不是后台代理
    try {
      app.setActivationPolicy('regular');
    } catch {
      /* ignore */
    }
    if (app.dock) {
      try {
        app.dock.show();
        app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'app-icon.png')));
      } catch {
        /* ignore */
      }
    }
  }

  store = new Store(app.getPath('userData'));
  loadFloatState();
  createSplashWindow();

  server = createServer({
    store,
    rendererDir: path.join(__dirname, 'renderer'),
    assetsDir: path.join(__dirname, 'assets'),
    isElectron: true,
    onOpenFolder: async () => {
      const error = await shell.openPath(store.get('root'));
      if (error) throw new Error(error);
    },
    onOpenPath: async (abs) => {
      const error = await shell.openPath(abs);
      if (error) throw new Error(error);
    },
    onFloatWindow: (action) => floatControl(action),
    cloudflaredPaths: [path.join(process.resourcesPath || '', 'bin'), path.join(__dirname, 'bin')],
    log: (...messages) => console.log(...messages),
  });
  server = await server.start(store.get('port'));

  registerIpc();
  createMainWindow();
  createFloatWindow();
  createTray();
  createMenu();
  setTimeout(() => {
    if (splashWindow) {
      splashWindow.destroy();
      splashWindow = null;
      if (mainWindow) mainWindow.show();
    }
  }, 12000);

  app.on('activate', () => showMain());
  app.on('window-all-closed', () => {
    /* 保留托盘与文件服务 */
  });
  app.on('before-quit', (event) => shutdown(event));
  if (process.env.FB_CAPTURE_DIR) captureForTest();
  screen.on('display-removed', () => ensureFloatVisible());
  screen.on('display-metrics-changed', () => ensureFloatVisible());
}

async function captureForTest() {
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const dir = process.env.FB_CAPTURE_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (mainWindow) {
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'main.png'), image.toPNG());
    }
    floatControl('expand');
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (floatWindow) {
      const image = await floatWindow.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'float.png'), image.toPNG());
    }
    console.log('[test] captured to', dir);
  } catch (error) {
    console.error('[test] capture failed', error);
  }
  if (process.env.FB_CAPTURE_EXIT === '1') app.quit();
}

function registerIpc() {
  ipcMain.handle('dialog:pick-directory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择共享文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('float:get-state', () => ({
    expanded: floatExpanded,
    bounds: floatAlive() ? floatWindow.getBounds() : null,
    platform: process.platform,
  }));
  ipcMain.handle('float:set-expanded', (event, expanded, height) => {
    setFloatExpanded(Boolean(expanded), Number(height) || PANEL_HEIGHT);
    return { expanded: floatExpanded, bounds: floatAlive() ? floatWindow.getBounds() : null };
  });
  ipcMain.handle('float:drag-start', () => {
    if (!floatWindow) return false;
    const point = screen.getCursorScreenPoint();
    const bounds = floatWindow.getBounds();
    floatDragOffset = { x: point.x - bounds.x, y: point.y - bounds.y };
    floatDragMoved = false;
    floatDragStartPoint = point;
    if (floatDragTimer) clearInterval(floatDragTimer);
    floatDragTimer = setInterval(() => {
      if (!floatWindow || !floatDragOffset) return;
      const cursor = screen.getCursorScreenPoint();
      if (floatDragStartPoint && (Math.abs(cursor.x - floatDragStartPoint.x) > 3 || Math.abs(cursor.y - floatDragStartPoint.y) > 3)) {
        floatDragMoved = true;
      }
      floatWindow.setPosition(
        Math.round(cursor.x - floatDragOffset.x),
        Math.round(cursor.y - floatDragOffset.y),
      );
    }, 16);
    return true;
  });
  ipcMain.handle('float:drag-end', () => {
    if (floatDragTimer) clearInterval(floatDragTimer);
    floatDragTimer = null;
    floatDragOffset = null;
    const moved = floatDragMoved;
    floatDragMoved = false;
    floatDragStartPoint = null;
    if (floatWindow) {
      saveFloatState();
      snapFloat();
    }
    return { moved };
  });
  ipcMain.on('float:open-main', () => showMain());
  ipcMain.on('float:open-settings', () => {
    showMain();
    if (mainWindow) mainWindow.webContents.send('ui:open-settings');
  });
  ipcMain.on('float:hide', () => {
    if (floatWindow) floatWindow.hide();
  });
  ipcMain.on('float:quit', () => app.quit());
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 440,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: APP_NAME,
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.show();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#111923',
    title: APP_NAME,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const url = baseUrl();
  console.log(`[filebridge] 主窗口加载 ${url}`);
  mainWindow.loadURL(url).catch((error) => console.error('[filebridge] loadURL 失败', error));
  mainWindow.webContents.on('did-fail-load', (event, code, description, failedUrl) => {
    console.error(`[filebridge] 页面加载失败 ${code} ${description} ${failedUrl}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[filebridge] 渲染进程退出', details);
  });
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.destroy();
        splashWindow = null;
      }
      if (!quitting) mainWindow.show();
    }, 700);
  });
  mainWindow.on('close', (event) => {
    if (quitting || shuttingDown) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createFloatWindow() {
  const expanded = floatExpanded;
  const width = expanded ? PANEL_WIDTH : COLLAPSED_WIDTH;
  const height = expanded ? PANEL_HEIGHT : COLLAPSED_HEIGHT;
  const position = floatPosition(width, height);
  floatWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'FileBridge 悬浮窗',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  floatWindow.setAlwaysOnTop(true, 'floating');
  floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatWindow.loadURL(`${baseUrl().split('?')[0]}floating.html${baseUrl().includes('?') ? baseUrl().slice(baseUrl().indexOf('?')) : ''}`);
  floatWindow.once('closed', () => {
    floatWindow = null;
  });
  floatWindow.once('ready-to-show', () => {
    floatWindow.showInactive();
    if (floatExpanded) {
      // 让渲染层知道初始状态
      floatWindow.webContents.send('float:state', { expanded: true });
    }
  });
  floatWindow.on('moved', () => {
    if (floatDragTimer || floatDragging) return;
    saveFloatState();
  });
}

function floatPosition(width, height) {
  const display = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(floatState.x) ? floatState.x : display.x + display.width - width - 24;
  let y = Number.isFinite(floatState.y) ? floatState.y : display.y + 64;
  x = Math.min(Math.max(x, display.x + 8), display.x + display.width - width - 8);
  y = Math.min(Math.max(y, display.y + 8), display.y + display.height - height - 8);
  return { x: Math.round(x), y: Math.round(y) };
}

function snapFloat() {
  if (!floatAlive()) return;
  const bounds = floatWindow.getBounds();
  const display = screen.getDisplayMatching(bounds).workArea;
  const distance = 24;
  let { x, y } = bounds;
  if (Math.abs(x - display.x) < distance) x = display.x + 8;
  if (Math.abs(x + bounds.width - (display.x + display.width)) < distance) x = display.x + display.width - bounds.width - 8;
  if (Math.abs(y - display.y) < distance) y = display.y + 8;
  if (Math.abs(y + bounds.height - (display.y + display.height)) < distance) y = display.y + display.height - bounds.height - 8;
  if (x !== bounds.x || y !== bounds.y) floatWindow.setBounds({ ...bounds, x, y });
}

function setFloatExpanded(expanded, height) {
  if (!floatAlive()) return;
  const bounds = floatWindow.getBounds();
  const nextWidth = expanded ? PANEL_WIDTH : COLLAPSED_WIDTH;
  const nextHeight = expanded ? Math.max(260, Math.min(height, 640)) : COLLAPSED_HEIGHT;
  const right = bounds.x + bounds.width;
  const x = expanded ? right - nextWidth : right - nextWidth;
  const y = bounds.y;
  floatWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: nextWidth, height: nextHeight });
  floatExpanded = expanded;
  saveFloatState();
  return { expanded: floatExpanded, bounds: floatWindow.getBounds() };
}

function ensureFloatVisible() {
  if (!floatAlive()) return;
  const bounds = floatWindow.getBounds();
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  });
  if (!visible) {
    const position = floatPosition(bounds.width, bounds.height);
    floatWindow.setBounds({ ...position, width: bounds.width, height: bounds.height });
  }
}

function floatControl(action) {
  if (!floatAlive()) return { visible: false };
  switch (action) {
    case 'show':
      floatWindow.showInactive();
      break;
    case 'hide':
      floatWindow.hide();
      break;
    case 'expand':
      setFloatExpanded(true, PANEL_HEIGHT);
      floatWindow.showInactive();
      break;
    case 'collapse':
      setFloatExpanded(false, COLLAPSED_HEIGHT);
      break;
    case 'toggle':
    default:
      if (floatWindow.isVisible()) floatWindow.hide();
      else floatWindow.showInactive();
      break;
  }
  return { visible: floatWindow.isVisible(), expanded: floatExpanded, bounds: floatWindow.getBounds() };
}

function createTray() {
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'trayTemplate.png')
    : path.join(__dirname, 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    image = image.resize({ width: 18, height: 18 });
    image.setTemplateImage(true);
  } else {
    image = image.resize({ width: 16, height: 16 });
  }
  tray = new Tray(image);
  tray.setToolTip('FileBridge · 局域网文件互通');
  const menu = Menu.buildFromTemplate([
    { label: '打开 FileBridge', click: () => showMain() },
    {
      label: '显示/隐藏悬浮窗',
      click: () => floatControl('toggle'),
    },
    { type: 'separator' },
    { label: '打开共享文件夹', click: () => shell.openPath(store.get('root')) },
    {
      label: '复制手机访问地址',
      click: () => {
        const info = server && server.getInfo ? server.getInfo() : null;
        if (info && info.qr && info.qr.url) clipboard.writeText(info.qr.url);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMain());
}

function createMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '打开共享文件夹', click: () => shell.openPath(store.get('root')) },
        { label: '显示悬浮窗', click: () => floatControl('show') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showMain() {
  if (!mainWindow) return;
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.show();
    } catch {
      /* ignore */
    }
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function shutdown(event) {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  quitting = true;
  try {
    saveFloatState();
    if (floatDragTimer) clearInterval(floatDragTimer);
    if (splashWindow) splashWindow.destroy();
    if (floatWindow) floatWindow.destroy();
    if (mainWindow) mainWindow.destroy();
    if (server) await server.close();
    if (tray) tray.destroy();
  } catch {
    /* ignore */
  }
  app.exit(0);
}
