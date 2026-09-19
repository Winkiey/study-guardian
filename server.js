#!/usr/bin/env node
/**
 * 学习守护平台 · 服务入口
 *
 * 启动方式：node server.js   （或 npm start / npm run dev）
 *
 * 零第三方依赖：只用 Node.js 内置模块 + 本机已安装的 Office 软件（可选）。
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config, { ensureRuntimeDirs } from './src/config.js';
import { getDb, closeDb } from './src/db/index.js';
import { HttpError, serveStatic, sendHtml, clientIp, redactUrl } from './src/lib/http.js';
import { attachGzip } from './src/lib/compress.js';
import { createRateLimiter, limiterKey, pickLimiter } from './src/lib/ratelimit.js';
import { createRouter } from './src/routes/index.js';
import { startScheduler, stopScheduler, tick } from './src/lib/scheduler.js';
import { bootstrapState } from './src/lib/auth.js';
import { converterStatus } from './src/lib/convert.js';
import { pendingPreviewMaterials, schedulePreview } from './src/lib/materials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'src', 'web', 'public');

// ============================================================
// 限流器
//
// 两个桶，各管一摊：
//   general —— 普通请求，宽松，别误伤自己（一个 71 页课件就是 70 多次请求）
//   auth    —— 登录接口，严格，因为这里能「试密码」
//
// 为什么 auth 的突发是 10：人打字会错几次，给点余量；
// 但错完这 10 次之后就只能一分钟试一次了，脚本爆破基本没戏。
// ============================================================

const generalLimiter = config.rateLimitPerMin > 0
  ? createRateLimiter({
    capacity: config.rateLimitPerMin,
    perMinute: config.rateLimitPerMin,
    name: 'general',
  })
  : null;

const authLimiter = config.rateLimitAuthPerMin > 0
  ? createRateLimiter({
    capacity: Math.max(10, config.rateLimitAuthPerMin),
    perMinute: config.rateLimitAuthPerMin,
    name: 'auth',
  })
  : null;

/** 定期清理长期不用的桶，避免被大量不同 IP 撑爆内存 */
function startLimiterSweeper() {
  if (!generalLimiter && !authLimiter) return null;
  const timer = setInterval(() => {
    generalLimiter?.sweep();
    authLimiter?.sweep();
  }, 10 * 60 * 1000);
  timer.unref?.();
  return timer;
}

// ============================================================
// 启动前检查
// ============================================================

/** Node 版本检查：node:sqlite 需要 22.5+ */
function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`\n✗ Node.js 版本过低：当前 ${process.version}，需要 v22.5.0 或更高。`);
    console.error('  原因：本平台使用 Node 内置的 node:sqlite，避免了原生依赖。');
    console.error('  请到 https://nodejs.org 下载 LTS 版本安装。\n');
    process.exit(1);
  }
}

/** 确保 data 目录与数据库就绪 */
function initStorage() {
  ensureRuntimeDirs();
  getDb();
}

// ============================================================
// 优雅退出
// ============================================================

let shuttingDown = false;

function setupGracefulShutdown(server) {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n收到 ${signal}，正在关闭…`);
    stopScheduler();

    server.close(() => {
      closeDb();
      console.log('已安全退出。数据都在 data/ 目录里，下次启动直接继续。');
      process.exit(0);
    });

    // 兜底：5 秒后强制退出，避免有长连接挂着不放手
    setTimeout(() => {
      console.warn('有连接未关闭，强制退出。');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('\n[未捕获异常]', err);
    // 数据库锁冲突之类的偶发错误不应该让整个服务挂掉
    if (err.code === 'SQLITE_BUSY' || err.code === 'EBUSY') {
      console.warn('这是偶发错误，服务继续运行。');
      return;
    }
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('\n[未处理的 Promise 拒绝]', reason);
  });
}

// ============================================================
// 全局安全响应头
// ============================================================

/**
 * 只写三条指令的 CSP。
 *
 * **故意不写** default-src / script-src / style-src：
 * 一个完整的 CSP 会把页面里的内联 `<script>`（首屏主题）和大量
 * `style="--dot-color:…"` 内联样式全部挡掉 —— 直接后果是**课程颜色消失**。
 * 要上完整版得先把这些内联写法重构掉，那是另一件事，别顺手做。
 *
 * 剩下这三条不碰任何资源加载，只做三件事，风险为零：
 *   frame-ancestors 'self'  不许被**别的站**套 iframe
 *   object-src 'none'       不许加载 <object>/<embed> 这类老式插件（本项目一个都没用）
 *   base-uri 'self'         不许有人注入 <base> 把页面里所有相对链接劫走
 *
 * ⚠️ frame-ancestors 必须是 `'self'`，**不能写成 `'none'`**。
 * 这条头会加到**所有**响应上，包括 /materials/:id/pdf —— 而 PDF 预览页
 * 恰恰是自己用 <iframe> 嵌自己的 PDF（同源）。
 * 写成 'none' 会把 iframe 一起挡掉，**PDF 预览直接白屏**。
 * X-Frame-Options 同理：用 SAMEORIGIN，不用 DENY。
 * 两者都挡得住「第三方页面套你」，区别只在于放不放行自己。
 */
const CONTENT_SECURITY_POLICY = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

/**
 * 给响应装上安全头。
 *
 * 用 setHeader 而不是在每个 writeHead 里各写一遍：Node 会把 setHeader 设过的头
 * 和之后 `writeHead(status, headers)` 里的头**合并**（同名的以 writeHead 为准）。
 * 所以在这里设一次，HTML、JSON、静态资源、302、304、404、429、500 全都会带上 ——
 * 本项目有七八个 writeHead 调用点，逐个改迟早漏一个，而漏掉的那个不会有任何报错。
 *
 * @param {import('node:http').ServerResponse} res
 */
function applySecurityHeaders(res) {
  // 别让浏览器猜内容类型：本站会把用户上传的文件原样发回去，
  // 猜错了就可能把上传的 .html 当页面执行（存储型 XSS 的经典触发方式）
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 跳到外站时只带域名、不带完整地址
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // 这个站用不到这些能力，明确关掉（别人就算想办法塞了脚本也用不了）
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');

  // 私人数据，别被搜索引擎收录。
  // 为什么要用响应头而不是只放 robots.txt：robots.txt 只对守规矩的爬虫有效，
  // 而这条头是随每个响应发出去的，更直接。以后绑了域名也不会突然被搜到。
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

// ============================================================
// 主处理流程
// ============================================================

const router = createRouter();

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const startedAt = Date.now();

  try {
    // 0. 安全头 + 自动 gzip。都放在最前面，这样后面所有响应
    //    （HTML / JSON / 静态资源 / 302 / 404 / 错误页）都自动受益。
    applySecurityHeaders(res);
    attachGzip(req, res);

    // 1. 限流。必须在做任何实际工作之前 ——
    //    被挡住请求不该消耗数据库查询、文件读取、scrypt 计算。
    const limiter = pickLimiter(url.pathname, method, {
      general: generalLimiter,
      auth: authLimiter,
    });
    if (limiter) {
      const verdict = limiter.take(limiterKey(req, config.trustProxy));
      if (!verdict.allowed) {
        return tooManyRequests(req, res, url, verdict.retryAfterSec, limiter.name);
      }
    }

    // 2. 静态资源
    if (url.pathname.startsWith('/static/')) {
      const relative = url.pathname.slice('/static/'.length);
      if (method === 'GET' || method === 'HEAD') {
        // 带 ?v= 的资源可以长期缓存——文件一变版本号就变，
        // 浏览器必然重新拉取，不会出现「还在用旧版 app.js」的问题
        return await serveStatic(req, res, STATIC_DIR, relative, {
          immutable: url.searchParams.has('v'),
        });
      }
    }

    // 3. 业务路由
    const matched = router.match(method, url.pathname);
    if (matched) {
      const ctx = {
        req,
        res,
        url,
        params: matched.params,
        wildcard: matched.wildcard,
        method,
      };
      return await matched.handler(ctx);
    }

    // 4. 404
    return notFoundResponse(req, res, url);
  } catch (err) {
    return errorResponse(req, res, err);
  } finally {
    logAccess(req, res, url, Date.now() - startedAt);
  }
}

/**
 * 429 响应。
 *
 * `Retry-After` 是标准头，浏览器和脚本都会认；
 * 正文给中文说明，因为用浏览器撞到这个页面的人多半是自己误触或忘了密码。
 */
function tooManyRequests(req, res, url, retryAfterSec, limiterName) {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  const wait = retryAfterSec >= 60 ? `${minutes} 分钟` : `${retryAfterSec} 秒`;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': retryAfterSec };

  console.warn(`[限流] ${clientIp(req)} 触发 ${limiterName} 限制，${url.pathname}，建议等待 ${wait}`);

  if (url.pathname.startsWith('/api/')) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(429, headers);
    res.end(JSON.stringify({ error: `请求太频繁，请等 ${wait} 后再试` }));
    return;
  }

  sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>请求太频繁</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="main" style="max-width:520px;margin:80px auto">
<div class="card"><div class="card__body" style="text-align:center">
<h1 class="page-title">请求太频繁</h1>
<p class="muted mt-sm">请等 <strong>${escapeForHtml(wait)}</strong> 后再试。</p>
<p class="muted small mt-sm">如果你是在登录时连续输错密码，稍等一会儿就好；
这是为了防止有人用脚本暴力猜密码。</p>
</div></div></div></body></html>`, 429, headers);
}

function notFoundResponse(req, res, url) {
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '接口不存在' }));
    return;
  }

  sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>页面不存在</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="main" style="max-width:520px;margin:80px auto">
<div class="card"><div class="card__body" style="text-align:center">
<h1 class="page-title">404</h1>
<p class="muted mt-sm">找不到这个页面：<code>${escapeForHtml(url.pathname)}</code></p>
<a class="btn btn--primary mt-md" href="/">回到总览</a>
</div></div></div></body></html>`, 404);
}

function errorResponse(req, res, err) {
  const isApi = req.url.startsWith('/api/');
  const status = err instanceof HttpError ? err.status : 500;

  if (status >= 500) {
    // 这里也不能直接打 req.url：它带着完整查询串，
    // 而订阅地址的 token 就在查询串里（和 logAccess 同一个理由）。
    console.error(`[错误] ${req.method} ${redactUrl(req.url)}`);
    console.error(err);
  }

  const message = err instanceof HttpError
    ? err.message
    : (config.isDev ? err.message : '服务器内部错误，请查看终端日志');

  if (isApi) {
    // err.details 是给前端补充的额外字段（例如「配置已经帮你修正成什么样了」）。
    // 只在是普通对象时展开，避免误传数组/字符串把响应体弄坏。
    const extra = err instanceof HttpError && err.details
      && typeof err.details === 'object' && !Array.isArray(err.details)
      ? err.details
      : {};
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message, ...extra }));
    return;
  }

  if (status === 401) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  sendHtml(res, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>出错了</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="main" style="max-width:560px;margin:80px auto">
<div class="card"><div class="card__body">
<h1 class="page-title">出错了（${status}）</h1>
<p class="muted mt-sm">${escapeForHtml(message)}</p>
<a class="btn btn--outline mt-md" href="/">回到总览</a>
</div></div></div></body></html>`, status);
}

function escapeForHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把日志里的敏感查询参数打码 —— 实现放在 src/lib/http.js 的 redactUrl()，
 * 那里有完整的理由说明（一句话：日历订阅 token 会被手机定时轮询，
 * 明文写进日志等于把凭据抄一份到磁盘上）。
 */

/** 访问日志。静态资源不记，避免刷屏。 */
function logAccess(req, res, url, durationMs) {
  if (url.pathname.startsWith('/static/')) return;
  if (url.pathname === '/favicon.ico') return;

  const status = res.statusCode;
  const mark = status >= 500 ? '✗' : status >= 400 ? '!' : '·';
  const time = new Date().toTimeString().slice(0, 8);
  const ms = durationMs > 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;

  console.log(`${mark} ${time} ${req.method.padEnd(6)} ${status} ${redactUrl(url.pathname + url.search)} ${ms}`);
}

// ============================================================
// 启动横幅
// ============================================================

/** 列出本机局域网 IP，方便手机访问 */
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function printBanner() {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  const initialized = bootstrapState().initialized;
  const converter = converterStatus();

  const lines = [
    '',
    '  ╭──────────────────────────────────────────────╮',
    `  │  ${config.appName.padEnd(42)}│`,
    '  ╰──────────────────────────────────────────────╯',
    '',
    `  访问地址   ${url}`,
  ];

  if (config.host === '0.0.0.0') {
    const ips = localAddresses();
    if (ips.length) {
      lines.push('  手机访问   ' + ips.map((ip) => `http://${ip}:${config.port}`).join('  '));
      lines.push('             （手机要和电脑连同一个 Wi-Fi）');
    }
  } else {
    lines.push('  提示       当前只监听本机。想让手机也能打开，把 .env 里的 HOST 改成 0.0.0.0');
  }

  lines.push('');
  lines.push(`  数据目录   ${config.dataDir}`);
  lines.push(`  Office 转换 ${converter.available ? converter.label : '未检测到（PPT 将用网页版预览）'}`);
  lines.push(`  提醒调度   每 ${config.schedulerIntervalSec} 秒检查一次`);

  if (!initialized) {
    lines.push('');
    lines.push('  ➜ 首次使用：打开上面的地址，会引导你创建账号。');
  }

  lines.push('');
  lines.push('  按 Ctrl+C 停止服务');
  lines.push('');

  console.log(lines.join('\n'));
}

// ============================================================
// 启动
// ============================================================

async function main() {
  checkNodeVersion();
  initStorage();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // handleRequest 内部已经处理了错误，这里是最后一道保险
      console.error('[致命] 请求处理失败：', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
    });
  });

  // 让长连接（音视频拖动、大文件下载）有充足时间
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0; // 上传大文件时不能超时

  setupGracefulShutdown(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✗ 端口 ${config.port} 已被占用。`);
      console.error('  可能是本平台已经在运行了（打开 http://localhost:' + config.port + ' 看看）。');
      console.error('  想换端口：在 .env 里改 PORT=别的数字，或临时执行：');
      console.error(`    set PORT=3081 && node server.js\n`);
      process.exit(1);
    }
    console.error('\n✗ 服务启动失败：', err.message, '\n');
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    printBanner();
    startScheduler();
    startLimiterSweeper();
    requeueStuckPreviews();
  });
}

/**
 * 把卡在「等待生成」的课件重新排进预览队列。
 *
 * 为什么需要：预览转换是在后台跑的，进程如果在转换途中被重启
 * （pm2 restart、被 OOM 杀掉、断电），那份课件就永远停在 pending ——
 * 界面上一直显示「正在生成预览」，而没有任何东西会再去碰它，
 * 用户只能删掉重传。
 *
 * 启动时扫一遍就自愈了，还顺带把「服务重启时正在排队的那几个」捡回来。
 */
function requeueStuckPreviews() {
  let ids = [];
  try {
    ids = pendingPreviewMaterials();
  } catch (err) {
    console.error('[预览] 扫描未完成的预览时出错：', err.message);
    return;
  }

  if (ids.length === 0) return;

  console.log(`[预览] 有 ${ids.length} 份课件停在「等待生成」，重新排队：${ids.join(' ')}`);
  for (const id of ids) schedulePreview(id);
}

main();
