'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const mammoth = require('mammoth');

const DOC_EXT = new Set(['docx', 'xlsx', 'pptx', 'zip']);
const MAX_DOCX = 40 * 1024 * 1024;
const MAX_PPTX = 60 * 1024 * 1024;
const MAX_ZIP = 60 * 1024 * 1024;
const MAX_SHEETS = 12;
const MAX_ROWS = 200;
const MAX_COLS = 40;
const MAX_SLIDES = 80;
const MAX_ARCHIVE_ENTRIES = 500;

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function canPreview(name) {
  return DOC_EXT.has(extOf(name));
}

function xmlUnescape(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function docxPreview(abs) {
  const stat = fs.statSync(abs);
  if (stat.size > MAX_DOCX) throw Object.assign(new Error('Word 文件过大（>40MB），请下载查看'), { status: 415 });
  const result = await mammoth.convertToHtml({ path: abs });
  let html = String(result.value || '');
  // 不内联图片（避免超大响应），其余内容保留
  html = html.replace(/<img[^>]*>/gi, '');
  if (html.length > 3 * 1024 * 1024) html = html.slice(0, 3 * 1024 * 1024);
  return { kind: 'docx', html };
}

function xlsxPreview(abs) {
  const stat = fs.statSync(abs);
  if (stat.size > MAX_DOCX) throw Object.assign(new Error('表格文件过大（>40MB），请下载查看'), { status: 415 });
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(abs, { cellStyles: false, sheetRows: MAX_ROWS + 1, bookDeps: false });
  const sheets = [];
  for (const name of workbook.SheetNames.slice(0, MAX_SHEETS)) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const trimmed = rows
      .slice(0, MAX_ROWS)
      .map((row) => row.slice(0, MAX_COLS).map((cell) => String(cell == null ? '' : cell)));
    while (trimmed.length && trimmed[trimmed.length - 1].every((cell) => cell === '')) trimmed.pop();
    sheets.push({ name, rows: trimmed });
  }
  return { kind: 'xlsx', sheets };
}

async function pptxPreview(abs) {
  const stat = fs.statSync(abs);
  if (stat.size > MAX_PPTX) throw Object.assign(new Error('幻灯片文件过大（>60MB），请下载查看'), { status: 415 });
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const slides = [];
  for (const name of slideNames.slice(0, MAX_SLIDES)) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => xmlUnescape(match[1]).trim())
      .filter(Boolean);
    slides.push({ index: Number(name.match(/slide(\d+)/)[1]), texts });
  }
  return { kind: 'pptx', slides };
}

async function zipPreview(abs) {
  const stat = fs.statSync(abs);
  if (stat.size > MAX_ZIP) throw Object.assign(new Error('压缩包过大（>60MB），请下载查看'), { status: 415 });
  const zip = await JSZip.loadAsync(fs.readFileSync(abs));
  const entries = Object.values(zip.files)
    .slice(0, MAX_ARCHIVE_ENTRIES)
    .map((file) => ({
      name: file.name,
      dir: file.dir,
      size: file.dir ? 0 : (file._data && file._data.uncompressedSize) || 0,
    }));
  return { kind: 'zip', entries, total: Object.keys(zip.files).length };
}

async function buildPreview(abs) {
  const ext = extOf(abs);
  if (!DOC_EXT.has(ext)) throw Object.assign(new Error('该文件类型不支持在线预览，请下载查看'), { status: 415 });
  if (ext === 'docx') return docxPreview(abs);
  if (ext === 'xlsx') return xlsxPreview(abs);
  if (ext === 'pptx') return pptxPreview(abs);
  return zipPreview(abs);
}

module.exports = { buildPreview, canPreview, DOC_EXT };
