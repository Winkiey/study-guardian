/**
 * 零第三方依赖的 SMTP 邮件发送客户端
 * =====================================================================
 * 只使用 Node 内置模块：node:net / node:tls / node:crypto / node:os。
 * 适用场景：学习守护平台的 DDL 提醒备用通道（QQ 邮箱 / 163 / Gmail / 学校邮箱）。
 *
 * 实现要点（对应真实服务器行为）：
 *  1. 严格「一问一答」：每条命令后读取完整响应；支持多行响应（`250-` 续行，最后一行以 `250 ` 结束）。
 *     缓冲区按 CRLF 切分，绝不假设一次 data 事件等于一条完整响应。
 *  2. 先 EHLO，失败回退 HELO；解析 SIZE / STARTTLS / AUTH 能力列表。
 *  3. STARTTLS：明文连接 + 服务器声明 STARTTLS 时升级，升级后 **重新 EHLO**，并丢弃明文阶段残留数据。
 *  4. 隐式 TLS（465）：直接 tls.connect，servername 设为 host（IP 除外）以正确 SNI / 校验证书。
 *  5. AUTH：优先 AUTH PLAIN，其次 AUTH LOGIN（含服务器在 EHLO 中先给出初始挑战的形态）。
 *     535 时在错误里提示国内邮箱要使用「授权码」。
 *  6. 信封与投递：MAIL FROM / RCPT TO(可多个) / DATA / 正文 / `\r\n.\r\n` / QUIT，
 *     正文统一 CRLF 换行并做点开头转义（dot-stuffing）。
 *  7. MIME 报文：Date / From / To / Cc / Subject(encoded-word) / Message-ID / MIME-Version，
 *     text+html 时使用 multipart/alternative（text 在前），base64 每行 76 字符，头部按 78 折行。
 *  8. 整体超时（默认 20s）到点真正 destroy socket 并 reject，绝不挂住进程；不做连接池，每次调用独立连接。
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';

/** 协议规定的行结束符 */
const CRLF = '\r\n';
/** 默认整体超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 20000;
/** 头部物理行长度上限（RFC 5322 建议 78） */
const HEADER_LINE_LIMIT = 78;
/**
 * 单个 encoded-word 承载的最大原始字节数。
 * 42 是 3 的倍数（base64 无 padding 浪费）→ base64 后 56 字符；
 * 加前缀 `=?UTF-8?B?`(10) 与后缀 `?=`(2) 共 68 字符，符合 RFC 2047 的 75 字符上限，
 * 且 `Subject: ` + 68 = 77 ≤ 78，可整行不折。
 */
const ENCODED_WORD_MAX_BYTES = 42;
/** base64 正文每行宽度（MIME 要求 ≤ 76） */
const BASE64_LINE_WIDTH = 76;
/** SMTP 响应缓冲区上限，防御性保护（正常响应远小于此） */
const MAX_RESPONSE_BUFFER = 1 << 20;
/** 已知的 SASL 认证机制名（用于区分 EHLO 里的机制名与 `AUTH LOGIN <base64>` 的初始挑战） */
const KNOWN_SASL_MECHANISMS = new Set([
  'PLAIN',
  'LOGIN',
  'CRAM-MD5',
  'CRAM-SHA1',
  'CRAM-SHA256',
  'DIGEST-MD5',
  'SCRAM-SHA-1',
  'SCRAM-SHA-256',
  'NTLM',
  'GSSAPI',
  'GSS-SPNEGO',
  'XOAUTH2',
  'OAUTHBEARER',
  'EXTERNAL',
  'ANONYMOUS',
  'MD5',
  'SKEY',
  'OTP',
  'SECURID',
]);

/**
 * 判断 EHLO 能力里的 token 是否为服务器预先给出的 base64 挑战（如 `VXNlcm5hbWU6` → `Username:`）。
 * 只有解码后是可打印 ASCII 且以冒号结尾时才认定为挑战，避免把机制名误判成挑战。
 * @param {string} token EHLO 里 AUTH 后面的 token
 * @returns {boolean} 是否是挑战
 */
function isBase64Prompt(token) {
  if (typeof token !== 'string' || token.length < 4 || token.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return false;
  const text = Buffer.from(token, 'base64').toString('utf8');
  return /^[\x20-\x7E]+$/.test(text) && /[:：]\s*$/.test(text);
}

/* =====================================================================
 * 一、纯函数：编码 / 地址 / MIME
 * ===================================================================== */

/**
 * 判断字符串是否只由可打印 ASCII 组成（不含 CR/LF，因此天然防头部注入）。
 * @param {string} str
 * @returns {boolean}
 */
function isPrintableAscii(str) {
  return /^[\x20-\x7E]*$/.test(str);
}

/**
 * 把字符串按 UTF-8 字节数切片，且保证不切碎任何字符（含 emoji 等代理对）。
 * @param {string} str 原始字符串
 * @param {number} maxBytes 每片最大字节数
 * @returns {string[]} 切片数组
 */
function splitByUtf8Bytes(str, maxBytes) {
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of str) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (currentBytes > 0 && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += size;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * 纯函数：把头部值编码成 RFC 2047 的 encoded-word。
 * - 纯 ASCII 且不长的值原样返回（例如 `DDL 提醒`）；
 * - 含中文/非 ASCII 或过长的值编码为 `=?UTF-8?B?<base64>?=`；
 * - 超长值会切成多个 encoded-word，用空格分隔（RFC 2047 规定相邻 encoded-word 之间的空白在解码时被忽略，
 *   因此折叠到下一行也不会破坏内容），单个 encoded-word 不超过 75 字符。
 * @param {string} value 原始头部值（如邮件主题）
 * @returns {string} 可直接放入头部的值
 */
export function encodeHeaderValue(value) {
  const str = value === undefined || value === null ? '' : String(value);
  if (str === '') return '';
  // 纯 ASCII 且不长：无需编码（含 CR/LF 的值不是 printable ASCII，会被下面的编码分支吞掉，避免头部注入）
  if (isPrintableAscii(str) && str.length <= HEADER_LINE_LIMIT) return str;
  const chunks = splitByUtf8Bytes(str, ENCODED_WORD_MAX_BYTES);
  if (chunks.length === 0) return '';
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join(' ');
}

/**
 * 纯函数：MIME 编码的换行归一 + 点开头转义（dot-stuffing）。
 * - 把 `\r\n` / `\n` / `\r` 统一成 `\r\n`；
 * - 行首为 `.` 的行前面再加一个 `.`（RFC 5321 4.5.2）。
 * 注意：函数只负责转义，DATA 结束符 `\r\n.\r\n` 由发送逻辑追加。
 * @param {string} body 原始正文（或整封报文）
 * @returns {string} 处理后的正文
 */
export function dotStuff(body) {
  const str = body === undefined || body === null ? '' : String(body);
  const normalized = str.replace(/\r\n|\r|\n/g, CRLF);
  if (normalized === '') return '';
  return normalized
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

/**
 * 解析邮箱地址：支持 `名字 <a@b.com>`、`"名字" <a@b.com>`、`a@b.com`。
 * @param {string} input 地址原文
 * @returns {{ name: string, address: string }} 显示名（可能为空）+ 纯地址
 */
function parseAddress(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (raw === '') throw new Error('[SMTP] 邮箱地址为空');
  let name = '';
  let address = raw;
  const matched = raw.match(/^(.*?)<\s*([^<>]+)\s*>\s*$/);
  if (matched) {
    name = matched[1].trim();
    address = matched[2].trim();
  }
  // 去掉显示名两侧的引号（`"学习 守护" <a@b.com>`）
  if (/^".*"$/.test(name)) name = name.slice(1, -1);
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) {
    throw new Error(`[SMTP] 邮箱地址格式不正确：「${raw}」，应形如 a@b.com 或 名字 <a@b.com>`);
  }
  if (/[\r\n]/.test(name) || /[\r\n]/.test(address)) {
    throw new Error('[SMTP] 邮箱地址中不允许包含换行符');
  }
  return { name, address };
}

/**
 * 把地址格式化成头部可用形式：非 ASCII 显示名走 encoded-word，含特殊字符的 ASCII 显示名加引号。
 * @param {string} input 地址原文
 * @returns {string} 头部中的地址串
 */
function formatAddressHeader(input) {
  const { name, address } = parseAddress(input);
  if (name === '') return address;
  if (isPrintableAscii(name) && name.length <= HEADER_LINE_LIMIT) {
    // 含 RFC 5322 特殊字符的纯 ASCII 显示名需要加引号
    if (/[()<>@,;:\\".[\]]/.test(name)) return `"${name.replace(/([\\"])/g, '\\$1')}" <${address}>`;
    return `${name} <${address}>`;
  }
  return `${encodeHeaderValue(name)} <${address}>`;
}

/**
 * 按 78 字符把头部折行：续行以空格开头，且绝不把单词（尤其是 encoded-word）拆开。
 * @param {string} name 头部名（如 `Subject`）
 * @param {string} value 头部值（已编码）
 * @param {number} [limit] 行长度上限
 * @returns {string} 可能含 CRLF 的头部块
 */
function foldHeader(name, value, limit = HEADER_LINE_LIMIT) {
  const prefix = `${name}: `;
  const words = String(value).split(/[ \t]+/).filter((w) => w !== '');
  if (words.length === 0) return prefix.trimEnd();

  const lines = [];
  let current = prefix;
  let currentLength = prefix.length;
  for (const word of words) {
    const extra = (currentLength === prefix.length ? 0 : 1) + word.length;
    if (currentLength + extra > limit && currentLength > prefix.length) {
      lines.push(current);
      current = ` ${word}`; // 续行以空格开头
      currentLength = 1 + word.length;
    } else {
      current += (currentLength === prefix.length ? '' : ' ') + word;
      currentLength += extra;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

/**
 * base64 文本按指定宽度（默认 76 字符）折行，行间用 CRLF。
 * @param {string} base64 已编码的 base64 文本
 * @param {number} [width] 每行宽度
 * @returns {string} 折行后的文本
 */
function wrapBase64(base64, width = BASE64_LINE_WIDTH) {
  if (base64 === '') return '';
  const lines = [];
  for (let i = 0; i < base64.length; i += width) lines.push(base64.slice(i, i + width));
  return lines.join(CRLF);
}

/**
 * 把 UTF-8 文本编码成折行后的 base64。
 * @param {string} text 原文
 * @returns {string} base64 文本
 */
function encodeBase64(text) {
  return wrapBase64(Buffer.from(String(text), 'utf8').toString('base64'));
}

/**
 * 把单个内容段包装成 MIME part。
 * @param {object} part 段信息
 * @param {string} part.contentType 内容类型（如 text/plain）
 * @param {string} part.content 原文内容
 * @returns {string} part 文本（不含结尾 CRLF，由调用方拼接）
 */
function buildPart({ contentType, content }) {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64(content),
  ].join(CRLF);
}

/** 把入参规范成数组（过滤空值） */
function toArray(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
}

/**
 * 纯函数：构造一封完整的 MIME 报文（不涉及网络，便于单测）。
 *
 * 规则：
 * - 头部包含 Date（toUTCString）、From、To、Cc（可选）、Reply-To（可选）、Subject、Message-ID、MIME-Version；
 * - 同时有 text 与 html → `multipart/alternative`，boundary 随机，**先 text/plain 再 text/html**（RFC 从简到繁）；
 * - 只有 text 或只有 html → 单段，不套 multipart；
 * - 正文一律 base64，每行 76 字符；中文主题用 encoded-word；超长头部折行且不拆开 encoded-word。
 *
 * @param {object} options 参数
 * @param {string} options.from 发件人（`名字 <a@b.com>` 或 `a@b.com`）
 * @param {string|string[]} options.to 收件人
 * @param {string|string[]} [options.cc] 抄送
 * @param {string} [options.subject] 主题
 * @param {string} [options.text] 纯文本正文
 * @param {string} [options.html] HTML 正文
 * @param {string} [options.replyTo] 回复地址
 * @param {Date} [options.date] 自定义时间（测试用）
 * @param {string} [options.messageId] 自定义 Message-ID（测试用）
 * @returns {{ headers: string, body: string, message: string, messageId: string, contentType: string, boundary: string|null, from: string, to: string[], cc: string[] }}
 *          headers 为头部块（不含结尾空行），body 为 MIME 正文，message 为 `头部 + 空行 + 正文` 的完整报文
 */
export function buildMimeMessage(options = {}) {
  if (!options || typeof options !== 'object') throw new Error('[SMTP] buildMimeMessage 需要 options 对象');
  const { from, to, cc, subject = '', text, html, replyTo } = options;
  if (!from) throw new Error('[SMTP] buildMimeMessage 缺少 from（发件人）');

  const fromParsed = parseAddress(from);
  const toList = toArray(to).map((v) => formatAddressHeader(v));
  const ccList = toArray(cc).map((v) => formatAddressHeader(v));
  if (toList.length === 0 && ccList.length === 0) {
    throw new Error('[SMTP] buildMimeMessage 至少需要一个收件人（to 或 cc）');
  }

  const date = options.date instanceof Date ? options.date : new Date();
  const domain = fromParsed.address.includes('@') ? fromParsed.address.split('@').pop() : 'localhost';
  // Message-ID：RFC 5322 要求全局唯一且形如 <local@domain>
  const messageId = options.messageId || `<${crypto.randomUUID()}@${domain}>`;

  const hasText = typeof text === 'string';
  const hasHtml = typeof html === 'string';
  const boundary = hasText && hasHtml ? `=_dsh_${crypto.randomBytes(12).toString('hex')}` : null;

  const headerLines = [];
  headerLines.push(foldHeader('Date', date.toUTCString())); // RFC 5322 日期，toUTCString 形如 Fri, 23 Aug 2024 12:34:56 GMT
  headerLines.push(foldHeader('From', formatAddressHeader(from)));
  if (toList.length > 0) headerLines.push(foldHeader('To', toList.join(', ')));
  if (ccList.length > 0) headerLines.push(foldHeader('Cc', ccList.join(', ')));
  if (replyTo) headerLines.push(foldHeader('Reply-To', formatAddressHeader(replyTo)));
  headerLines.push(foldHeader('Subject', encodeHeaderValue(String(subject))));
  headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push('MIME-Version: 1.0');

  let body;
  let contentType;
  if (boundary) {
    // 同时有纯文本与 HTML：multipart/alternative，先 text/plain 后 text/html
    contentType = `multipart/alternative; boundary="${boundary}"`;
    const parts = [
      buildPart({ contentType: 'text/plain', content: text }),
      buildPart({ contentType: 'text/html', content: html }),
    ];
    body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--`;
    headerLines.push(`Content-Type: ${contentType}`);
  } else {
    contentType = hasHtml ? 'text/html' : 'text/plain';
    body = buildPart({ contentType, content: hasHtml ? html : hasText ? text : '' });
    headerLines.push(`Content-Type: ${contentType}; charset=UTF-8`);
    headerLines.push(`Content-Transfer-Encoding: base64`);
  }

  const headers = headerLines.join(CRLF);
  return {
    headers,
    body,
    message: `${headers}${CRLF}${CRLF}${body}`,
    messageId,
    contentType,
    boundary,
    from: fromParsed.address,
    to: toList,
    cc: ccList,
  };
}

/* =====================================================================
 * 二、连接与协议实现
 * ===================================================================== */

/**
 * 生成 EHLO 用的客户端名称：EHLO 参数必须是域名或地址字面量，
 * 这里把主机名里的非 ASCII 字符（如中文用户名的主机名）替换成 `-`，退化为 localhost。
 * @returns {string} 客户端名称
 */
function clientName() {
  let name = '';
  try {
    name = os.hostname() || '';
  } catch {
    name = '';
  }
  name = name.replace(/[^A-Za-z0-9.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (name === '' || !/[A-Za-z0-9]/.test(name)) return 'localhost';
  return name;
}

/**
 * 规范化并校验 sendMail / verifyConnection 的入参。
 * @param {object} options 原始参数
 * @returns {{host:string,port:number,secure:boolean,user:string,pass:string,timeoutMs:number,tls:{rejectUnauthorized:boolean}}} 规范化结果
 */
function normalizeOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('[SMTP] 参数必须是一个对象');
  const host = String(options.host === undefined || options.host === null ? '' : options.host).trim();
  if (host === '') throw new Error('[SMTP] 缺少 host（SMTP 服务器地址），例如 smtp.qq.com');

  const portGiven = options.port === undefined || options.port === null ? null : Number(options.port);
  if (portGiven !== null && (!Number.isInteger(portGiven) || portGiven <= 0 || portGiven > 65535)) {
    throw new Error(`[SMTP] port 不合法：${options.port}`);
  }
  // 省略 secure 时按端口猜：465 -> 隐式 TLS，其它 -> 明文（视情况 STARTTLS）
  const secure = options.secure === undefined ? portGiven === 465 : Boolean(options.secure);
  const port = portGiven === null ? (secure ? 465 : 587) : portGiven;

  const timeoutGiven = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutGiven) && timeoutGiven > 0 ? timeoutGiven : DEFAULT_TIMEOUT_MS;

  const tlsOptions = options.tls && typeof options.tls === 'object' ? options.tls : {};
  return {
    host,
    port,
    secure,
    user: options.user === undefined || options.user === null ? '' : String(options.user),
    pass: options.pass === undefined || options.pass === null ? '' : String(options.pass),
    timeoutMs,
    tls: { rejectUnauthorized: tlsOptions.rejectUnauthorized !== false },
  };
}

/**
 * 把底层网络/TLS 错误翻译成中文说明，并保留原始错误信息。
 * @param {Error & {code?: string}} err 原始错误
 * @param {string} host 主机
 * @param {number} port 端口
 * @param {string} phase 阶段说明
 * @returns {Error} 中文错误
 */
function networkError(err, host, port, phase) {
  const code = err && err.code ? `（${err.code}）` : '';
  let hint = '';
  switch (err && err.code) {
    case 'ECONNREFUSED':
      hint = `\n提示：${host}:${port} 拒绝连接。请检查端口是否正确，或该邮箱/网络是否开放此端口（部分邮箱不开放 25 端口）。`;
      break;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      hint = `\n提示：连接超时。常见原因是防火墙、运营商封禁端口（家用宽带常封 25），或用错了端口（465 用隐式 TLS，587 用 STARTTLS）。`;
      break;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      hint = `\n提示：无法解析主机名「${host}」，请检查拼写与网络（DNS）。`;
      break;
    case 'ECONNRESET':
      hint = '\n提示：连接被重置。若端口是 587/25 且传了 secure: true，请改为隐式 TLS 端口 465 或让 secure 保持 false。';
      break;
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'EPROTO':
      hint = '\n提示：TLS 握手失败，通常是端口与 secure 设置不匹配。465 需要 secure: true，587/25 需要 secure: false（走 STARTTLS）。';
      break;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      hint = '\n提示：服务器证书校验失败（不是受信任的 CA 签发的证书）。自建/内网邮件服务器可传 tls: { rejectUnauthorized: false } 关闭校验。';
      break;
    default:
      break;
  }
  return new Error(`[SMTP] ${phase}失败（${host}:${port}）${code}：${err && err.message ? err.message : String(err)}${hint}`);
}

/**
 * 判断 TLS 证书类错误（用于给出更贴切的提示）。
 * @param {Error & {code?: string}} err
 * @returns {boolean}
 */
function isCertError(err) {
  const code = err && err.code ? String(err.code) : '';
  return /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/i.test(code);
}

/**
 * SMTP 会话：负责 socket 上的「发命令 / 读完整响应」时序、超时与资源清理。
 * 一个实例 = 一次独立连接（不做连接池）。
 */
class SmtpSession {
  /**
   * @param {{host:string,port:number,secure:boolean,timeoutMs:number,tls:{rejectUnauthorized:boolean}}} env 规范化后的参数
   */
  constructor(env) {
    this.env = env;
    this.socket = null;
    this.connectingSocket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = []; // 已解析完成、等待被取走的响应
    this.waiters = []; // 正在等待响应的 { resolve, reject }
    this.currentResponse = null; // 正在收集的多行响应
    this.fatal = null; // 致命错误（连接错误 / 超时 / 意外关闭）
    this.closed = false;
    this.timer = null;
    this.currentCommand = '';
    this.greeting = '';
    this.capabilities = new Map();
    this.authMethods = [];
    this.authLoginInitial = null;
    this.supportsStartTls = false;
    this.startTlsUsed = false;
    this.ehloCount = 0;
  }

  /**
   * 建立底层连接（隐式 TLS 或明文），并启动整体超时计时器。
   * @returns {Promise<void>}
   */
  async connect() {
    const { host, port, secure, timeoutMs, tls: tlsOptions } = this.env;
    // 整体超时：到点主动 destroy socket 并让所有等待者 reject，绝不挂住进程
    const timeoutError = new Error(
      `[SMTP] 与 ${host}:${port} 通信超时（${timeoutMs}ms），已主动断开连接。` +
        `\n可能原因：网络不可达 / 防火墙或运营商封禁端口（家用宽带常封 25）/ 服务器未响应 / 端口与 secure 设置不匹配。`,
    );
    this.timer = setTimeout(() => {
      this.fail(timeoutError);
    }, timeoutMs);
    // 注意：这里刻意不调用 unref()——发送过程中必须让进程存活，完成或超时后由 close() 清理。

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      let socket;
      try {
        if (secure) {
          socket = tls.connect({
            host,
            port,
            // SNI：地址字面量不能作为 servername（RFC 6066），交给 Node 按 host 处理
            servername: net.isIP(host) === 0 ? host : undefined,
            rejectUnauthorized: tlsOptions.rejectUnauthorized,
          });
          socket.once('secureConnect', () => {
            this.attach(socket);
            done();
          });
        } else {
          socket = net.connect({ host, port });
          socket.once('connect', () => {
            this.attach(socket);
            done();
          });
        }
      } catch (err) {
        done(networkError(err, host, port, secure ? '建立 TLS 连接' : '建立 TCP 连接'));
        return;
      }
      this.connectingSocket = socket;
      socket.once('error', (err) => {
        done(networkError(err, host, port, secure ? 'TLS 握手' : '建立 TCP 连接'));
      });
    });
  }

  /**
   * 绑定（或重新绑定）socket：安装数据/错误/关闭监听，并清空缓冲区。
   * STARTTLS 升级后重新绑定时会丢弃明文阶段的残留数据，这是协议要求。
   * @param {import('node:net').Socket | import('node:tls').TLSSocket} socket 目标 socket
   * @returns {this}
   */
  attach(socket) {
    this.socket = socket;
    this.connectingSocket = null;
    this.buffer = Buffer.alloc(0); // 丢弃残留数据（升级 TLS 后这些字节已无意义）
    this.currentResponse = null;
    this._onData = (chunk) => this._append(chunk);
    this._onError = (err) => {
      this.fail(networkError(err, this.env.host, this.env.port, '传输数据'));
    };
    this._onClose = () => {
      this.closed = true;
      if (!this.fatal) {
        this.fatal = new Error(
          `[SMTP] 服务器 ${this.env.host}:${this.env.port} 在响应完成前关闭了连接` +
            (this.currentCommand ? `（最后一条命令：${this.currentCommand}）` : ''),
        );
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w.reject(this.fatal);
    };
    socket.on('data', this._onData);
    socket.on('error', this._onError);
    socket.on('close', this._onClose);
    return this;
  }

  /**
   * 解除 socket 绑定（STARTTLS 升级前置动作：升级前必须摘掉明文的 data 监听）。
   * @returns {void}
   */
  detach() {
    const socket = this.socket;
    if (socket) {
      socket.removeListener('data', this._onData);
      socket.removeListener('error', this._onError);
      socket.removeListener('close', this._onClose);
    }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.currentResponse = null;
  }

  /**
   * 标记致命错误：销毁 socket 并让所有等待者 reject。
   * @param {Error} err 致命错误
   * @returns {void}
   */
  fail(err) {
    if (!this.fatal) this.fatal = err;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
    for (const socket of [this.socket, this.connectingSocket]) {
      if (socket && !socket.destroyed) {
        try {
          socket.destroy();
        } catch {
          // 忽略销毁时的二次异常
        }
      }
    }
  }

  /**
   * 把收到的数据追加到缓冲区，并按 CRLF 逐行切分。
   * 关键点：一次 data 事件可能包含半条、一条或多条响应，必须缓冲。
   * @param {Buffer|string} chunk 收到的数据
   * @returns {void}
   */
  _append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, buf]) : buf;
    let index;
    while ((index = this.buffer.indexOf(0x0a)) !== -1) {
      const lineBuf = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      let line = lineBuf.toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._onLine(line);
    }
    if (this.buffer.length > MAX_RESPONSE_BUFFER) {
      this.fail(new Error('[SMTP] 服务器响应过长（超过 1MB），已断开连接'));
    }
  }

  /**
   * 处理一行响应，支持多行响应（`250-` 续行，最后一行以 `250 ` 结束）。
   * @param {string} line 单行响应（已去掉 CRLF）
   * @returns {void}
   */
  _onLine(line) {
    if (!this.currentResponse) this.currentResponse = { lines: [] };
    this.currentResponse.lines.push(line);
    const isContinuation = line.length >= 4 && line[3] === '-';
    if (isContinuation) return;

    const lines = this.currentResponse.lines;
    this.currentResponse = null;
    const first = lines[0] || '';
    const code = /^\d{3}/.test(first) ? Number(first.slice(0, 3)) : 0;
    const last = lines[lines.length - 1] || '';
    const response = {
      code,
      lines,
      text: last, // 最后一行原文（含状态码）
      detail: last.length >= 4 ? last.slice(4).trim() : '', // 去掉状态码后的说明
      all: lines.join('\n'),
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(response);
    else this.queue.push(response);
  }

  /**
   * 等待一条完整响应（若已有解析好的响应则立即返回）。
   * @returns {Promise<{code:number,lines:string[],text:string,detail:string,all:string}>} 响应对象
   */
  waitForResponse() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * 发送一条命令并读取响应。
   * @param {string} command 命令原文（不含 CRLF）
   * @returns {Promise<object>} 响应对象
   */
  async command(command) {
    this.currentCommand = command;
    if (!this.socket || this.socket.destroyed) {
      throw this.fatal || new Error(`[SMTP] 连接已关闭，无法发送命令：${command}`);
    }
    this.socket.write(`${command}${CRLF}`);
    return this.waitForResponse();
  }

  /**
   * 校验响应状态码，失败时抛中文错误并保留 SMTP 原文。
   * @param {object} response 响应对象
   * @param {number[]} expected 可接受的状态码
   * @param {string} action 动作描述（中文）
   * @returns {object} 原响应
   */
  expect(response, expected, action) {
    if (expected.includes(response.code)) return response;
    const detail = response.lines.join('\n');
    let hint = '';
    if (response.code === 535 || response.code === 534 || response.code === 530) {
      hint =
        '\n提示：认证未通过。QQ 邮箱 / 163 邮箱 / Gmail 等都不接受「登录密码」，必须使用邮箱设置里生成的「SMTP 授权码」（QQ 邮箱在「设置 → 账户 → POP3/SMTP服务」中开启并生成）。' +
        '\n同时请确认 user 是完整邮箱地址，且授权码没有过期。';
    } else if (response.code === 502 || response.code === 504) {
      hint = '\n提示：服务器不支持该命令。若这里失败在 STARTTLS / AUTH，请换用 465（隐式 TLS）或改用其它认证方式。';
    } else if (response.code === 554) {
      hint = '\n提示：服务器拒绝投递。常见原因是发件人地址与登录账号不一致、被判定为垃圾邮件，或该服务器要求先做反向解析。';
    }
    throw new Error(
      `[SMTP] ${action}失败：服务器（${this.env.host}:${this.env.port}）返回 ${response.code}\n原文：${detail}${hint}`,
    );
  }

  /**
   * 读取服务器问候语（220）。
   * @returns {Promise<void>}
   */
  async readGreeting() {
    this.currentCommand = '';
    const response = await this.waitForResponse();
    this.expect(response, [220], '接收服务器问候语');
    this.greeting = response.lines[0] || '';
  }

  /**
   * 解析 EHLO 能力列表：把续行拆成 `关键字 -> 参数`。
   * EHLO 的第一行是问候语，其余行才是能力项。
   * @param {object} response EHLO 响应
   * @returns {Map<string,string>} 能力表
   */
  static parseCapabilities(response) {
    const capabilities = new Map();
    for (const raw of response.lines.slice(1)) {
      const text = raw.replace(/^\d{3}[ -]?/, '').trim();
      if (text === '') continue;
      const space = text.indexOf(' ');
      let key = (space === -1 ? text : text.slice(0, space)).toUpperCase();
      let args = space === -1 ? '' : text.slice(space + 1).trim();
      // 兼容 `AUTH=PLAIN LOGIN` 这种老式写法
      if (key.startsWith('AUTH=')) {
        args = `${key.slice(5)}${args ? ` ${args}` : ''}`;
        key = 'AUTH';
      }
      if (capabilities.has(key)) {
        const prev = capabilities.get(key);
        capabilities.set(key, `${prev}${prev && args ? ' ' : ''}${args}`);
      } else {
        capabilities.set(key, args);
      }
    }
    return capabilities;
  }

  /**
   * 发送 EHLO，解析能力；EHLO 不被接受时回退 HELO。
   * @returns {Promise<void>}
   */
  async ehlo() {
    this.ehloCount += 1;
    const name = clientName();
    const response = await this.command(`EHLO ${name}`);
    if (response.code !== 250) {
      // 老服务器只认 HELO
      const helo = await this.command(`HELO ${name}`);
      this.expect(helo, [250], '发送 HELO（EHLO 回退）');
      this.capabilities = new Map();
      this.authMethods = [];
      this.authLoginInitial = null;
      this.supportsStartTls = false;
      return;
    }
    const capabilities = SmtpSession.parseCapabilities(response);
    this.capabilities = capabilities;
    // 语义：服务器「是否声明过」支持 STARTTLS。升级 TLS 后的第二次 EHLO 通常不再声明，
    // 因此这里用「或」累积，保证 verifyConnection 的结果反映升级前的能力。
    this.supportsStartTls = this.supportsStartTls || capabilities.has('STARTTLS');
    const authArgs = capabilities.get('AUTH') || '';
    const tokens = authArgs.split(/\s+/).filter(Boolean);
    this.authMethods = [];
    this.authLoginInitial = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const upper = token.toUpperCase();
      // 第一个 token 一定是机制名；后面的 token 只有在是已知机制名时才算机制，
      // 否则若形如 base64 挑战（`AUTH LOGIN VXNlcm5hbWU6`）则记为「服务器已先问用户名」。
      if (i === 0 || KNOWN_SASL_MECHANISMS.has(upper)) {
        this.authMethods.push(upper);
      } else if (this.authLoginInitial === null && isBase64Prompt(token)) {
        this.authLoginInitial = token;
      }
    }
  }

  /**
   * 明文连接上升级为 TLS（STARTTLS）。
   * 关键：升级前摘掉明文 socket 的监听并丢弃缓冲区，升级成功后由调用方重新 EHLO。
   * @returns {Promise<void>}
   */
  async upgrade() {
    const { host, tls: tlsOptions } = this.env;
    const plainSocket = this.socket;
    if (!plainSocket) throw new Error('[SMTP] STARTTLS 升级失败：当前没有可用连接');
    this.detach(); // 丢弃明文阶段残留数据（这些字节在 TLS 握手后已无意义）
    const secured = await new Promise((resolve, reject) => {
      let settled = false;
      const socket = tls.connect({
        socket: plainSocket,
        servername: net.isIP(host) === 0 ? host : undefined,
        rejectUnauthorized: tlsOptions.rejectUnauthorized,
      });
      socket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        resolve(socket);
      });
      socket.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(
          isCertError(err)
            ? networkError(err, host, this.env.port, 'STARTTLS 升级后的 TLS 握手')
            : new Error(`[SMTP] STARTTLS 升级失败（${host}:${this.env.port}）：${err.message}`),
        );
      });
    });
    this.attach(secured);
    this.startTlsUsed = true;
  }

  /**
   * 连接建立流程：问候语 → EHLO →（可选）STARTTLS → 重新 EHLO。
   * @returns {Promise<void>}
   */
  async handshake() {
    await this.readGreeting();
    await this.ehlo();
    if (!this.env.secure && this.supportsStartTls) {
      const response = await this.command('STARTTLS');
      this.expect(response, [220], '发送 STARTTLS');
      await this.upgrade();
      // 协议要求：TLS 升级后必须重新 EHLO，能力列表也以新的为准
      await this.ehlo();
    }
  }

  /**
   * 认证：优先 AUTH PLAIN，其次 AUTH LOGIN。
   * @returns {Promise<void>}
   */
  async authenticate() {
    const { user, pass } = this.env;
    if (!user) return;
    const methods = this.authMethods;
    if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
      // 未声明任何机制时也尝试 PLAIN，让服务器给出明确的错误而不是本地直接放弃
      await this.authPlain(user, pass);
      return;
    }
    await this.authLogin(user, pass);
  }

  /**
   * AUTH PLAIN（单行初始响应；若服务器要求两步则补发一次）。
   * @param {string} user 账号
   * @param {string} pass 授权码
   * @returns {Promise<void>}
   */
  async authPlain(user, pass) {
    const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
    let response = await this.command(`AUTH PLAIN ${token}`);
    if (response.code === 334) {
      // 部分服务器只接受两步式：先 AUTH PLAIN，再单独发凭据
      response = await this.command(token);
    }
    this.expect(response, [235, 250], 'AUTH PLAIN 认证');
  }

  /**
   * AUTH LOGIN：base64 用户名 + base64 密码两步。
   * 兼容两种形态：
   *  - EHLO 只声明 `AUTH LOGIN`：先发 `AUTH LOGIN`，再按 334 挑战应答（最常见）；
   *  - EHLO 里已给出初始挑战（如 `AUTH LOGIN VXNlcm5hbWU6`，即 "Username:"）：服务器已经问过用户名，
   *    客户端直接回 base64 用户名，不再重复发送 `AUTH LOGIN`；
   *  - 服务器先要密码（挑战文本含 pass/密码）：直接回 base64 密码。
   * @param {string} user 账号
   * @param {string} pass 授权码
   * @returns {Promise<void>}
   */
  async authLogin(user, pass) {
    const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');
    const decode = (token) => {
      if (!token) return '';
      const text = Buffer.from(token, 'base64').toString('utf8');
      return /^[\x20-\x7E]*$/.test(text) ? text : '';
    };

    let sentUser = false;
    let response;
    if (this.authLoginInitial && isBase64Prompt(this.authLoginInitial)) {
      // 服务器在 EHLO 里已经给出用户名挑战，直接回应凭据
      response = await this.command(b64(user));
      sentUser = true;
    } else {
      response = await this.command('AUTH LOGIN');
    }

    let guard = 0;
    while (response.code === 334 && guard < 3) {
      guard += 1;
      const prompt = decode(response.text.length > 4 ? response.text.slice(4).trim() : '');
      if (/pass|密码/i.test(prompt) || sentUser) {
        response = await this.command(b64(pass));
        sentUser = true;
      } else {
        response = await this.command(b64(user));
        sentUser = true;
      }
    }
    this.expect(response, [235, 250], 'AUTH LOGIN 认证');
  }

  /**
   * 发送信封并投递正文（MAIL FROM / RCPT TO / DATA / 正文 / `.`）。
   * @param {{from:string, to:string[], message:string, messageId:string}} params 发送参数
   * @returns {Promise<{messageId:string, accepted:string[], response:string}>} 投递结果
   */
  async deliver({ from, to, message, messageId }) {
    const sender = parseAddress(from);
    this.expect(await this.command(`MAIL FROM:<${sender.address}>`), [250], '发送 MAIL FROM（发件人）');

    const accepted = [];
    let lastError = null;
    for (const recipient of to) {
      const parsed = parseAddress(recipient);
      const response = await this.command(`RCPT TO:<${parsed.address}>`);
      if (response.code >= 200 && response.code < 300) accepted.push(parsed.address);
      else lastError = response;
    }
    if (accepted.length === 0) {
      if (lastError) this.expect(lastError, [250], '发送 RCPT TO（收件人）');
      throw new Error('[SMTP] 没有可用的收件人地址');
    }

    this.expect(await this.command('DATA'), [354], '发送 DATA');
    // 正文转义 + 归一换行，最后补 `\r\n.\r\n` 结束邮件数据
    let payload = dotStuff(message);
    if (!payload.endsWith(CRLF)) payload += CRLF;
    payload += `.${CRLF}`;
    this.socket.write(payload);
    const stored = this.expect(await this.waitForResponse(), [250], '提交邮件正文');

    return { messageId, accepted, response: stored.lines.join(' ').trim() };
  }

  /**
   * 发送 QUIT 并关闭连接（服务器可能直接断开，这里忽略异常）。
   * @returns {Promise<void>}
   */
  async quit() {
    try {
      await this.command('QUIT');
    } catch {
      // QUIT 的响应无关紧要，服务器常常直接关连接
    }
  }

  /**
   * 释放资源：清超时、摘监听、销毁 socket。任何路径（成功/失败）都必须走到这里。
   * @returns {void}
   */
  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sockets = [this.socket, this.connectingSocket];
    this.detach();
    for (const socket of sockets) {
      if (socket && !socket.destroyed) {
        try {
          socket.destroy();
        } catch {
          // 忽略销毁异常
        }
      }
    }
    this.connectingSocket = null;
  }
}

/**
 * 建立连接 → 握手（含 STARTTLS）→ 执行回调 → 无论成败都清理 socket。
 * @param {object} env normalizeOptions 的结果
 * @param {(session: SmtpSession, env: object) => Promise<any>} handler 业务回调
 * @returns {Promise<any>} 回调结果
 */
async function withConnection(env, handler) {
  const session = new SmtpSession(env);
  try {
    await session.connect();
    await session.handshake();
    return await handler(session, env);
  } finally {
    session.close(); // 资源清理：完成或超时后一定关闭
  }
}

/* =====================================================================
 * 三、对外导出
 * ===================================================================== */

/**
 * 发送一封邮件。成功 resolve 投递结果，失败 reject 一个带中文说明的 Error，
 * 错误信息里保留 SMTP 服务器返回的原文，便于排查。
 *
 * 每次调用都会建立一条独立连接（不做连接池），完成或超时后主动关闭。
 *
 * @param {object} options 参数
 * @param {string} options.host SMTP 服务器地址，如 smtp.qq.com
 * @param {number} [options.port] 端口：465（隐式 TLS）/ 587（STARTTLS）/ 25
 * @param {boolean} [options.secure] true=一连接就 TLS(465)；false=先明文再 STARTTLS(587/25)。省略时按 port 猜：465→true，其它→false
 * @param {string} [options.user] 登录账号（一般是完整邮箱地址）
 * @param {string} [options.pass] 授权码（国内邮箱必须用授权码，不是登录密码）
 * @param {string} options.from 发件人，支持 `学习守护 <a@b.com>` 或 `a@b.com`
 * @param {string|string[]} options.to 收件人，支持 `名字 <a@b.com>` 或 `a@b.com`
 * @param {string|string[]} [options.cc] 抄送
 * @param {string} options.subject 主题（中文会自动 encoded-word 编码）
 * @param {string} [options.text] 纯文本正文
 * @param {string} [options.html] HTML 正文
 * @param {string} [options.replyTo] 回复地址
 * @param {number} [options.timeoutMs] 整体超时，默认 20000ms
 * @param {{rejectUnauthorized?: boolean}} [options.tls] TLS 选项，默认 rejectUnauthorized: true
 * @param {string} [options.rawMessage] 高级/测试用法：跳过 MIME 构造，直接发送这段原始报文
 * @returns {Promise<{messageId: string, accepted: string[], response: string}>} messageId 为生成的 Message-ID，
 *          accepted 为服务器接受的收件人（纯地址），response 为服务器对正文的最终响应原文
 */
export async function sendMail(options) {
  const env = normalizeOptions(options);
  if (!options.from) throw new Error('[SMTP] 缺少 from（发件人）');
  const toList = [...toArray(options.to), ...toArray(options.cc)];
  if (toList.length === 0) throw new Error('[SMTP] 至少需要一个收件人（to 或 cc）');

  return await withConnection(env, async (session) => {
    if (env.user) await session.authenticate();

    let message;
    let messageId;
    if (typeof options.rawMessage === 'string') {
      message = options.rawMessage;
      messageId = `<${crypto.randomUUID()}@${String(options.from).split('@').pop() || 'localhost'}>`;
      const found = message.match(/^Message-ID:\s*(.+)$/im);
      if (found) messageId = found[1].trim();
    } else {
      const built = buildMimeMessage({
        from: options.from,
        to: options.to,
        cc: options.cc,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
      });
      message = built.message;
      messageId = built.messageId;
    }

    const result = await session.deliver({ from: options.from, to: toList, message, messageId });
    await session.quit();
    return result;
  });
}

/**
 * 只做连接、握手与登录验证，用于「设置页 · 测试连接」按钮。
 * 会完整走一遍：连接 → 问候语 → EHLO →（若服务器支持且未用隐式 TLS）STARTTLS → 重新 EHLO → AUTH。
 *
 * @param {object} options 与 sendMail 相同的连接参数（host / port / secure / user / pass / timeoutMs / tls）
 * @returns {Promise<{ok: true, greeting: string, supportsStartTls: boolean, authMethods: string[]}>}
 *          greeting 为服务器问候语原文；supportsStartTls 表示服务器是否声明支持 STARTTLS；
 *          authMethods 为 EHLO 中声明的认证机制列表
 */
export async function verifyConnection(options) {
  const env = normalizeOptions(options);
  return await withConnection(env, async (session) => {
    if (env.user) await session.authenticate();
    await session.quit();
    return {
      ok: true,
      greeting: session.greeting,
      supportsStartTls: session.supportsStartTls,
      authMethods: [...session.authMethods],
    };
  });
}
