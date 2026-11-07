'use strict';

const $ = (sel) => document.querySelector(sel);
const root = $('#root');
const panel = $('#panel');
let delivery = { path: '临时收件箱' };
let info = null;
let pending = [];
let uploading = false;
let sizeTimer = null;

const bridge = window.filebridge || null;

function icon(name) {
  return `<svg class="icon"><use href="#i-${name}"/></svg>`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function fmtSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function applyTheme() {
  const theme = localStorage.getItem('fb-theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
}

async function refreshStatus() {
  try {
    const data = await api('/api/info');
    info = data;
    const peers = (data.sync && data.sync.peers) || [];
    const online = peers.filter((peer) => peer.online);
    const peerBox = $('#peer');
    if (online.length) {
      const peer = online[0];
      peerBox.innerHTML = `<span class="dot"></span>${escapeText(peer.name)} · ${peer.link === 'tailscale' ? 'Tailscale' : '局域网'}`;
      $('#status-dot').style.background = 'var(--fb-success)';
    } else {
      peerBox.innerHTML = '<span class="dot warn"></span>等待设备';
      $('#status-dot').style.background = 'var(--fb-warning)';
    }
  } catch {
    /* ignore */
  }
}

function escapeText(text) {
  const div = document.createElement('div');
  div.textContent = String(text == null ? '' : text);
  return div.innerHTML;
}

async function refreshDelivery() {
  try {
    const data = await api('/api/delivery');
    delivery = data.delivery || delivery;
    $('#target').textContent = delivery.path || '根目录';
    $('#confirm-target').textContent = delivery.path || '根目录';
  } catch {
    /* ignore */
  }
}

function expanded() {
  return root.classList.contains('expanded');
}

function syncSize() {
  if (!expanded()) return;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    const height = Math.ceil(panel.getBoundingClientRect().height) + 8;
    if (bridge && bridge.setExpanded) await bridge.setExpanded(true, height);
  }, 40);
}

async function expandPanel() {
  root.classList.add('expanded');
  root.classList.remove('collapsed');
  panel.hidden = false;
  // 先把窗口定到目标宽度，再测高度，避免在 44px 宽时测量导致窗口变形
  if (bridge && bridge.setExpanded) await bridge.setExpanded(true, 320);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const height = Math.max(280, Math.ceil(panel.getBoundingClientRect().height) + 8);
  if (bridge && bridge.setExpanded) await bridge.setExpanded(true, height);
  $('#dropzone').classList.remove('hot');
}

async function collapsePanel() {
  root.classList.add('collapsed');
  root.classList.remove('expanded');
  panel.hidden = true;
  if (bridge && bridge.setExpanded) await bridge.setExpanded(false, 44);
}


/* 文件投递 */
function onFiles(files) {
  pending = Array.from(files || []);
  if (!pending.length) return;
  openConfirm();
}

function openConfirm() {
  const list = $('#confirm-list');
  list.innerHTML = '';
  let total = 0;
  for (const file of pending.slice(0, 6)) {
    total += file.size || 0;
    const row = document.createElement('div');
    row.className = 'ov-item';
    row.innerHTML = `${icon('folder')}<span class="n"></span><span class="s"></span>`;
    row.querySelector('.n').textContent = file.name;
    row.querySelector('.s').textContent = fmtSize(file.size || 0);
    list.appendChild(row);
  }
  if (pending.length > 6) {
    const more = document.createElement('div');
    more.className = 'ov-item';
    more.innerHTML = `<span class="n muted">等 ${pending.length} 个文件</span>`;
    list.appendChild(more);
  }
  $('#confirm-title').textContent = `待投递 ${pending.length} 个文件 · ${fmtSize(total)}`;
  $('#confirm-target').textContent = delivery.path || '根目录';
  $('#confirm').hidden = false;
  syncSize();
}

function closeConfirm() {
  $('#confirm').hidden = true;
  pending = [];
  syncSize();
}

async function startUpload() {
  if (uploading || !pending.length) return;
  uploading = true;
  $('#confirm').hidden = true;
  $('#status').hidden = false;
  const totalFiles = pending.length;
  let done = 0;
  for (const file of pending) {
    try {
      await uploadOne(file, done, totalFiles);
      done += 1;
    } catch (error) {
      $('#status-text').textContent = `失败：${error.message}`;
      $('#status-bar').style.width = '0%';
      uploading = false;
      pending = [];
      return;
    }
  }
  $('#status-text').textContent = `已投递 ${totalFiles} 个文件，正在同步`;
  $('#status-bar').style.width = '100%';
  pending = [];
  uploading = false;
  setTimeout(() => {
    if (!uploading) {
      $('#status').hidden = true;
      refreshStatus();
    }
  }, 6000);
  refreshStatus();
}

function uploadOne(file, done, total) {
  return new Promise((resolve, reject) => {
    const url = `/api/upload?path=${encodeURIComponent(delivery.path || '')}&name=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      const fileRatio = event.lengthComputable ? event.loaded / event.total : 0;
      const overall = (done + fileRatio) / total;
      $('#status-text').textContent = `正在投递 ${done + 1}/${total} · ${file.name}`;
      $('#status-bar').style.width = `${Math.round(overall * 100)}%`;
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve();
      else {
        let message = `HTTP ${xhr.status}`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* ignore */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

/* 目标目录选择 */
async function openPicker() {
  try {
    const data = await api('/api/tree-dirs');
    const list = $('#picker-list');
    list.innerHTML = '';
    for (const dir of data.dirs) {
      const button = document.createElement('button');
      button.className = 'pk-item';
      button.style.paddingLeft = `${8 + dir.depth * 10}px`;
      button.innerHTML = `${icon('folder')}<span class="nm"></span>`;
      button.querySelector('.nm').textContent = dir.path || '根目录';
      button.addEventListener('click', async () => {
        try {
          await api('/api/delivery', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir.path, quick: delivery.quick === true }),
          });
          delivery.path = dir.path;
          $('#target').textContent = dir.path || '根目录';
          $('#confirm-target').textContent = dir.path || '根目录';
          $('#picker').hidden = true;
          syncSize();
        } catch (error) {
          $('#status').hidden = false;
          $('#status-text').textContent = error.message;
        }
      });
      list.appendChild(button);
    }
    $('#picker').hidden = false;
    syncSize();
  } catch (error) {
    $('#status').hidden = false;
    $('#status-text').textContent = error.message;
    syncSize();
  }
}

/* 拖动：pointerdown 通知主进程开始按光标移动，pointerup 结束；点击（无移动）仍可展开 */
let lastDragMoved = false;

function setupDrag(element, onClick, interactiveSelector) {
  if (!element) return;
  let state = null;
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (interactiveSelector && event.target.closest(interactiveSelector)) return;
    event.preventDefault();
    state = { x: event.screenX, y: event.screenY, moved: false };
    try { element.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    if (bridge && bridge.dragStart) bridge.dragStart();
  });
  element.addEventListener('pointerup', async () => {
    if (!state) return;
    state = null;
    let moved = true;
    if (bridge && bridge.dragEnd) {
      try {
        const result = await bridge.dragEnd();
        moved = Boolean(result && result.moved);
      } catch {
        moved = true;
      }
    }
    lastDragMoved = moved;
    if (!moved && typeof onClick === 'function') onClick();
    setTimeout(() => { lastDragMoved = false; }, 50);
  });
  // 拖动结束后浏览器可能补发 click，这里直接吞掉，避免误触发展开
  element.addEventListener('click', (event) => {
    if (lastDragMoved) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);
  element.addEventListener('pointercancel', () => {
    if (!state) return;
    state = null;
    if (bridge && bridge.dragEnd) bridge.dragEnd();
  });
}

setupDrag($('#collapsed'), expandPanel);
setupDrag($('#panel'), null, 'button, input, textarea, select, a, .dropzone');

/* 事件 */

$('#collapse').addEventListener('click', collapsePanel);
$('#pick').addEventListener('click', openPicker);
$('#picker-close').addEventListener('click', () => {
  $('#picker').hidden = true;
  syncSize();
});
$('#confirm-cancel').addEventListener('click', closeConfirm);
$('#confirm-close').addEventListener('click', closeConfirm);
$('#confirm-ok').addEventListener('click', startUpload);
$('#settings').addEventListener('click', () => (bridge && bridge.openSettings ? bridge.openSettings() : null));
$('#open-main').addEventListener('click', () => (bridge && bridge.openMain ? bridge.openMain() : null));

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  $('#dropzone').classList.add('hot');
});
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget) return;
  $('#dropzone').classList.remove('hot');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  $('#dropzone').classList.remove('hot');
  if (!expanded()) expandPanel();
  if (event.dataTransfer.files.length) onFiles(event.dataTransfer.files);
});

const previewMode = new URLSearchParams(location.search).get('preview');
if ((!bridge || previewMode === '1') && expanded() === false) {
  expandPanel();
}

if (bridge && bridge.getState) {
  bridge.getState().then((state) => {
    if (state && state.expanded) expandPanel();
  }).catch(() => {});
}

applyTheme();
refreshDelivery();
refreshStatus();
setInterval(refreshStatus, 20000);
