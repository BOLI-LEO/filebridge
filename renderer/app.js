'use strict';

/* FileBridge 主窗口前端 */

const $ = (sel) => document.querySelector(sel);
const state = {
  info: null,
  path: '',
  entries: [],
  selection: new Set(),
  clipboard: [],
  transfers: [],
  peers: [],
  uploads: new Map(),
  dirs: [],
  theme: localStorage.getItem('fb-theme') === 'dark' ? 'dark' : 'light',
  topDirs: [],
  filter: '',
  ws: null,
  wsDelay: 800,
  loading: false,
  uploading: false,
};

const CHUNK_SIZE = location.protocol === 'https:' ? 256 * 1024 : 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ICON_BY_EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  zip: ['zip', 'rar', '7z', 'tar', 'gz', 'dmg'],
};

function icon(name, cls = 'icon') {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function fmtTime(ms) {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function toast(message, kind = 'info') {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast show ${kind}`;
  clearTimeout(box._timer);
  box._timer = setTimeout(() => {
    box.className = 'toast';
  }, kind === 'error' ? 5200 : 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    showLogin();
    throw new Error((data && data.error) || '需要访问口令');
  }
  if (!data) throw new Error(`服务返回异常 (HTTP ${res.status})`);
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
  return data;
}

/* ---------------- 主题 ---------------- */

function applyTheme() {
  const theme = state.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function cycleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('fb-theme', state.theme);
  applyTheme();
  toast(state.theme === 'dark' ? '深色主题' : '浅色主题');
}

/* ---------------- 登录 ---------------- */

function showLogin(message = '') {
  if (typeof hideSplash === 'function') hideSplash();
  if ($('#login-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'login-dialog';
  dialog.className = 'dialog';
  dialog.innerHTML = `
    <form method="dialog" class="dialog-body login-body">
      <div class="login-icon">${icon('bridge', 'icon lg')}</div>
      <h2>输入访问口令</h2>
      <p class="muted small">这台设备已启用访问口令，请输入正确口令后继续。</p>
      <input class="field" id="login-code" type="password" maxlength="32" autocomplete="off" placeholder="访问口令" aria-label="访问口令">
      <p class="login-error small" id="login-error">${message}</p>
      <button class="btn primary" id="login-submit" type="submit">连接</button>
    </form>`;
  document.body.appendChild(dialog);
  dialog.showModal();
  const input = dialog.querySelector('#login-code');
  input.focus();
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    try {
      await api('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      dialog.close();
      dialog.remove();
      await boot();
    } catch (error) {
      dialog.querySelector('#login-error').textContent = error.message;
    }
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  applyTheme();
  try {
    const info = await api('/api/info');
    if (info.auth && info.auth.required && info.auth.authenticated === false) {
      showLogin();
      return;
    }
    state.info = info;
    state.peers = (info.sync && info.sync.peers) || [];
    state.transfers = info.transfers || [];
    try {
      const rootData = await api('/api/list?path=');
      state.topDirs = rootData.entries.filter((entry) => entry.isDir).map((entry) => entry.name);
    } catch {
      state.topDirs = [];
    }
    renderChrome();
    const initial = new URLSearchParams(location.search).get('path');
    if (initial) state.path = initial;
    await loadList(state.path);
    await Promise.all([loadClipboard(), loadTransfers()]);
    connectWS();
  } catch (error) {
    if (error.message !== '需要访问口令') toast(error.message, 'error');
  } finally {
    hideSplash();
  }
}

let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 500);
}
setTimeout(hideSplash, 8000);

/* ---------------- 基础渲染 ---------------- */

function renderChrome() {
  const info = state.info;
  if (!info) return;
  $('#local-device').innerHTML = `<span class="dot"></span>${escapeHtml(info.device.name)}${info.device.isElectron ? '' : ' · 网页'}`;
  $('#root-path').textContent = info.server.root;
  $('#root-path').title = info.server.root;
  $('#addr') && ($('#addr').textContent = info.server.shareUrl);
  document.title = `${info.device.name} · FileBridge`;
  renderPeers();
  renderChip();
  renderProjects();
  updateClipCount();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text == null ? '' : text);
  return div.innerHTML;
}

function renderPeers() {
  const peers = state.peers || [];
  const online = peers.filter((peer) => peer.online).length;
  const count = $('#peer-count');
  if (count) count.textContent = `${online}/${peers.length}`;
  renderChip();
}

function renderChip() {
  const chip = $('#sync-chip');
  if (!chip) return;
  const peers = (state.peers || []).filter((peer) => peer.online);
  if (!peers.length) {
    chip.innerHTML = `<span class="dot off"></span>暂无在线设备`;
    return;
  }
  const peer = peers[0];
  const link = peer.link === 'tailscale' ? 'Tailscale' : '局域网';
  chip.innerHTML = `<span class="dot"></span>${escapeHtml(peer.name)} · ${link}直连`;
}

function renderProjects() {
  const box = $('#projects');
  if (!box) return;
  const projects = (state.info && state.info.projects && state.info.projects.length)
    ? state.info.projects
    : state.topDirs;
  box.innerHTML = '';
  for (const project of projects) {
    const button = document.createElement('button');
    button.className = 'proj';
    button.innerHTML = `${icon('folder')}<span></span>`;
    button.querySelector('span').textContent = project;
    button.addEventListener('click', () => {
      state.selection.clear();
      loadList(project);
    });
    box.appendChild(button);
  }
  if (!projects.length) {
    const hint = document.createElement('div');
    hint.className = 'small muted';
    hint.style.padding = '4px 8px';
    hint.textContent = '顶层的项目文件夹会显示在这里';
    box.appendChild(hint);
  }
}

function updateClipCount() {
  const count = $('#clip-count');
  if (count) count.textContent = String(state.clipboard.length || 0);
}

function renderCrumbs() {
  const box = $('#crumbs');
  box.innerHTML = '';
  const parts = state.path ? state.path.split('/') : [];
  const all = document.createElement('button');
  all.className = 'part';
  all.textContent = '全部文件';
  all.addEventListener('click', () => goTo(''));
  box.appendChild(all);
  parts.forEach((part, index) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    box.appendChild(sep);
    const button = document.createElement('button');
    button.className = 'part' + (index === parts.length - 1 ? ' cur' : '');
    button.textContent = part;
    button.addEventListener('click', () => goTo(parts.slice(0, index + 1).join('/')));
    box.appendChild(button);
  });
  $('#btn-back').disabled = !state.path;
}

function goTo(path) {
  state.selection.clear();
  state.filter = '';
  $('#search').value = '';
  loadList(path);
}

/* ---------------- 文件列表 ---------------- */

async function loadList(path) {
  $('#loading').hidden = false;
  $('#file-table').hidden = true;
  $('#empty').hidden = true;
  try {
    const data = await api(`/api/list?path=${encodeURIComponent(path)}`);
    state.path = data.path;
    state.entries = data.entries;
    renderCrumbs();
    renderFiles();
    renderToolbar();
    renderDetail();
    if (state.info) {
      state.info.delivery = state.info.delivery || { path: '' };
    }
  } catch (error) {
    if (error.message !== '需要访问口令') toast(error.message, 'error');
    $('#file-table').hidden = true;
    $('#empty').hidden = true;
  } finally {
    $('#loading').hidden = true;
  }
}

function extKind(entry) {
  if (entry.isDir) return 'dir';
  const ext = (entry.ext || '').toLowerCase();
  if (ICON_BY_EXT.image.includes(ext)) return 'image';
  if (ICON_BY_EXT.video.includes(ext)) return 'video';
  if (ICON_BY_EXT.zip.includes(ext)) return 'zip';
  return 'file';
}

function transferFor(entry) {
  return state.transfers.filter((item) => item.path === entry.path).sort((a, b) => b.createdAt - a.createdAt)[0];
}

function statusFor(entry) {
  if (entry.isDir) return null;
  const transfer = transferFor(entry);
  if (transfer) {
    if (transfer.state === 'confirmed') return null;
    const online = state.peers.some((peer) => peer.online);
    return { text: online ? '同步中' : '等待设备', cls: online ? 'syncing' : 'waiting' };
  }
  return null;
}

function renderFiles() {
  const body = $('#file-list');
  body.innerHTML = '';
  const keyword = state.filter.trim().toLowerCase();
  const entries = keyword
    ? state.entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
    : state.entries;

  $('#file-table').hidden = entries.length === 0;
  $('#empty').hidden = entries.length !== 0;
  if (!entries.length) {
    $('#empty').querySelector('h2').textContent = keyword ? '没有匹配的文件' : '这里还没有文件';
    $('#empty').querySelector('p').textContent = keyword
      ? `没有找到包含「${state.filter}」的文件`
      : '拖入文件，或点击左上角上传。';
  }

  for (const entry of entries) {
    const row = document.createElement('tr');
    row.dataset.path = entry.path;
    if (state.selection.has(entry.path)) row.classList.add('on');

    const checkCell = document.createElement('td');
    checkCell.className = 'c-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'cb';
    checkbox.checked = state.selection.has(entry.path);
    checkbox.setAttribute('aria-label', `选择 ${entry.name}`);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selection.add(entry.path);
      else state.selection.delete(entry.path);
      row.classList.toggle('on', checkbox.checked);
      renderToolbar();
      renderDetail();
    });
    checkCell.appendChild(checkbox);

    const nameCell = document.createElement('td');
    nameCell.className = 'c-name';
    const nameBox = document.createElement('div');
    nameBox.className = 'name-cell';
    const kind = extKind(entry);
    nameBox.innerHTML = icon(kind, `icon ico${kind === 'dir' ? ' dir' : ''}`);
    const label = document.createElement('span');
    label.className = 'txt';
    label.textContent = entry.name;
    label.title = entry.name;
    nameBox.appendChild(label);
    nameCell.appendChild(nameBox);

    const sizeCell = document.createElement('td');
    sizeCell.className = 'c-size num';
    sizeCell.textContent = entry.isDir ? '—' : fmtSize(entry.size);

    const timeCell = document.createElement('td');
    timeCell.className = 'c-time num';
    timeCell.textContent = fmtTime(entry.mtime);

    const stateCell = document.createElement('td');
    stateCell.className = 'c-state';
    const status = statusFor(entry);
    if (status) {
      const span = document.createElement('span');
      span.className = `state ${status.cls}`;
      span.textContent = status.text;
      stateCell.appendChild(span);
    }

    const actCell = document.createElement('td');
    actCell.className = 'c-act';
    const more = document.createElement('button');
    more.className = 'icon-btn row-more';
    more.setAttribute('aria-label', '更多操作');
    more.innerHTML = icon('more');
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      openRowMenu(entry);
    });
    actCell.appendChild(more);

    row.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        if (state.selection.has(entry.path)) state.selection.delete(entry.path);
        else state.selection.add(entry.path);
      } else {
        state.selection.clear();
        state.selection.add(entry.path);
      }
      renderFiles();
      renderToolbar();
      renderDetail();
    });
    row.addEventListener('dblclick', () => openEntry(entry));
    row.addEventListener('dragover', (event) => {
      if (entry.isDir) {
        event.preventDefault();
        row.style.background = 'var(--fb-surface-active)';
      }
    });
    row.addEventListener('dragleave', () => {
      row.style.background = '';
    });
    row.addEventListener('drop', (event) => {
      if (!entry.isDir) return;
      event.preventDefault();
      row.style.background = '';
      uploadFiles(event.dataTransfer.files, entry.path);
    });

    row.append(checkCell, nameCell, sizeCell, timeCell, stateCell, actCell);
    body.appendChild(row);
  }

  const all = $('#check-all');
  all.checked = entries.length > 0 && entries.every((entry) => state.selection.has(entry.path));
  all.indeterminate = !all.checked && entries.some((entry) => state.selection.has(entry.path));
}

function openEntry(entry) {
  if (entry.isDir) {
    goTo(entry.path);
    return;
  }
  openPreview(entry);
}

/* ---------------- 工具栏 / 详情 ---------------- */

function selectedEntries() {
  return state.entries.filter((entry) => state.selection.has(entry.path));
}

function renderToolbar() {
  const count = state.selection.size;
  const selecting = count > 0;
  $('#sel-info').hidden = !selecting;
  $('#sel-info').innerHTML = `已选 <b>${count} 项</b>`;
  for (const id of ['#btn-download', '#btn-move', '#btn-rename', '#btn-delete', '#btn-cancel-sel']) {
    $(id).hidden = !selecting;
  }
  $('#btn-rename').style.display = count === 1 ? '' : 'none';
  $('#toolbar-default').style.display = selecting ? 'none' : '';
}

function renderDetail() {
  const detail = $('#detail');
  const app = $('#app');
  const selected = selectedEntries();
  if (selected.length !== 1) {
    detail.hidden = true;
    app.classList.remove('with-detail');
    return;
  }
  const entry = selected[0];
  detail.hidden = false;
  app.classList.add('with-detail');
  $('#d-title').textContent = entry.name;
  $('#d-path').textContent = state.path || '全部文件';
  const kind = extKind(entry);
  $('#d-preview').innerHTML = `<div class="ph">${icon(kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'zip' ? 'zip' : kind === 'dir' ? 'folder' : 'file', 'icon lg')}<span>${entry.isDir ? '文件夹' : escapeHtml((entry.ext || '文件').toUpperCase())}</span></div>`;
  $('#d-size').textContent = entry.isDir ? '—' : fmtSize(entry.size);
  $('#d-time').textContent = fmtTime(entry.mtime);
  $('#d-folder').textContent = state.path || '全部文件';
  $('#d-source').textContent = '本机';
  const syncBox = $('#d-sync');
  const status = statusFor(entry);
  if (status) {
    syncBox.innerHTML = `<div class="line"><span class="dot busy"></span>${status.text === '等待设备' ? '等待对端上线' : '正在同步到对端'}</div><div class="bar"><i style="width:68%"></i></div>`;
  } else {
    syncBox.innerHTML = `<div class="line"><span class="dot"></span>已同步</div>`;
  }
  $('#d-preview-btn').disabled = entry.isDir;
  $('#d-download').disabled = entry.isDir;
  $('#d-reveal').disabled = false;
}

/* ---------------- 传输列表 ---------------- */

async function loadTransfers() {
  try {
    const data = await api('/api/transfers');
    state.transfers = data.items;
    renderTransferBar();
    renderFiles();
  } catch {
    /* ignore */
  }
}

function renderTransferBar() {
  const bar = $('#transferbar');
  const pending = state.uploads.size
    ? [...state.uploads.values()].filter((item) => item.status !== 'done')
    : [];
  const transfers = state.transfers.filter((item) => item.state !== 'confirmed').slice(0, 3);
  if (!pending.length && !transfers.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  if (pending.length) {
    const item = pending[0];
    $('#transfer-text').textContent = `上传 ${item.name}`;
    $('#transfer-progress').style.display = '';
    $('#transfer-progress').firstElementChild.style.width = `${Math.round(item.progress * 100)}%`;
    $('#transfer-percent').textContent = `${Math.round(item.progress * 100)}%`;
  } else {
    const item = transfers[0];
    $('#transfer-text').textContent = `同步 ${item.name}`;
    $('#transfer-progress').style.display = '';
    $('#transfer-progress').firstElementChild.style.width = '68%';
    $('#transfer-percent').textContent = '同步中';
  }
}

/* ---------------- 上传 ---------------- */

function uploadFiles(fileList, targetPath = state.path) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.uploads.set(id, {
      id,
      file,
      name: file.name,
      dir: targetPath,
      progress: 0,
      status: 'queued',
      loaded: 0,
      lastTime: Date.now(),
      lastLoaded: 0,
      speed: 0,
      error: '',
      uploadId: '',
    });
  }
  if (location.protocol === 'https:' && files.some((file) => file.size > 5 * 1024 * 1024)) {
    toast('正在通过公网隧道上传，大文件建议同一 Wi-Fi 用局域网地址', 'error');
  }
  renderQueue();
  nextUpload();
}

function nextUpload() {
  if (state.uploading) return;
  const item = [...state.uploads.values()].find((entry) => entry.status === 'queued');
  if (!item) {
    renderTransferBar();
    return;
  }
  state.uploading = true;
  item.status = 'uploading';
  item.startedAt = Date.now();
  renderQueue();
  uploadFileInChunks(item)
    .then(() => {
      item.status = 'done';
      item.progress = 1;
      toast(`已上传 ${item.name}`);
      loadList(state.path);
    })
    .catch((error) => {
      item.status = 'error';
      item.error = error.message || '上传失败';
      toast(`上传失败：${item.error}`, 'error');
    })
    .finally(() => {
      state.uploading = false;
      renderQueue();
      renderTransferBar();
      nextUpload();
    });
}

async function uploadFileInChunks(item) {
  const file = item.file;
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  item.uploadId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 24);
  let uploaded = 0;
  for (let index = 0; index < total; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const blob = file.slice(start, end);
    let attempt = 0;
    let lastError = null;
    let ok = false;
    while (attempt < 3 && !ok) {
      attempt += 1;
      try {
        const data = await sendChunk(item, blob, index, total, (loaded) => {
          item.progress = Math.min(1, (uploaded + loaded) / (file.size || 1));
          const now = Date.now();
          if (now - item.lastTime > 500) {
            item.speed = ((item.progress * file.size) - item.lastLoaded) / ((now - item.lastTime) / 1000);
            item.lastLoaded = item.progress * file.size;
            item.lastTime = now;
          }
          renderQueue();
          renderTransferBar();
        });
        ok = true;
        if (data.done) {
          item.progress = 1;
          return;
        }
      } catch (error) {
        lastError = error;
        await sleep(attempt * 800);
      }
    }
    if (!ok) throw lastError || new Error('分片上传失败');
    uploaded = end;
    item.progress = Math.min(1, uploaded / (file.size || 1));
    renderQueue();
  }
}

function sendChunk(item, blob, index, total, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/upload-chunk?path=${encodeURIComponent(item.dir)}&name=${encodeURIComponent(item.name)}&uploadId=${item.uploadId}&index=${index}&total=${total}`;
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        showLogin();
        reject(new Error('需要访问口令'));
        return;
      }
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status !== 200 || !data || data.ok === false) {
        reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(blob);
  });
}

function renderQueue() {
  const queue = $('#queue');
  const items = [...state.uploads.values()];
  if (!items.length) {
    queue.hidden = true;
    queue.innerHTML = '';
    return;
  }
  queue.hidden = false;
  queue.innerHTML = '';
  const doneCount = items.filter((item) => item.status === 'done').length;
  const header = document.createElement('div');
  header.className = 'queue-head';
  header.innerHTML = `<b>上传队列</b><span class="muted small">${doneCount}/${items.length}</span><button class="icon-btn" id="queue-close" aria-label="关闭">${icon('close')}</button>`;
  queue.appendChild(header);
  for (const item of items.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const name = document.createElement('div');
    name.className = 'queue-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    meta.textContent = item.status === 'done'
      ? '已完成'
      : item.status === 'error'
        ? item.error || '失败'
        : item.status === 'queued'
          ? '等待中'
          : `${Math.round(item.progress * 100)}% · ${fmtSize(item.speed || 0)}/s`;
    const bar = document.createElement('div');
    bar.className = 'queue-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(item.progress * 100)}%`;
    bar.appendChild(fill);
    row.append(name, meta, bar);
    queue.appendChild(row);
  }
  const close = queue.querySelector('#queue-close');
  close.addEventListener('click', () => {
    for (const [id, item] of state.uploads) {
      if (item.status === 'done') state.uploads.delete(id);
    }
    if (![...state.uploads.values()].some((item) => item.status !== 'done')) state.uploads.clear();
    renderQueue();
    renderTransferBar();
  });
}

/* ---------------- 预览 ---------------- */

const DOC_KINDS = new Set(['docx', 'xlsx', 'pptx', 'zip']);

function openPreview(entry) {
  if (entry.isDir) return;
  if (DOC_KINDS.has((entry.ext || '').toLowerCase())) {
    openDocPreview(entry);
    return;
  }
  if (!entry.previewable) {
    openFallbackPreview(entry);
    return;
  }
  const url = `/api/preview?path=${encodeURIComponent(entry.path)}`;
  const ext = (entry.ext || '').toLowerCase();
  const isImage = ICON_BY_EXT.image.includes(ext);
  const isVideo = ICON_BY_EXT.video.includes(ext);
  const isAudio = ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'].includes(ext);
  const isPdf = ext === 'pdf';
  const isText = !isImage && !isVideo && !isAudio && !isPdf;

  const body = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'between';
  head.innerHTML = `<h2 id="preview-title"></h2><button class="icon-btn" data-close aria-label="关闭">${icon('close')}</button>`;
  head.querySelector('#preview-title').textContent = entry.name;
  body.appendChild(head);

  const content = document.createElement('div');
  content.className = 'preview-body';
  if (isImage) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = entry.name;
    img.className = 'preview-media';
    content.appendChild(img);
  } else if (isVideo) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.className = 'preview-media';
    content.appendChild(video);
  } else if (isAudio) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    content.appendChild(audio);
  } else if (isPdf) {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.className = 'preview-frame';
    content.appendChild(frame);
  } else if (isText) {
    const pre = document.createElement('pre');
    pre.className = 'preview-text';
    pre.textContent = '正在加载…';
    content.appendChild(pre);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('无法预览');
        return res.text();
      })
      .then((text) => {
        pre.textContent = text;
      })
      .catch(() => {
        pre.textContent = '无法预览这个文件，请下载后查看。';
      });
  }
  body.appendChild(content);
  openDialog(body);
  bindClose();
}

function openDialog(content) {
  const dialog = $('#dialog');
  const body = $('#dialog-body');
  body.innerHTML = '';
  if (content instanceof Node) body.appendChild(content);
  else body.innerHTML = content;
  dialog.showModal();
}

function bindClose() {
  const dialog = $('#dialog');
  for (const button of dialog.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => dialog.close());
  }
}

/* ---------------- 行操作 ---------------- */

function openRowMenu(entry) {
  const actions = [
    { label: '预览', icon: 'file', run: () => openPreview(entry), disabled: entry.isDir },
    { label: '下载', icon: 'download', run: () => downloadEntry(entry), disabled: entry.isDir },
    { label: '复制路径', icon: 'copy', run: () => copyText(entry.path) },
    { label: '重命名', icon: 'rename', run: () => promptRename(entry) },
    { label: '移动到…', icon: 'move', run: () => promptMove([entry.path]) },
    { label: '删除', icon: 'trash', run: () => promptDelete([entry.path]), danger: true },
  ];
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'between';
  head.innerHTML = `<h2>${escapeHtml(entry.name)}</h2><button class="icon-btn" data-close>${icon('close')}</button>`;
  wrap.appendChild(head);
  const list = document.createElement('div');
  list.className = 'menu-list';
  for (const action of actions) {
    const button = document.createElement('button');
    button.className = 'menu-item' + (action.danger ? ' danger' : '');
    button.innerHTML = `${icon(action.icon)}<span></span>`;
    button.querySelector('span').textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.addEventListener('click', () => {
      $('#dialog').close();
      action.run();
    });
    list.appendChild(button);
  }
  wrap.appendChild(list);
  openDialog(wrap);
  bindClose();
}

function downloadEntry(entry) {
  if (entry.isDir) return;
  const a = document.createElement('a');
  a.href = `/api/download?path=${encodeURIComponent(entry.path)}`;
  a.download = entry.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('浏览器未允许复制，请手动选择', 'error');
  }
}

function promptRename(entry) {
  const wrap = document.createElement('form');
  wrap.className = 'form';
  wrap.innerHTML = `<h2>重命名</h2><input class="field" id="rename-input" value="${escapeHtml(entry.name)}"><div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>`;
  wrap.querySelector('#rename-input').value = entry.name;
  openDialog(wrap);
  bindClose();
  wrap.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = wrap.querySelector('#rename-input').value.trim();
    if (!name) return;
    try {
      await api('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: entry.path, name }),
      });
      $('#dialog').close();
      loadList(state.path);
      toast('已重命名');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function promptDelete(paths) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h2>删除 ${paths.length} 项？</h2><p class="muted" style="margin-top:8px">删除后不会进入回收站，也无法恢复。</p><div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn danger" id="confirm-delete">永久删除</button></div>`;
  openDialog(wrap);
  bindClose();
  wrap.querySelector('#confirm-delete').addEventListener('click', async () => {
    try {
      await api('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      $('#dialog').close();
      state.selection.clear();
      loadList(state.path);
      toast('已删除');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function promptMkdir() {
  const wrap = document.createElement('form');
  wrap.className = 'form';
  wrap.innerHTML = `<h2>新建文件夹</h2><input class="field" id="mkdir-input" placeholder="文件夹名称"><div class="dialog-actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">创建</button></div>`;
  openDialog(wrap);
  bindClose();
  setTimeout(() => wrap.querySelector('#mkdir-input').focus(), 50);
  wrap.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = wrap.querySelector('#mkdir-input').value.trim();
    if (!name) return;
    try {
      await api('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: state.path, name }),
      });
      $('#dialog').close();
      loadList(state.path);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function promptMove(paths) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h2>移动到</h2><div class="dir-list" id="dir-list"><p class="muted small">正在读取目录…</p></div><div class="dialog-actions"><button class="btn" type="button" data-close>取消</button></div>`;
  openDialog(wrap);
  bindClose();
  try {
    const data = await api('/api/tree-dirs');
    const list = wrap.querySelector('#dir-list');
    list.innerHTML = '';
    for (const dir of data.dirs) {
      const button = document.createElement('button');
      button.className = 'dir-item';
      button.style.paddingLeft = `${8 + dir.depth * 12}px`;
      button.innerHTML = `${icon('folder')}<span></span>`;
      button.querySelector('span').textContent = dir.path || '全部文件（根目录）';
      button.addEventListener('click', async () => {
        try {
          await api('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths, to: dir.path }),
          });
          $('#dialog').close();
          state.selection.clear();
          loadList(state.path);
          toast('已移动');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      list.appendChild(button);
    }
  } catch (error) {
    wrap.querySelector('#dir-list').textContent = error.message;
  }
}

/* ---------------- 剪贴板 ---------------- */

async function loadClipboard() {
  try {
    const data = await api('/api/clipboard');
    state.clipboard = data.items;
    updateClipCount();
    if ($('#clip-list')) renderClipboardModal();
  } catch {
    /* ignore */
  }
}

function openClipboard() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="between"><h2>剪贴板</h2><button class="icon-btn" data-close>${icon('close')}</button></div>
    <p class="muted small" style="margin-top:4px">发送到所有在线设备（包括手机）。</p>
    <textarea class="field clip" id="clip-input" placeholder="粘贴文字…" style="min-height:80px;margin-top:12px"></textarea>
    <button class="btn primary" id="clip-send" style="width:100%;margin-top:8px">发送</button>
    <div class="clip-list" id="clip-list"></div>`;
  openDialog(wrap);
  bindClose();
  renderClipboardModal();
  const send = async () => {
    const input = wrap.querySelector('#clip-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      const data = await api('/api/clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      state.clipboard = data.items;
      input.value = '';
      updateClipCount();
      renderClipboardModal();
      toast('已发送');
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  wrap.querySelector('#clip-send').addEventListener('click', send);
  wrap.querySelector('#clip-input').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') send();
  });
  state.clipModal = wrap;
}

function renderClipboardModal() {
  const list = $('#clip-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.clipboard.length) {
    list.innerHTML = '<p class="muted small" style="margin-top:12px">还没有内容。</p>';
    return;
  }
  for (const item of state.clipboard) {
    const row = document.createElement('div');
    row.className = 'clip-item';
    const text = document.createElement('div');
    text.className = 'txt';
    text.textContent = item.text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const left = document.createElement('span');
    left.textContent = `${item.device} · ${fmtTime(item.ts)}`;
    const ops = document.createElement('span');
    const copy = document.createElement('button');
    copy.textContent = '复制';
    copy.addEventListener('click', () => copyText(item.text));
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      try {
        const data = await api(`/api/clipboard?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        state.clipboard = data.items;
        updateClipCount();
        renderClipboardModal();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    ops.append(copy, del);
    meta.append(left, ops);
    row.append(text, meta);
    list.appendChild(row);
  }
}

/* ---------------- 手机访问 ---------------- */

function openPhone() {
  const info = state.info;
  if (!info) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="between"><h2>手机访问</h2><button class="icon-btn" data-close>${icon('close')}</button></div>
    <div class="qr-large">${info.qr.svg}</div>
    <p class="muted small" style="margin-top:10px;word-break:break-all" id="phone-url"></p>
    <div class="row" style="margin-top:10px;gap:6px">
      <button class="btn" id="phone-copy">复制地址</button>
      <button class="btn" id="phone-lan">局域网地址</button>
      <button class="btn" id="phone-ts">Tailscale 地址</button>
    </div>
    <p class="muted small" style="margin-top:10px">同一 Wi-Fi 用局域网；不在同一网络时，两台设备都连 Tailscale 或用 Cloudflare 隧道。手机用 Safari 打开即可，不需要装 App。</p>`;
  openDialog(wrap);
  bindClose();
  const url = info.server.shareUrl;
  wrap.querySelector('#phone-url').textContent = url;
  wrap.querySelector('#phone-copy').addEventListener('click', () => copyText(url));
  const switchTo = async (kind) => {
    const address = (info.server.addresses || []).find((item) => item.kind === kind);
    if (!address) return toast(kind === 'tailscale' ? '没有检测到 Tailscale 地址' : '没有检测到局域网地址', 'error');
    try {
      const next = await api(`/api/info?address=${encodeURIComponent(address.ip)}`);
      state.info = next;
      openPhone();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  wrap.querySelector('#phone-lan').addEventListener('click', () => switchTo('lan'));
  wrap.querySelector('#phone-ts').addEventListener('click', () => switchTo('tailscale'));
}

/* ---------------- 设置 ---------------- */

async function openSettings() {
  let settings;
  try {
    const data = await api('/api/settings');
    settings = data.settings;
  } catch (error) {
    return toast(error.message, 'error');
  }
  const tunnel = settings.tunnel || {};
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="between"><h2>设置</h2><button class="icon-btn" data-close>${icon('close')}</button></div>
    <div class="settings">
      <section>
        <h3>本机</h3>
        <label class="label">设备名称<input class="field" id="set-name"></label>
        <label class="label">共享目录
          <div class="row" style="margin-top:4px">
            <input class="field" id="set-root" style="flex:1" readonly>
            <button class="btn" id="set-pick-root" type="button">更改</button>
          </div>
        </label>
        <div class="row" style="margin-top:6px">
          <button class="btn" id="set-open-folder">打开共享目录</button>
          <button class="btn" id="set-theme">外观：${state.theme === 'light' ? '浅色' : '深色'}</button>
        </div>
      </section>
      <section>
        <h3>访问</h3>
        <label class="label">访问口令（留空不修改）<input class="field" id="set-code" type="password" placeholder="留空不修改"></label>
        <label class="check"><input type="checkbox" id="set-sync"> 自动同步共享目录</label>
      </section>
      <section>
        <h3>同步设备</h3>
        <div id="peer-list" class="peer-list"></div>
        <div class="row" style="margin-top:8px;gap:6px">
          <input class="field" id="peer-ip" style="flex:1" placeholder="IP / Tailscale 地址">
          <input class="field" id="peer-port" style="width:76px" placeholder="47890" value="47890">
          <button class="btn" id="peer-add" type="button">添加</button>
        </div>
        <button class="btn" id="peer-scan" type="button" style="width:100%;margin-top:6px">扫描局域网</button>
        <p class="muted small" style="margin-top:6px">同一 Wi-Fi 会自动发现；异地时填对方的 Tailscale 100.x 地址</p>
      </section>
      <section>
        <h3>远程访问（Cloudflare Tunnel）</h3>
        <p class="muted small">如需使用自定义域名，请先在 Cloudflare Zero Trust 配置隧道和域名解析，再填写隧道令牌及域名。</p>
        <label class="label">Tunnel token<input class="field" id="set-token" placeholder="eyJhIjoi..." autocomplete="off"></label>
        <label class="label">公网域名<input class="field" id="set-hostname" placeholder="files.example.com"></label>
        <label class="check"><input type="checkbox" id="set-autostart"> 启动应用时自动连接</label>
        <div class="tunnel-status small" id="tunnel-status"></div>
        <div class="row" style="margin-top:6px">
          <button class="btn" id="set-tunnel-save">保存</button>
          <button class="btn primary" id="set-tunnel-start">启动隧道</button>
          <button class="btn" id="set-tunnel-stop">停止</button>
        </div>
      </section>
    </div>
    <div class="dialog-actions"><button class="btn" type="button" data-close>关闭</button><button class="btn primary" id="set-save">保存设置</button></div>`;
  openDialog(wrap);
  bindClose();
  wrap.querySelector('#set-name').value = settings.deviceName || '';
  wrap.querySelector('#set-root').value = settings.root || '';
  wrap.querySelector('#set-code').value = '';
  wrap.querySelector('#set-code').placeholder = settings.accessCode ? '已设置（留空保持不变）' : '未设置（输入新口令）';
  wrap.querySelector('#set-sync').checked = Boolean(settings.autoSync);
  wrap.querySelector('#set-token').value = '';
  wrap.querySelector('#set-token').placeholder = tunnel.hasToken ? `已保存 ${tunnel.tokenMasked || ''}` : 'eyJhIjoi...';
  wrap.querySelector('#set-hostname').value = tunnel.config ? tunnel.config.hostname || '' : '';
  wrap.querySelector('#set-autostart').checked = Boolean(tunnel.config && tunnel.config.autostart);
  const renderTunnel = (status) => {
    const box = wrap.querySelector('#tunnel-status');
    if (!status) return;
    const label = status.running ? '运行中' : status.state === 'error' ? '错误' : '未运行';
    const modeText = status.config && status.config.mode === 'local' ? '本机隧道（local）' : status.config && status.config.mode === 'quick' ? '临时隧道（quick）' : 'token 隧道';
    box.textContent = `状态：${label} · ${modeText}${status.error ? ` · ${status.error}` : ''}${status.binaryFound ? '' : ' · 未安装 cloudflared'}`;
    box.style.color = status.running ? 'var(--fb-success)' : status.state === 'error' ? 'var(--fb-error)' : '';
  };
  renderTunnel(tunnel);

  let pendingRoot = '';
  wrap.querySelector('#peer-scan').addEventListener('click', async () => {
    const scanBtn = wrap.querySelector('#peer-scan');
    scanBtn.disabled = true;
    scanBtn.textContent = '正在扫描…';
    try {
      const result = await api('/api/peers/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await renderPeerList();
      const count = (result.found || []).length;
      toast(count ? `发现 ${count} 台设备` : '没有发现其他设备（可手动添加 IP）');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = '扫描局域网';
    }
  });

  wrap.querySelector('#set-pick-root').addEventListener('click', async () => {
    let chosen = '';
    if (window.filebridge && typeof window.filebridge.pickDirectory === 'function') {
      chosen = await window.filebridge.pickDirectory();
    } else {
      chosen = window.prompt('输入共享文件夹的完整路径（Windows 例如 D:\\FileBridge）', wrap.querySelector('#set-root').value) || '';
    }
    if (chosen) {
      pendingRoot = chosen;
      wrap.querySelector('#set-root').value = chosen;
    }
  });
  wrap.querySelector('#set-open-folder').addEventListener('click', async () => {
    try {
      await api('/api/open-folder', { method: 'POST' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.querySelector('#set-theme').addEventListener('click', () => {
    cycleTheme();
    wrap.querySelector('#set-theme').textContent = `外观：${state.theme === 'light' ? '浅色' : '深色'}`;
  });
  wrap.querySelector('#set-tunnel-save').addEventListener('click', async () => {
    try {
      const tokenValue = wrap.querySelector('#set-token').value.trim();
      const body = {
        action: 'config',
        hostname: wrap.querySelector('#set-hostname').value.trim() || undefined,
        autostart: wrap.querySelector('#set-autostart').checked,
      };
      if (tokenValue) {
        body.mode = 'token';
        body.token = tokenValue;
      }
      const status = await api('/api/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.info = state.info || {};
      state.info.tunnel = status.tunnel;
      renderTunnel(status.tunnel);
      toast('隧道配置已保存');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.querySelector('#set-tunnel-start').addEventListener('click', async () => {
    try {
      const status = await api('/api/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      renderTunnel(status.tunnel);
      toast(status.tunnel.running ? '隧道已启动' : '隧道启动中…');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.querySelector('#set-tunnel-stop').addEventListener('click', async () => {
    try {
      const status = await api('/api/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
      renderTunnel(status.tunnel);
      toast('隧道已停止');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.querySelector('#set-save').addEventListener('click', async () => {
    const patch = {
      deviceName: wrap.querySelector('#set-name').value.trim(),
      autoSync: wrap.querySelector('#set-sync').checked,
    };
    if (pendingRoot) patch.root = pendingRoot;
    const code = wrap.querySelector('#set-code').value.trim();
    if (code) patch.accessCode = code;
    try {
      await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      toast('设置已保存');
      const info = await api('/api/info');
      state.info = info;
      renderChrome();
      if (patch.root) {
        state.path = '';
        state.selection.clear();
        $('#search').value = '';
        loadList('');
        toast('共享目录已切换');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

/* ---------------- WebSocket ---------------- */

function connectWS() {
  if (state.ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    setTimeout(connectWS, state.wsDelay);
    return;
  }
  state.ws = socket;
  socket.addEventListener('open', () => {
    state.wsDelay = 800;
    renderChip();
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleWs(message);
  });
  socket.addEventListener('close', () => {
    state.ws = null;
    setTimeout(() => {
      state.wsDelay = Math.min(state.wsDelay * 1.6, 15000);
      connectWS();
    }, state.wsDelay);
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadList(state.path);
  }, 250);
}

function handleWs(message) {
  if (message.type === 'fs') {
    scheduleRefresh();
  } else if (message.type === 'clipboard') {
    state.clipboard = message.items || state.clipboard;
    updateClipCount();
    if ($('#clip-list')) renderClipboardModal();
  } else if (message.type === 'peers') {
    state.peers = message.peers || [];
    renderPeers();
    renderFiles();
  } else if (message.type === 'transfer') {
    const item = message.item;
    if (item) {
      const index = state.transfers.findIndex((entry) => entry.id === item.id);
      if (index >= 0) state.transfers[index] = item;
      else state.transfers.unshift(item);
      renderTransferBar();
      renderFiles();
      if (item.state === 'confirmed') toast(`已同步到 ${(item.confirmedBy[0] || {}).name || '对端'}`);
    }
  } else if (message.type === 'tunnel') {
    if (state.info) state.info.tunnel = message.tunnel;
    toast(message.tunnel.running ? '远程隧道已连接' : '远程隧道已停止');
  } else if (message.type === 'clients') {
    /* ignore */
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#btn-upload').addEventListener('click', () => $('#file-input').click());
  $('#btn-upload-empty').addEventListener('click', () => $('#file-input').click());
  $('#fab-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => {
    uploadFiles(event.target.files);
    event.target.value = '';
  });
  $('#btn-mkdir').addEventListener('click', promptMkdir);
  $('#btn-refresh').addEventListener('click', () => loadList(state.path));
  $('#btn-back').addEventListener('click', () => {
    const parts = state.path.split('/');
    parts.pop();
    goTo(parts.join('/'));
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-phone').addEventListener('click', openPhone);
  $('#btn-float').addEventListener('click', async () => {
    try {
      await api('/api/float-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle' }) });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#btn-more-top').addEventListener('click', openSettings);
  $('#btn-cancel-sel').addEventListener('click', () => {
    state.selection.clear();
    renderFiles();
    renderToolbar();
    renderDetail();
  });
  $('#btn-download').addEventListener('click', () => selectedEntries().filter((entry) => !entry.isDir).forEach(downloadEntry));
  $('#btn-rename').addEventListener('click', () => {
    const entry = selectedEntries()[0];
    if (entry) promptRename(entry);
  });
  $('#btn-delete').addEventListener('click', () => promptDelete([...state.selection]));
  $('#btn-move').addEventListener('click', () => promptMove([...state.selection]));
  $('#btn-detail-close').addEventListener('click', () => {
    state.selection.clear();
    renderFiles();
    renderToolbar();
    renderDetail();
  });
  $('#d-download').addEventListener('click', () => {
    const entry = selectedEntries()[0];
    if (entry) downloadEntry(entry);
  });
  $('#d-preview-btn').addEventListener('click', () => {
    const entry = selectedEntries()[0];
    if (entry) openPreview(entry);
  });
  $('#d-reveal').addEventListener('click', async () => {
    try {
      await api('/api/open-folder', { method: 'POST' });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#d-delete').addEventListener('click', () => {
    const entry = selectedEntries()[0];
    if (entry) promptDelete([entry.path]);
  });
  $('#check-all').addEventListener('change', (event) => {
    state.selection.clear();
    if (event.target.checked) {
      for (const entry of state.entries) state.selection.add(entry.path);
    }
    renderFiles();
    renderToolbar();
    renderDetail();
  });
  $('#search').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderFiles();
  });
  $('#search').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.target.value = '';
      state.filter = '';
      renderFiles();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('#drop').hidden = true;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.selection.size && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        promptDelete([...state.selection]);
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        for (const entry of state.entries) state.selection.add(entry.path);
        renderFiles();
        renderToolbar();
        renderDetail();
      }
    }
  });

  for (const nav of document.querySelectorAll('[data-nav]')) {
    nav.addEventListener('click', () => {
      const target = nav.dataset.nav;
      if (target === 'clipboard') return openClipboard();
      if (target === 'devices') return showDevices();
      for (const other of document.querySelectorAll('[data-nav]')) other.classList.toggle('on', other === nav);
      if (target === 'inbox') {
        const inbox = (state.info && state.info.inbox) || '临时收件箱';
        goTo(inbox);
      } else {
        goTo('');
      }
    });
  }

  // 拖拽上传
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
    dragDepth += 1;
    $('#drop').hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop').hidden = true;
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('#drop').hidden = true;
    if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files, state.path);
  });

  $('#transferbar').addEventListener('click', () => {
    loadTransfers();
    showTransferDetails();
  });
  $('#transferbar').style.cursor = 'pointer';
}

function showTransferDetails() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="between"><h2>传输</h2><button class="icon-btn" data-close>${icon('close')}</button></div><div class="transfer-list" id="t-list"></div>`;
  openDialog(wrap);
  bindClose();
  const list = wrap.querySelector('#t-list');
  const items = [...state.uploads.values()].map((item) => ({
    name: item.name,
    state: item.status === 'done' ? '已完成' : item.status === 'error' ? (item.error || '失败') : `${Math.round(item.progress * 100)}%`,
  })).concat(state.transfers.map((item) => ({
    name: item.name,
    state: item.state === 'confirmed' ? '已同步' : (state.peers.some((peer) => peer.online) ? '同步中' : '等待设备'),
  })));
  if (!items.length) list.innerHTML = '<p class="muted small">暂无传输</p>';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'transfer-row';
    row.innerHTML = `<span class="nm"></span><span class="st"></span>`;
    row.querySelector('.nm').textContent = item.name;
    row.querySelector('.st').textContent = item.state;
    list.appendChild(row);
  }
}

/* ---------------- 文档预览（Office / 压缩包） ---------------- */

function openFallbackPreview(entry, reason) {
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'between';
  head.innerHTML = `<h2>${escapeHtml(entry.name)}</h2><button class="icon-btn" data-close aria-label="关闭">${icon('close')}</button>`;
  wrap.appendChild(head);
  const body = document.createElement('div');
  body.className = 'fallback-preview';
  body.innerHTML = `
    <div class="fallback-icon">${icon(extKind(entry) === 'zip' ? 'zip' : 'file', 'icon lg')}</div>
    <p class="muted small">${escapeHtml((entry.ext || '文件').toUpperCase())} · ${fmtSize(entry.size)}</p>
    <p class="muted small" style="margin-top:6px">${escapeHtml(reason || '这个格式暂不支持在线预览')}</p>
    <div class="row" style="justify-content:center;gap:8px;margin-top:14px">
      <button class="btn primary" id="fb-download">下载</button>
      <button class="btn" id="fb-open">用系统应用打开</button>
    </div>`;
  wrap.appendChild(body);
  openDialog(wrap);
  bindClose();
  wrap.querySelector('#fb-download').addEventListener('click', () => downloadEntry(entry));
  const openBtn = wrap.querySelector('#fb-open');
  if (!window.filebridge || !window.filebridge.isElectron) {
    openBtn.style.display = 'none';
  } else {
    openBtn.addEventListener('click', () => openWithSystem(entry));
  }
}

async function openWithSystem(entry) {
  try {
    await api('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path }),
    });
    toast('已用系统应用打开');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function docFooter(entry) {
  const foot = document.createElement('div');
  foot.className = 'doc-foot';
  foot.innerHTML = `<button class="btn" id="doc-download">下载</button><button class="btn" id="doc-open">用系统应用打开</button>`;
  foot.querySelector('#doc-download').addEventListener('click', () => downloadEntry(entry));
  const open = foot.querySelector('#doc-open');
  if (!window.filebridge || !window.filebridge.isElectron) open.style.display = 'none';
  else open.addEventListener('click', () => openWithSystem(entry));
  return foot;
}

async function openDocPreview(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-preview';
  const head = document.createElement('div');
  head.className = 'between';
  head.innerHTML = `<h2>${escapeHtml(entry.name)}</h2><button class="icon-btn" data-close aria-label="关闭">${icon('close')}</button>`;
  wrap.appendChild(head);
  const content = document.createElement('div');
  content.className = 'doc-content';
  content.innerHTML = '<p class="muted small" style="padding:24px 0">正在解析文件…</p>';
  wrap.appendChild(content);
  openDialog(wrap);
  bindClose();
  try {
    const data = await api(`/api/doc-preview?path=${encodeURIComponent(entry.path)}`);
    renderDocContent(content, data.preview, entry);
    content.appendChild(docFooter(entry));
  } catch (error) {
    content.innerHTML = '';
    content.appendChild(buildFallbackBody(entry, error.message));
  }
}

function buildFallbackBody(entry, reason) {
  const box = document.createElement('div');
  box.className = 'fallback-preview';
  box.innerHTML = `<div class="fallback-icon">${icon('file', 'icon lg')}</div>
    <p class="muted small">${escapeHtml((entry.ext || '文件').toUpperCase())} · ${fmtSize(entry.size)}</p>
    <p class="muted small" style="margin-top:6px">${escapeHtml(reason || '这个格式暂不支持在线预览')}</p>`;
  const row = document.createElement('div');
  row.className = 'row';
  row.style.cssText = 'justify-content:center;gap:8px;margin-top:14px';
  const download = document.createElement('button');
  download.className = 'btn primary';
  download.textContent = '下载';
  download.addEventListener('click', () => downloadEntry(entry));
  row.appendChild(download);
  if (window.filebridge && window.filebridge.isElectron) {
    const open = document.createElement('button');
    open.className = 'btn';
    open.textContent = '用系统应用打开';
    open.addEventListener('click', () => openWithSystem(entry));
    row.appendChild(open);
  }
  box.appendChild(row);
  return box;
}

function renderDocContent(container, preview, entry) {
  container.innerHTML = '';
  if (!preview) {
    container.appendChild(buildFallbackBody(entry, '没有可显示的内容'));
    return;
  }
  if (preview.kind === 'docx') {
    const frame = document.createElement('iframe');
    frame.className = 'doc-frame';
    frame.setAttribute('sandbox', '');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <style>
        body{font:14px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2d3d;background:#fff;padding:28px 32px;max-width:840px;margin:0 auto}
        h1,h2,h3,h4{line-height:1.35;color:#16232f}
        p{margin:0 0 12px}
        table{border-collapse:collapse;width:100%}
        td,th{border:1px solid #d9e2ec;padding:6px 10px;font-size:13px}
        ul,ol{padding-left:24px}
        img{max-width:100%}
        a{color:#2565af}
      </style></head><body>${preview.html || ''}</body></html>`;
    container.appendChild(frame);
    return;
  }
  if (preview.kind === 'xlsx') {
    const tabs = document.createElement('div');
    tabs.className = 'sheet-tabs';
    const tableBox = document.createElement('div');
    tableBox.className = 'sheet-box';
    const sheets = preview.sheets || [];
    const renderSheet = (sheet) => {
      tableBox.innerHTML = '';
      if (!sheet.rows.length) {
        tableBox.innerHTML = '<p class="muted small" style="padding:20px">空工作表</p>';
        return;
      }
      const table = document.createElement('table');
      table.className = 'sheet-table';
      sheet.rows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        row.forEach((cell) => {
          const td = document.createElement(rowIndex === 0 ? 'th' : 'td');
          td.textContent = cell;
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      tableBox.appendChild(table);
    };
    sheets.forEach((sheet, index) => {
      const button = document.createElement('button');
      button.className = 'sheet-tab' + (index === 0 ? ' on' : '');
      button.textContent = sheet.name;
      button.addEventListener('click', () => {
        for (const tab of tabs.children) tab.classList.toggle('on', tab === button);
        renderSheet(sheet);
      });
      tabs.appendChild(button);
    });
    container.append(tabs, tableBox);
    if (sheets[0]) renderSheet(sheets[0]);
    return;
  }
  if (preview.kind === 'pptx') {
    const list = document.createElement('div');
    list.className = 'slide-list';
    for (const slide of preview.slides || []) {
      const card = document.createElement('div');
      card.className = 'slide-card';
      const num = document.createElement('div');
      num.className = 'slide-num';
      num.textContent = `第 ${slide.index} 页`;
      card.appendChild(num);
      if (!slide.texts.length) {
        const empty = document.createElement('p');
        empty.className = 'muted small';
        empty.textContent = '（这一页没有文字内容）';
        card.appendChild(empty);
      }
      for (const text of slide.texts) {
        const p = document.createElement('p');
        p.textContent = text;
        card.appendChild(p);
      }
      list.appendChild(card);
    }
    container.appendChild(list);
    return;
  }
  if (preview.kind === 'zip') {
    const info = document.createElement('p');
    info.className = 'muted small';
    info.style.margin = '0 0 8px';
    info.textContent = `共 ${preview.total} 个条目${preview.total > preview.entries.length ? `，显示前 ${preview.entries.length} 个` : ''}`;
    container.appendChild(info);
    const list = document.createElement('div');
    list.className = 'zip-list';
    for (const item of preview.entries) {
      const row = document.createElement('div');
      row.className = 'zip-item';
      row.innerHTML = `${icon(item.dir ? 'folder' : 'file', 'icon')}<span class="nm"></span><span class="sz"></span>`;
      row.querySelector('.nm').textContent = item.name;
      row.querySelector('.sz').textContent = item.dir ? '' : fmtSize(item.size);
      list.appendChild(row);
    }
    container.appendChild(list);
    return;
  }
  container.appendChild(buildFallbackBody(entry, '暂不支持这种预览方式'));
}

function showDevices() {
  const peers = state.peers || [];
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="between"><h2>设备</h2><button class="icon-btn" data-close>${icon('close')}</button></div><p class="muted small" style="margin-top:8px">同一 Wi-Fi 会自动发现；异地时都连 Tailscale 或用 Cloudflare 隧道。</p><div id="device-list"></div>`;
  openDialog(wrap);
  bindClose();
  const list = wrap.querySelector('#device-list');
  if (!peers.length) list.innerHTML = '<p class="muted small" style="margin-top:12px">还没有发现其他设备。请确认对方已打开 FileBridge。</p>';
  for (const peer of peers) {
    const row = document.createElement('div');
    row.className = 'device-item';
    row.innerHTML = `<span class="dot ${peer.online ? '' : 'off'}"></span><div class="info"><div class="nm"></div><div class="path small muted"></div></div>`;
    row.querySelector('.nm').textContent = peer.name;
    row.querySelector('.path').textContent = `${peer.link === 'tailscale' ? 'Tailscale' : '局域网'} · ${peer.ip}:${peer.httpPort}${peer.online ? '' : ' · 离线'}`;
    list.appendChild(row);
  }
}

document.addEventListener('DOMContentLoaded', bindEvents);
if (window.filebridge && typeof window.filebridge.onOpenSettings === 'function') {
  window.filebridge.onOpenSettings(() => openSettings());
}
boot();
