/**
 * 文件处理：类型识别、落盘、文本抽取。
 *
 * 「课堂资料的在线预览」是核心需求之一，所以这里要做的判断比较多：
 * 不同扩展名走不同的预览路径，能转 PDF 的转 PDF，不能转的抽文本渲染成网页版。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config, { ensureRuntimeDirs } from '../config.js';

// ============================================================
// 类型识别
// ============================================================

/** 预览方式：决定了前端用什么组件渲染 */
export const KIND = {
  PDF: 'pdf',
  PPT: 'ppt',
  WORD: 'word',
  EXCEL: 'excel',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  TEXT: 'text',
  ARCHIVE: 'archive',
  OTHER: 'other',
};

export const KIND_LABELS = {
  pdf: 'PDF 文档',
  ppt: '演示文稿',
  word: 'Word 文档',
  excel: '表格',
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
  archive: '压缩包',
  other: '其他文件',
};

export const KIND_ICONS = {
  pdf: '📕',
  ppt: '📊',
  word: '📘',
  excel: '📗',
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  text: '📄',
  archive: '🗜️',
  other: '📎',
};

const EXT_KIND = {
  '.pdf': KIND.PDF,

  '.ppt': KIND.PPT,
  '.pptx': KIND.PPT,
  '.pps': KIND.PPT,
  '.ppsx': KIND.PPT,
  '.odp': KIND.PPT,

  '.doc': KIND.WORD,
  '.docx': KIND.WORD,
  '.rtf': KIND.WORD,
  '.odt': KIND.WORD,

  '.xls': KIND.EXCEL,
  '.xlsx': KIND.EXCEL,
  '.ods': KIND.EXCEL,
  '.csv': KIND.EXCEL,

  '.png': KIND.IMAGE,
  '.jpg': KIND.IMAGE,
  '.jpeg': KIND.IMAGE,
  '.gif': KIND.IMAGE,
  '.webp': KIND.IMAGE,
  '.avif': KIND.IMAGE,
  '.bmp': KIND.IMAGE,
  '.svg': KIND.IMAGE,
  '.ico': KIND.IMAGE,
  '.heic': KIND.IMAGE,

  '.mp4': KIND.VIDEO,
  '.webm': KIND.VIDEO,
  '.mov': KIND.VIDEO,
  '.mkv': KIND.VIDEO,
  '.avi': KIND.VIDEO,
  '.m4v': KIND.VIDEO,

  '.mp3': KIND.AUDIO,
  '.m4a': KIND.AUDIO,
  '.wav': KIND.AUDIO,
  '.ogg': KIND.AUDIO,
  '.flac': KIND.AUDIO,
  '.aac': KIND.AUDIO,

  '.txt': KIND.TEXT,
  '.md': KIND.TEXT,
  '.markdown': KIND.TEXT,
  '.json': KIND.TEXT,
  '.xml': KIND.TEXT,
  '.yml': KIND.TEXT,
  '.yaml': KIND.TEXT,
  '.html': KIND.TEXT,
  '.htm': KIND.TEXT,
  '.css': KIND.TEXT,
  '.js': KIND.TEXT,
  '.ts': KIND.TEXT,
  '.py': KIND.TEXT,
  '.java': KIND.TEXT,
  '.c': KIND.TEXT,
  '.cpp': KIND.TEXT,
  '.h': KIND.TEXT,
  '.sql': KIND.TEXT,
  '.log': KIND.TEXT,
  '.ini': KIND.TEXT,
  '.tex': KIND.TEXT,

  '.zip': KIND.ARCHIVE,
  '.rar': KIND.ARCHIVE,
  '.7z': KIND.ARCHIVE,
  '.tar': KIND.ARCHIVE,
  '.gz': KIND.ARCHIVE,
};

/** 可以由 Office 套件转成 PDF 的扩展名 */
const CONVERTIBLE = new Set(['.ppt', '.pptx', '.pps', '.ppsx', '.doc', '.docx', '.xls', '.xlsx', '.rtf']);

/** 纯文本类扩展名 */
const TEXT_EXTS = new Set(
  Object.entries(EXT_KIND).filter(([, k]) => k === KIND.TEXT).map(([e]) => e),
);

/** 规范化扩展名：小写、带点、只保留安全字符 */
export function normalizeExt(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/** 由文件名推断预览类型 */
export function detectKind(filename) {
  return EXT_KIND[normalizeExt(filename)] || KIND.OTHER;
}

export function isConvertible(ext) {
  return CONVERTIBLE.has(ext);
}

export function isTextLike(ext) {
  return TEXT_EXTS.has(ext);
}

// ============================================================
// 文件名与存储
// ============================================================

/**
 * 清理用户提供的文件名：去掉路径成分与控制字符，限制长度。
 * 保留中文，因为课件名基本是中文。
 */
export function sanitizeFilename(name) {
  let out = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  // 去掉控制字符与 Windows 非法字符
  out = out.replace(/[\u0000-\u001f\u007f]/g, '');
  out = out.replace(/[<>:"|?*]/g, '_');
  out = out.trim().replace(/^\.+/, '');
  if (!out) out = 'unnamed';
  if (out.length > 180) {
    const ext = normalizeExt(out);
    out = out.slice(0, 180 - ext.length) + ext;
  }
  return out;
}

/**
 * 生成落盘文件名：随机 ID + 扩展名。
 *
 * 不用原始文件名的原因：中文名、重名、路径穿越都可能出问题，
 * 原始名单独存在数据库的 original_name 字段里，下载时再还原。
 */
export function makeStoredName(ext) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${stamp}-${crypto.randomBytes(8).toString('hex')}${ext || ''}`;
}

/**
 * 按年份/月份分目录存放，避免单个目录塞进几千个文件。
 * 返回相对于 uploadDir 的相对路径（用 / 分隔）。
 */
export function storageSubdir(date = new Date()) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 上传目录下的绝对路径 */
export function uploadPath(relative) {
  ensureRuntimeDirs();
  const full = path.resolve(config.uploadDir, relative);
  const root = path.resolve(config.uploadDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('非法的存储路径');
  }
  return full;
}

/**
 * 派生文件（转换出来的 PDF、导出的幻灯片图片）的绝对路径。
 *
 * 为什么不直接用 uploadPath()：
 * 上传的文件必须待在 uploads 目录里，所以 uploadPath() 会把任何跑出
 * uploads 的路径判成非法 —— 这个严格是对的，别去放宽它。
 * 但**派生文件按设计就放在 cache 目录**：pdf_name 存进库里的形式是
 * `../cache/pdf/xxx.pdf`（相对于 uploads），用 uploadPath() 一取就抛
 * 「非法的存储路径」。
 *
 * 真实后果：Office 转换明明成功了、PDF 也躺在磁盘上，用户点开却说打不开。
 * 而这条路由在 PDF 转换修好之前从没被真正走通过（pdf_name 一直是空的），
 * 所以问题一直潜伏着，直到转换开始正常工作才暴露。
 *
 * 这里仍然从 uploadDir 起算（沿用已定的存储约定），但把边界放宽到
 * **整个数据目录** —— uploads 和 cache 都在它下面，派生文件跑不出 data 即可。
 */
export function derivedPath(relative) {
  if (!relative) throw new Error('缺少文件路径');
  ensureRuntimeDirs();
  const full = path.resolve(config.uploadDir, relative);
  const root = path.resolve(config.dataDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('非法的派生文件路径');
  }
  return full;
}

/** 写入上传的文件 */
export async function saveUpload(buffer, ext) {
  const subdir = storageSubdir();
  const dir = uploadPath(subdir);
  await fsp.mkdir(dir, { recursive: true });
  const storedName = makeStoredName(ext);
  const relPath = `${subdir}/${storedName}`;
  await fsp.writeFile(uploadPath(relPath), buffer);
  return { storedName, relPath, size: buffer.length };
}

/** 删除已上传的文件（连同其预览产物） */
export async function removeUpload(relPath, pdfName) {
  for (const target of [relPath, pdfName].filter(Boolean)) {
    let abs;
    try {
      // 两种路径不能用同一条规则解析：
      //   上传的原件在 uploads 下          → uploadPath()
      //   转换出的 PDF 在 cache 下（存成 ../cache/pdf/xx.pdf）→ derivedPath()
      // 一律用 uploadPath() 会让 PDF 那条抛「非法的存储路径」，
      // 而下面又是 catch 吞掉的 —— 现象就是课件删掉了、PDF 却永远留在缓存目录里。
      // 这属于「不报错但东西没清掉」，只能靠这里分对。
      abs = target.startsWith('..') ? derivedPath(target) : uploadPath(target);
    } catch {
      continue; // 路径本身不合法，没什么可删的
    }
    try {
      await fsp.unlink(abs);
    } catch {
      /* 文件可能已被删除，忽略 */
    }
  }
}

// ============================================================
// 展示辅助
// ============================================================

/** 人类可读的文件大小 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ============================================================
// 文本读取（带编码识别）
// ============================================================

/**
 * 读取文本文件。
 *
 * 国内课程资料常见 GBK/GB18030 编码，直接按 UTF-8 读会乱码。
 * Node 自带 full-icu，`TextDecoder('gb18030')` 可用，这里做自动识别：
 *   1. 有 BOM 按 BOM 走
 *   2. 能按 UTF-8 严格解码（fatal）就按 UTF-8
 *   3. 否则按 GB18030
 */
export async function readTextFile(filePath, maxBytes = 2 * 1024 * 1024) {
  const stat = await fsp.stat(filePath);
  const length = Math.min(stat.size, maxBytes);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    return decodeText(buf);
  } finally {
    await fh.close();
  }
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(buf.subarray(2));
    } catch {
      /* 落到下面 */
    }
  }

  try {
    // fatal: true 让非法 UTF-8 序列直接抛错，从而识别出 GBK 文件
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

// ============================================================
// Office 文档文本抽取
// ============================================================

/**
 * 抽取 PPT/Word/Excel 的文本内容，用于：
 *   1. 全文检索（搜「第几周讲了什么」）
 *   2. 转 PDF 失败时的网页版兜底预览
 *
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function extractOfficeText(filePath, ext) {
  try {
    const { extractOffice } = await import('./office.js');
    const buffer = await fsp.readFile(filePath);
    const data = extractOffice(buffer, ext);
    if (!data) return { ok: false, error: '该格式不支持文本抽取' };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `文档解析失败：${err.message}` };
  }
}

/** 把抽取结果压成一段可搜索的纯文本 */
export function flattenOfficeText(ext, data) {
  if (!data) return '';
  const parts = [];

  if (ext === '.pptx' || ext === '.ppt') {
    for (const slide of data.slides || []) {
      if (slide.title) parts.push(slide.title);
      if (slide.texts) parts.push(...slide.texts);
      if (slide.notes) parts.push(slide.notes);
    }
  } else if (ext === '.docx' || ext === '.doc') {
    if (data.text) return String(data.text);
    for (const block of data.blocks || []) {
      if (block.text) parts.push(block.text);
      for (const row of block.rows || []) parts.push(row.join(' '));
    }
  } else if (ext === '.xlsx' || ext === '.xls') {
    for (const sheet of data.sheets || []) {
      parts.push(sheet.name);
      for (const row of sheet.rows || []) parts.push(row.join(' '));
    }
  }

  return parts.filter(Boolean).join('\n').slice(0, 200_000);
}

/** 从文本里推断 PPT 页数（用于列表展示） */
export function inferSlideCount(data) {
  return Number(data?.slideCount || data?.slides?.length || 0) || null;
}

/** 判断文件是否存在且非空 */
export function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
