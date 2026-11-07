'use strict';

const fs = require('fs');
const path = require('path');

const HIDDEN_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const TEMP_SUFFIX = /\.(fb-upload|fb-sync)[^/]*\.part$/i;

const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const MIME = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8',
  mjs: 'text/plain; charset=utf-8',
  cjs: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  css: 'text/plain; charset=utf-8',
  scss: 'text/plain; charset=utf-8',
  less: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  htm: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  bash: 'text/plain; charset=utf-8',
  zsh: 'text/plain; charset=utf-8',
  bat: 'text/plain; charset=utf-8',
  cmd: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  hpp: 'text/plain; charset=utf-8',
  cs: 'text/plain; charset=utf-8',
  php: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  swift: 'text/plain; charset=utf-8',
  kt: 'text/plain; charset=utf-8',
  tex: 'text/plain; charset=utf-8',
  patch: 'text/plain; charset=utf-8',
  diff: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  apk: 'application/vnd.android.package-archive',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/x-iwork-keynote-sffkey',
  pages: 'application/x-iwork-pages-sffpages',
  numbers: 'application/x-iwork-numbers-sffnumbers',
};

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'html', 'htm', 'xml', 'csv', 'tsv', 'log', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sh',
  'bash', 'zsh', 'bat', 'cmd', 'ps1', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sql', 'swift', 'kt', 'tex', 'patch', 'diff', 'svg', 'gitignore', 'editorconfig',
  'npmrc', 'prettierrc', 'eslintrc', 'lock', 'map', 'plist', 'srt', 'vtt', 'ass',
]);

const PREVIEW_TEXT_MAX_BYTES = 8 * 1024 * 1024;

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanRel(rel) {
  let value = String(rel == null ? '' : rel)
    .replace(/\\/g, '/')
    .replace(/\0/g, '');
  value = value.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
  if (value === '.' || value === './') return '';
  return value;
}

function resolveInside(root, rel) {
  const clean = cleanRel(rel);
  const abs = path.resolve(root, ...clean.split('/').filter(Boolean));
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw badRequest('路径越界', 403);
  }
  return abs;
}

function relOf(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function parentOf(rel) {
  const clean = cleanRel(rel);
  if (!clean) return '';
  const parts = clean.split('/');
  parts.pop();
  return parts.join('/');
}

function extOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext || '';
}

function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

function isPreviewableText(name) {
  if (extOf(name) === '') return false;
  if (TEXT_EXT.has(extOf(name))) return true;
  // Dockerfile / Makefile 之类无扩展名文件按文本处理
  return /^(dockerfile|makefile|readme|license|changelog)$/i.test(name);
}

function sanitizeName(rawName) {
  let name = String(rawName == null ? '' : rawName)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*]/g, '-')
    .trim()
    .replace(/[. ]+$/, '');
  if (name === '.' || name === '..') return '';
  name = name.slice(0, 180);
  return name;
}

function uniquePath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 500; i += 1) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function isHiddenEntry(name) {
  return HIDDEN_NAMES.has(name) || TEMP_SUFFIX.test(name);
}

function entryFor(root, abs, name) {
  const stat = fs.statSync(abs);
  const rel = relOf(root, abs);
  return {
    name,
    path: rel,
    isDir: stat.isDirectory(),
    size: stat.isDirectory() ? 0 : stat.size,
    mtime: Math.round(stat.mtimeMs),
    ext: stat.isDirectory() ? '' : extOf(name),
    previewable: !stat.isDirectory() && isPreviewableText(name),
  };
}

function listDir(root, rel) {
  const abs = resolveInside(root, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw badRequest('文件夹不存在', 404);
  }
  if (!stat.isDirectory()) throw badRequest('不是文件夹', 400);

  const entries = [];
  for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (isHiddenEntry(dirent.name)) continue;
    try {
      entries.push(entryFor(root, path.join(abs, dirent.name), dirent.name));
    } catch {
      /* 读取过程中被删除的文件直接忽略 */
    }
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return COLLATOR.compare(a.name, b.name);
  });

  return {
    path: cleanRel(rel),
    parent: parentOf(rel),
    name: path.basename(abs),
    entries,
  };
}

function walkFiles(root, { limit = 20000 } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    const abs = resolveInside(root, rel);
    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isHiddenEntry(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const childAbs = path.join(abs, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(childRel);
      } else if (dirent.isFile()) {
        try {
          const stat = fs.statSync(childAbs);
          out.push({ path: childRel, size: stat.size, mtime: Math.round(stat.mtimeMs) });
        } catch {
          /* ignore */
        }
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

function walkDirs(root, { limit = 3000 } = {}) {
  const out = [{ path: '', name: '', depth: 0 }];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    const abs = resolveInside(root, rel);
    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const children = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (isHiddenEntry(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      children.push(childRel);
    }
    children.sort((a, b) => COLLATOR.compare(a, b));
    for (const childRel of children) {
      const depth = childRel.split('/').length;
      out.push({ path: childRel, name: childRel.split('/').pop(), depth });
      if (out.length >= limit) break;
      stack.push(childRel);
    }
  }
  return out;
}

function previewDescriptor(root, rel) {
  const abs = resolveInside(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw badRequest('文件夹无法预览', 400);
  const ext = extOf(abs);
  const mime = mimeOf(abs);
  const text = isPreviewableText(path.basename(abs));

  if (text) {
    if (stat.size > PREVIEW_TEXT_MAX_BYTES) {
      throw badRequest('文件过大，无法在线预览，请直接下载', 415);
    }
    return { kind: 'text', abs, stat, mime: 'text/plain; charset=utf-8' };
  }
  if (/^image\//.test(mime) || mime === 'application/pdf' || /^(audio|video)\//.test(mime)) {
    return { kind: 'media', abs, stat, mime };
  }
  if (ext === '') {
    // 无扩展名文件尝试按文本预览（限制大小）
    if (stat.size <= PREVIEW_TEXT_MAX_BYTES) {
      return { kind: 'text', abs, stat, mime: 'text/plain; charset=utf-8' };
    }
  }
  throw badRequest('该文件类型不支持在线预览，请下载后查看', 415);
}

function readTextPreview(abs) {
  return fs.readFileSync(abs, 'utf8');
}

module.exports = {
  HIDDEN_NAMES,
  TEXT_EXT,
  badRequest,
  cleanRel,
  resolveInside,
  relOf,
  parentOf,
  extOf,
  mimeOf,
  sanitizeName,
  uniquePath,
  listDir,
  walkFiles,
  walkDirs,
  previewDescriptor,
  readTextPreview,
  isPreviewableText,
  entryFor,
};
