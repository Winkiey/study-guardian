/**
 * gzip 压缩。
 *
 * 为什么值得做：这个平台常常跑在「按流量计费」的云服务器上，出站流量是要花钱的。
 * 实测本项目自己的静态资源：
 *
 *   app.js    107 KB → 31 KB
 *   app.css    95 KB → 22 KB
 *
 * 也就是说**光这两文件就能省掉四分之三**。对用户来说是页面打开更快，
 * 对账单来说是每次请求少花四分之三的钱 —— 两头都赚。
 *
 * 零依赖：只用 Node 内置的 zlib（和内置 zip 读取用的是同一个库）。
 */

import zlib from 'node:zlib';
import fsp from 'node:fs/promises';

/** 小于这个体积就不值得压：gzip 头尾本身有开销，压了可能反而变大 */
const MIN_BYTES = 1024;

/**
 * 这些类型压了有收益（都是文本）。
 *
 * 注意 PNG / JPEG / PDF / ZIP / MP4 都**不在**列表里 ——
 * 它们本身已经是压缩格式，再 gzip 一遍只会白费 CPU，体积几乎不变。
 */
const COMPRESSIBLE = [
  /^text\//,
  /^application\/(?:json|javascript|manifest\+json|xml|xhtml\+xml)/,
  /^image\/svg\+xml/,
];

/**
 * 解析 Accept-Encoding，返回 gzip 的 q 值（不支持返回 0）。
 *
 * 不能只做 `includes('gzip')`：`gzip;q=0` 的意思是「我明确不要 gzip」，
 * 那种情况下还压过去就是违反协议。
 */
export function gzipQuality(header) {
  if (typeof header !== 'string' || !header) return 0;

  let best = 0;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (name !== 'gzip' && name !== '*') continue;

    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (Number.isFinite(q)) best = Math.max(best, q);
  }
  return best;
}

/** 这个请求能不能接受 gzip */
export function acceptsGzip(req) {
  return gzipQuality(req.headers['accept-encoding']) > 0;
}

/** 这个 Content-Type 值不值得压 */
export function isCompressibleType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE.some((re) => re.test(type));
}

/** 根据响应头判断这块正文该不该压 */
export function shouldCompress({ status = 200, headers = {} }, body) {
  if (!body || body.length < MIN_BYTES) return false;
  // 换段、304 都没有正文，206 是 Range 分片，压了会把 Content-Range 搞乱
  if (status === 204 || status === 304 || status === 206) return false;
  // 已经压过了就别叠一层
  if (headers['Content-Encoding'] || headers['content-encoding']) return false;
  const type = headers['Content-Type'] || headers['content-type'];
  return isCompressibleType(type);
}

/**
 * 把压缩相关的头写进去。
 *
 * `Vary: Accept-Encoding` 是必须的：同一个 URL 对不同客户端会返回不同字节，
 * 中间任何缓存（CDN、反向代理）都必须按这个头分开缓存，
 * 否则会把 gzip 版本发给不支持 gzip 的客户端，对方拿到一堆乱码。
 */
export function applyCompressionHeaders(headers, compressedLength) {
  delete headers['Content-Length'];
  delete headers['content-length'];
  headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = compressedLength;

  const existing = headers.Vary || headers.vary;
  if (!existing) headers.Vary = 'Accept-Encoding';
  else if (!/accept-encoding/i.test(String(existing))) {
    headers.Vary = `${existing}, Accept-Encoding`;
  }
  return headers;
}

const gzipAsync = (buf) => new Promise((resolve, reject) => {
  zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
});

/**
 * 文件级 gzip 缓存。
 *
 * 静态资源会被反复请求，每次重新压一遍纯属浪费。
 * 缓存以「文件路径」为键、以「大小 + 修改时间」为有效性校验 ——
 * 文件改了自动失效，不需要谁去手动清。
 * 顺带也天然支持了「改了样式不重启也能生效」。
 */
const fileCache = new Map();
const FILE_CACHE_MAX = 64;

export async function gzipFile(filePath, stat) {
  const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const hit = fileCache.get(filePath);
  if (hit && hit.stamp === stamp) return hit.gz;

  const raw = await fsp.readFile(filePath);
  const gz = await gzipAsync(raw);

  // 简单的容量上限：够用就好，别让 Map 无限长
  if (fileCache.size >= FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    fileCache.delete(oldest);
  }
  fileCache.set(filePath, { stamp, gz });
  return gz;
}

/** 测试用：清掉文件缓存 */
export function resetCompressCache() {
  fileCache.clear();
}

/**
 * 给一个响应对象装上「自动 gzip」。
 *
 * 为什么要拦 writeHead、而不是直接在发之前改头：
 * Node 在 `writeHead()` 之后就不许再 `setHeader()` 了（会抛 ERR_HTTP_HEADERS_SENT），
 * 而头一旦 writeHead 过就已经序列化好了，改不动。
 * 所以这里把 writeHead 的参数**先存下来**，等到 end() 时知道正文有多大了，
 * 再决定要不要压、把 Content-Length 改成压缩后的长度，最后才真正发出去。
 *
 * 流式响应（比如 sendFile 的 pipeline）会在 write() 时被识别出来，
 * 立刻把存下的头发出去并彻底放行 —— 那种响应的长度事先不知道，不适合在这里压。
 * 静态资源走的是 serveStatic 里单独的压缩路径。
 *
 * @returns {boolean} 是否装上了
 */
export function attachGzip(req, res) {
  if (!acceptsGzip(req)) return false;
  if (req.method === 'HEAD') return false;

  const realWriteHead = res.writeHead;
  const realWrite = res.write;
  const realEnd = res.end;

  /** writeHead 的参数暂存在这里；null 表示还没调用过 */
  let captured = null;
  /** 是否已经流式写过正文 */
  let streamed = false;

  const sendHead = (status, statusMessage, headers) => {
    if (statusMessage === undefined) return realWriteHead.call(res, status, headers);
    return realWriteHead.call(res, status, statusMessage, headers);
  };

  res.writeHead = function (status, statusMessage, headers) {
    // 支持 writeHead(status, headers) 和 writeHead(status, statusMessage, headers)
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }

    // 调用两次是个 bug（Node 本来会抛 ERR_HTTP_HEADERS_SENT）。
    // 这里必须把它放行给真正的 writeHead，让它照原样抛 ——
    // 否则会被我这一层默默吞掉，把 bug 藏起来。
    if (captured) {
      sendHead(captured.status, captured.statusMessage, captured.headers);
      captured = null;
      return realWriteHead.call(res, status, statusMessage, headers);
    }

    captured = { status, statusMessage, headers: { ...(headers || {}) } };
    return res;
  };

  res.write = function (chunk, ...rest) {
    streamed = true;
    if (captured) {
      const c = captured;
      captured = null;
      sendHead(c.status, c.statusMessage, c.headers);
    }
    return realWrite.call(res, chunk, ...rest);
  };

  res.end = function (chunk, encoding, callback) {
    // res.end(cb) 这种写法
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
      encoding = undefined;
    }

    if (streamed) return realEnd.call(res, chunk, encoding, callback);

    // 没调用过 writeHead 就当 200 + 空头（Node 本来也是这个默认）
    const c = captured || { status: 200, statusMessage: undefined, headers: {} };
    captured = null;

    const body = chunk === undefined || chunk === null
      ? null
      : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');

    if (!shouldCompress({ status: c.status || 200, headers: c.headers }, body)) {
      sendHead(c.status, c.statusMessage, c.headers);
      return realEnd.call(res, chunk, encoding, callback);
    }

    const gz = zlib.gzipSync(body);
    // 先清掉可能由 setHeader 设过的 Content-Length（此刻头还没发出去，清得掉）
    res.removeHeader('Content-Length');
    sendHead(c.status, c.statusMessage, applyCompressionHeaders({ ...c.headers }, gz.length));
    return realEnd.call(res, gz);
  };

  return true;
}
