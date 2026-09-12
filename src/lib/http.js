/**
 * HTTP 基础设施：路由、请求体解析、Cookie、静态文件、响应工具。
 *
 * 全部基于 node:http 手写，零第三方依赖。
 * 其中 multipart/form-data 解析器是自己实现的——文件上传必须用它。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import config from '../config.js';

// ============================================================
// 错误类型
// ============================================================

/** 带 HTTP 状态码的业务错误，会被统一错误处理转成合适的响应 */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = '请先登录') => new HttpError(401, msg);
export const forbidden = (msg = '没有权限') => new HttpError(403, msg);
export const notFound = (msg = '资源不存在') => new HttpError(404, msg);

// ============================================================
// 路由
// ============================================================

/**
 * 极简路由器。
 *
 * 支持路径参数：`/api/courses/:id` 匹配 `/api/courses/42`，
 * 处理器通过 `ctx.params.id` 取值。
 * 支持通配后缀：`/files/*` 匹配 `/files/a/b/c`，通过 `ctx.wildcard` 取值。
 */
export class Router {
  constructor() {
    /** @type {Array<{method:string, segments:string[], handler:Function, kind:string}>} */
    this.routes = [];
  }

  /** 注册路由。method 传 '*' 表示任意方法。 */
  add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    const kind = segments[segments.length - 1] === '*' ? 'wildcard' : 'exact';
    if (kind === 'wildcard') segments.pop();
    this.routes.push({ method: method.toUpperCase(), segments, handler, kind });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /**
   * 匹配一条路由。
   * 返回 `{ handler, params, wildcard }` 或 null。
   *
   * 匹配规则：**字面量优先于参数**。
   * 也就是说 `/materials/upload-form` 会赢过 `/materials/:id`，
   * 不受注册先后顺序影响——这样新增路由时不用担心被已有规则抢走。
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean).map(safeDecode);
    let methodMismatch = false;

    // 同一路径可能同时命中字面量路由与参数路由，按「具体程度」排序后再取第一条
    const candidates = [];

    for (const route of this.routes) {
      if (!this.#pathMatches(route, parts)) continue;

      if (route.method !== '*' && route.method !== method) {
        methodMismatch = true;
        continue;
      }
      candidates.push(route);
    }

    if (candidates.length) {
      candidates.sort((a, b) => specificity(b) - specificity(a));
      const route = candidates[0];

      if (route.kind === 'wildcard') {
        return {
          handler: route.handler,
          params: matchSegments(route.segments, parts),
          wildcard: parts.slice(route.segments.length).join('/'),
        };
      }
      return {
        handler: route.handler,
        params: matchSegments(route.segments, parts),
        wildcard: '',
      };
    }

    if (methodMismatch) throw new HttpError(405, '请求方法不被支持');
    return null;
  }

  #pathMatches(route, parts) {
    if (route.kind === 'wildcard') return parts.length >= route.segments.length;
    if (parts.length !== route.segments.length) return false;
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) continue;
      if (seg !== parts[i]) return false;
    }
    return true;
  }
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = parts[i];
  }
  return params;
}

/** 路由「具体程度」：字面量段越多越具体，用于挑出更精确的匹配 */
function specificity(route) {
  let score = 0;
  for (const seg of route.segments) {
    score += seg.startsWith(':') ? 0 : 2;
  }
  // 通配路由优先级最低
  return route.kind === 'wildcard' ? score - 1 : score;
}

/** 解码单个路径段；非法编码（如 %ZZ）时退回原值，不让整个请求 500 */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ============================================================
// Cookie
// ============================================================

/** 解析 Cookie 头为对象 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** 生成 Set-Cookie 值 */
export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.sameSite !== false) parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

// ============================================================
// 请求体解析
// ============================================================

/** 读取整个请求体为 Buffer，超过上限直接报错（避免内存被打爆） */
export async function readBody(req, limit = config.maxUploadBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new HttpError(413, `请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 解析 JSON 请求体 */
export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
}

/** 解析 application/x-www-form-urlencoded */
export function parseUrlEncoded(text) {
  const params = new URLSearchParams(text);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

/**
 * 解析 multipart/form-data。
 *
 * 自己实现的原因：文件上传不可避免，而引入 busboy/formidable 会破坏零依赖目标。
 *
 * 返回 `{ fields: {name: string}, files: [{ field, filename, mime, data: Buffer }] }`。
 * 为避免大文件占内存，这里仍是一次性读入 Buffer 后再切分——
 * 对个人自用的课件（几十 MB）完全够用，上限由 config.maxUploadBytes 控制。
 */
export function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || '').trim();
  if (!boundary) throw badRequest('multipart 请求缺少 boundary');

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  // 用 indexOf 在 Buffer 上找分隔符，绝不能用字符串转换——二进制文件会损坏
  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) throw badRequest('multipart 请求体格式错误：找不到分隔符');

  while (cursor !== -1) {
    let start = cursor + delimiter.length;

    // 结束标记是 `--boundary--`
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;

    // 跳过分隔符后的 CRLF
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    else if (buffer[start] === 0x0a) start += 1;

    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;

    // 本段内容：去掉结尾的 CRLF
    let end = next;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    else if (buffer[end - 1] === 0x0a) end -= 1;

    const part = buffer.subarray(start, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headerEndAlt = headerEnd === -1 ? part.indexOf('\n\n') : headerEnd;

    if (headerEndAlt !== -1) {
      const headerText = part.subarray(0, headerEndAlt).toString('utf8');
      const bodyStart = headerEndAlt + (headerEnd === -1 ? 2 : 4);
      const body = part.subarray(bodyStart);
      const headers = parsePartHeaders(headerText);

      const disposition = headers['content-disposition'] || '';
      const name = getDispositionParam(disposition, 'name');
      const filename = getDispositionParam(disposition, 'filename');

      if (name) {
        // 浏览器对「未选择文件」的文件输入框，会发一个 filename="" 的空部分。
        // 这种必须当成「没有文件」，而不是「上传了一个空文件」——
        // 否则它会盖掉同一个表单里真正有值的文本字段（例如「粘贴表格内容」）。
        if (filename !== null && filename !== '') {
          files.push({
            field: name,
            filename: decodeFilename(filename),
            mime: headers['content-type'] || 'application/octet-stream',
            data: Buffer.from(body),
          });
        } else if (filename === null) {
          fields[name] = body.toString('utf8');
        }
      }
    }

    cursor = next;
  }

  return { fields, files };
}

function parsePartHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/** 取 Content-Disposition 里的参数；不存在返回 null（注意 filename="" 要返回空串） */
function getDispositionParam(disposition, key) {
  const re = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;]*))`, 'i');
  const m = re.exec(disposition);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

/** 文件名可能带 RFC 5987 的 filename* 编码，做个兜底解码 */
function decodeFilename(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 统一入口：按 Content-Type 解析请求体 */
export async function readBodyAuto(req) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) return { type: 'json', data: await readJson(req) };

  if (ct.includes('multipart/form-data')) {
    const buf = await readBody(req);
    return { type: 'multipart', data: parseMultipart(buf, ct) };
  }

  if (ct.includes('application/x-www-form-urlencoded')) {
    const buf = await readBody(req, 1024 * 1024);
    return { type: 'form', data: parseUrlEncoded(buf.toString('utf8')) };
  }

  const buf = await readBody(req, config.maxUploadBytes);
  return { type: 'raw', data: buf };
}

// ============================================================
// 响应工具
// ============================================================

export function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, text, status = 200, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

export function sendHtml(res, html, status = 200) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    // HTML 一律不缓存：页面里引用的是带版本号的 CSS/JS 地址，
    // 页面本身要是被缓存了，就会一直指向旧版本的资源地址，
    // 于是又回到「按钮点了没反应」的老问题上。
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location });
  res.end();
}

/** 生成 ETag（内容哈希，用于 If-None-Match 协商缓存） */
export function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * 发送文件，支持 Range 请求（音视频拖动进度条需要）
 * 与 If-None-Match 协商缓存。
 */
export async function sendFile(req, res, filePath, opts = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw notFound('文件不存在');
  }
  if (!stat.isFile()) throw notFound('不是文件');

  const mime = opts.mime || mimeTypeFor(filePath);
  const headers = {
    'Content-Type': mime,
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
  };
  if (opts.downloadName) {
    headers['Content-Disposition'] =
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`;
  }
  if (opts.inlineName) {
    headers['Content-Disposition'] =
      `inline; filename*=UTF-8''${encodeURIComponent(opts.inlineName)}`;
  }
  headers['Cache-Control'] = opts.cacheControl || 'private, max-age=0, must-revalidate';
  const etag = etagFor(stat);
  headers.ETag = etag;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  // Range 请求
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const size = stat.size;
      let start;
      let end;
      if (m[1] === '' && m[2] !== '') {
        // bytes=-500 表示最后 500 字节
        const suffix = Number.parseInt(m[2], 10);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number.parseInt(m[1], 10);
        end = m[2] === '' ? size - 1 : Number.parseInt(m[2], 10);
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      await pipeline(fs.createReadStream(filePath, { start, end }), res);
      return;
    }
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(filePath), res);
}

// ============================================================
// MIME 类型
// ============================================================

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // 少了这一条会退化成 application/octet-stream，
  // 浏览器就认不出这是「网页应用清单」，手机添加到主屏时名字和图标会缺
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  // 用户可能上传也可能下载，统一给通用类型
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export const MIME_MAP_EXPORT = MIME_MAP;

// ============================================================
// 静态文件服务
// ============================================================

/**
 * 从 rootDir 提供静态文件。
 * 会防御路径穿越（`../`）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.immutable]
 *   调用方确认这个 URL 里带了内容版本号（`?v=xxx`）时为 true。
 *   此时可以放心地让浏览器长期缓存——因为文件一变，URL 里的版本号也会变，
 *   浏览器必然会去拉新的，不会出现「还在用旧版 app.js」的问题。
 */
export async function serveStatic(req, res, rootDir, relativePath, opts = {}) {
  const safePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, safePath);
  const rootResolved = path.resolve(rootDir);

  // 路径穿越防护
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw forbidden('非法路径');
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw notFound('静态资源不存在');
  }
  if (stat.isDirectory()) throw notFound('静态资源不存在');

  const etag = etagFor(stat);
  const headers = {
    'Content-Type': mimeTypeFor(resolved),
    'Content-Length': stat.size,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': opts.immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(resolved), res);
}

// ============================================================
// 杂项
// ============================================================

/** 生成随机 ID（用于文件名、token） */
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** HTML 转义，模板里凡是插入用户数据都必须走这里 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 客户端 IP，用于日志 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || '-';
}
