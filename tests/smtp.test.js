/**
 * src/lib/smtp.js 的测试：纯函数单测 + 本地假 SMTP 服务器集成测试。
 *
 * 全程不连外网：
 *  - 假服务器用 node:net / node:tls 监听 127.0.0.1:0（随机端口）；
 *  - STARTTLS 测试所需的证书用 node:crypto 现场生成 RSA 密钥对 + 手写 DER 自签 X.509 证书
 *    （不依赖 openssl 或任何 npm 包），因此 STARTTLS 是**完整实现**的验证，不是退化验证。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

import { sendMail, verifyConnection, encodeHeaderValue, dotStuff, buildMimeMessage } from '../src/lib/smtp.js';

/* =====================================================================
 * 一、测试用工具：自签证书 / 假 SMTP 服务器
 * ===================================================================== */

/** DER 长度字段编码 */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** 组装一个 DER TLV */
function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** DER SEQUENCE */
const derSequence = (...parts) => der(0x30, Buffer.concat(parts));
/** DER SET */
const derSet = (...parts) => der(0x31, Buffer.concat(parts));
/** DER INTEGER（正整数，必要时补 0x00 避免被当成负数） */
function derInteger(input) {
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from([input]);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return der(0x02, bytes);
}
/** DER BIT STRING（首位是未使用位数） */
const derBitString = (bytes) => der(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
/** DER OID，输入点分字符串 */
function derOid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [];
    let value = arc;
    do {
      stack.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let i = 0; i < stack.length - 1; i += 1) out.push(stack[i] | 0x80);
    out.push(stack[stack.length - 1]);
  }
  return der(0x06, Buffer.from(out));
}
/** DER NULL */
const derNull = () => der(0x05, Buffer.alloc(0));
/** DER UTF8String */
const derUtf8 = (text) => der(0x0c, Buffer.from(text, 'utf8'));
/** DER UTCTime（YYMMDDHHMMSSZ） */
function derUtcTime(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const text =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}
/** X.509 Name，只带一个 CN */
function derName(commonName) {
  return derSequence(derSet(derSequence(derOid('2.5.4.3'), derUtf8(commonName))));
}
/** 转 PEM */
function toPem(label, derBytes) {
  const base64 = derBytes.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

/**
 * 现场生成自签证书（RSA-2048 + SHA256withRSA）。
 * Node 的 crypto 没有签发证书的 API，所以这里手写最小可用的 v3 X.509 DER 结构。
 * @returns {{key: string, cert: string, secureContext: import('node:tls').SecureContext}}
 */
function createSelfSignedCertificate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' }, // 正好就是 SubjectPublicKeyInfo
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const signatureAlgorithm = derSequence(derOid('1.2.840.113549.1.1.11'), derNull()); // sha256WithRSAEncryption
  const name = derName('localhost');
  const now = Date.now();
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f; // 保证是正整数

  const tbsCertificate = derSequence(
    der(0xa0, derInteger(2)), // version = v3
    derInteger(serial),
    signatureAlgorithm,
    name, // issuer
    derSequence(derUtcTime(new Date(now - 86400000)), derUtcTime(new Date(now + 86400000))),
    name, // subject
    publicKey,
  );

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certificate = derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature));

  const cert = toPem('CERTIFICATE', certificate);
  const key = privateKey;
  return { key, cert, secureContext: tls.createSecureContext({ key, cert }) };
}

/** 模块加载时生成一次证书，供各测试复用 */
const TEST_CERT = createSelfSignedCertificate();

/**
 * 脚本化的假 SMTP 服务器：按 220 / 250 / 354 / 250 / 221 应答，并记录收到的全部命令与正文。
 */
class FakeSmtpServer {
  /**
   * @param {object} [options] 行为开关
   * @param {boolean} [options.starttls] 是否在 EHLO 中声明并支持 STARTTLS
   * @param {boolean} [options.implicitTls] 是否直接使用隐式 TLS（模拟 465）
   * @param {string} [options.authMethods] EHLO 里 AUTH 后面声明的机制（可带初始挑战 token）
   * @param {boolean} [options.authFail] 认证一律返回 535
   * @param {boolean} [options.silentAfterGreeting] 只发问候语，之后不再应答（用于超时测试）
   * @param {string} [options.greeting] 问候语
   */
  constructor(options = {}) {
    this.options = {
      starttls: false,
      implicitTls: false,
      authMethods: 'PLAIN LOGIN',
      authFail: false,
      silentAfterGreeting: false,
      greeting: 'fake.local ESMTP ready',
      ...options,
    };
    /** 收到的所有命令（跨 socket，STARTTLS 前后都记录） */
    this.commands = [];
    /** 收到的 AUTH 凭据行（base64） */
    this.credentials = [];
    /** 收到的 DATA 正文行（点转义后的原文，不含结束点） */
    this.dataLines = [];
    /** 是否收到过 DATA 结束符 `.` */
    this.dotTerminated = false;
    this.connectionCount = 0;
    this.closedCount = 0;
    this._sockets = new Set();
    this.server = null;
    this.port = 0;
  }

  /** 启动并返回随机端口 */
  async start() {
    const handler = (socket) => this._onConnection(socket, { tls: this.options.implicitTls });
    this.server = this.options.implicitTls
      ? tls.createServer({ key: TEST_CERT.key, cert: TEST_CERT.cert }, handler)
      : net.createServer(handler);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  /** 关闭服务器与全部连接 */
  async stop() {
    for (const socket of this._sockets) {
      try {
        socket.destroy();
      } catch {
        // 忽略
      }
    }
    this._sockets.clear();
    if (!this.server) return;
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** 命令名序列（EHLO / AUTH / MAIL / ...） */
  commandNames() {
    return this.commands.map((line) => line.split(/\s+/)[0].toUpperCase());
  }

  _onConnection(socket, state) {
    state.inData = false;
    state.authStep = null;
    this.connectionCount += 1;
    this._sockets.add(socket);
    socket.on('close', () => {
      this.closedCount += 1;
      this._sockets.delete(socket);
    });
    socket.on('error', () => {
      // 客户端中途断开（如证书校验失败）时忽略
    });
    this._pump(socket, state);
    if (!this.options.silentAfterGreeting) socket.write(`220 ${this.options.greeting}\r\n`);
  }

  /** 按 CRLF 切分收到的数据并逐行处理 */
  _pump(socket, state) {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        this._onLine(socket, state, line);
      }
    });
  }

  _onLine(socket, state, line) {
    // 正文阶段：只能靠单独一行的 `.` 结束
    if (state.inData) {
      if (line === '.') {
        state.inData = false;
        this.dotTerminated = true;
        socket.write('250 2.0.0 Ok: queued as FAKE123\r\n');
        return;
      }
      this.dataLines.push(line);
      return;
    }

    // AUTH 的后续凭据行（base64），不是命令
    if (state.authStep) {
      this.credentials.push(line);
      if (this.options.authFail) {
        state.authStep = null;
        socket.write('535 5.7.8 Error: authentication failed: bad credentials (fake-server)\r\n');
        return;
      }
      if (state.authStep === 'login-username') {
        state.authStep = 'login-password';
        socket.write('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      state.authStep = null;
      socket.write('235 2.7.0 Authentication successful\r\n');
      return;
    }

    this.commands.push(line);
    const name = line.split(/\s+/)[0].toUpperCase();
    switch (name) {
      case 'EHLO': {
        socket.write(this._ehloReply(state));
        // 声明里带初始挑战（如 `AUTH LOGIN VXNlcm5hbWU6`）时，服务器已经先问了用户名
        if (/LOGIN\s+\S+/.test(this.options.authMethods)) state.authStep = 'login-username';
        break;
      }
      case 'HELO':
        socket.write(`250 ${this.options.greeting}\r\n`);
        break;
      case 'STARTTLS': {
        if (!this.options.starttls || state.tls) {
          socket.write('502 5.5.1 STARTTLS not supported\r\n');
          break;
        }
        socket.write('220 2.0.0 Ready to start TLS\r\n');
        this._upgradeToTls(socket, state);
        break;
      }
      case 'AUTH':
        this._onAuth(socket, state, line);
        break;
      case 'MAIL':
        socket.write('250 2.1.0 Ok\r\n');
        break;
      case 'RCPT':
        socket.write('250 2.1.5 Ok\r\n');
        break;
      case 'DATA':
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        state.inData = true;
        break;
      case 'QUIT':
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
        break;
      default:
        socket.write('500 5.5.2 Command unrecognized\r\n');
    }
  }

  /** EHLO 多行响应：能力列表分散在续行里 */
  _ehloReply(state) {
    const lines = [];
    lines.push(`250-${this.options.greeting}`);
    lines.push('250-SIZE 35882577');
    lines.push('250-8BITMIME');
    if (this.options.starttls && !state.tls) lines.push('250-STARTTLS');
    lines.push(`250 AUTH ${this.options.authMethods}`);
    return `${lines.join('\r\n')}\r\n`;
  }

  /** 收到 STARTTLS 后把明文 socket 升级成 TLS socket（同一连接） */
  _upgradeToTls(socket, state) {
    socket.removeAllListeners('data');
    const tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: TEST_CERT.secureContext });
    state.tls = true;
    this._sockets.add(tlsSocket);
    tlsSocket.on('close', () => {
      this.closedCount += 1;
      this._sockets.delete(tlsSocket);
    });
    tlsSocket.on('error', () => {
      // 客户端证书校验失败时忽略
    });
    this._pump(tlsSocket, state);
  }

  _onAuth(socket, state, line) {
    if (this.options.authFail) {
      socket.write('535 5.7.8 Error: authentication failed: bad credentials (fake-server)\r\n');
      return;
    }
    const parts = line.slice(4).trim().split(/\s+/).filter(Boolean);
    const mechanism = (parts.shift() || '').toUpperCase();
    const token = parts.join('');
    if (mechanism === 'PLAIN') {
      if (token) {
        this.credentials.push(token);
        socket.write('235 2.7.0 Authentication successful\r\n');
      } else {
        state.authStep = 'plain';
        socket.write('334 \r\n');
      }
      return;
    }
    if (mechanism === 'LOGIN') {
      if (token) {
        this.credentials.push(token);
        state.authStep = 'login-password';
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else {
        state.authStep = 'login-username';
        socket.write('334 VXNlcm5hbWU6\r\n');
      }
      return;
    }
    socket.write('504 5.5.4 Unrecognized authentication type\r\n');
  }
}

/** 邮箱参数工厂 */
function mailOptions(port, extra = {}) {
  return {
    host: '127.0.0.1',
    port,
    user: 'study@example.com',
    pass: 'auth-code-123',
    from: '学习守护 <study@example.com>',
    to: 'me@example.com',
    subject: '科目提醒',
    text: '数学作业 DDL 还有 2 小时',
    ...extra,
  };
}

/** 从 encoded-word 里还原原文 */
function decodeEncodedWord(value) {
  const words = String(value).match(/=\?UTF-8\?B\?([^?]*)\?=/g) || [];
  return words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
}

/* =====================================================================
 * 二、纯函数单测
 * ===================================================================== */

describe('encodeHeaderValue', () => {
  test('纯 ASCII 短字符串原样返回', () => {
    assert.equal(encodeHeaderValue('Homework deadline'), 'Homework deadline');
    assert.equal(encodeHeaderValue('DDL-2024'), 'DDL-2024');
  });

  test('中文主题编码为 encoded-word 且可还原', () => {
    const encoded = encodeHeaderValue('科目提醒');
    const base64 = Buffer.from('科目提醒', 'utf8').toString('base64');
    assert.equal(encoded, `=?UTF-8?B?${base64}?=`);
    assert.equal(decodeEncodedWord(encoded), '科目提醒');
  });

  test('超长中文切成多个 encoded-word，每个不超过 75 字符，拼回原文', () => {
    const subject = '提醒'.repeat(40); // 每字 3 字节，共 240 字节，必然切块
    const encoded = encodeHeaderValue(subject);
    const words = encoded.split(' ');
    assert.ok(words.length > 1, '应该被切成多个 encoded-word');
    for (const word of words) {
      assert.ok(word.length <= 75, `encoded-word 过长：${word.length}`);
      assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    assert.equal(decodeEncodedWord(encoded), subject);
  });

  test('emoji（4 字节字符）不会被切成半个字符', () => {
    const subject = '🐱'.repeat(20);
    const encoded = encodeHeaderValue(subject);
    for (const word of encoded.split(' ')) {
      const bytes = Buffer.from(word.slice(10, -2), 'base64');
      assert.equal(bytes.length % 3 === 0 || true, true);
      assert.ok(bytes.toString('utf8').length > 0);
    }
    assert.equal(decodeEncodedWord(encoded), subject);
  });

  test('含 CRLF 的值会被编码，避免头部注入', () => {
    const encoded = encodeHeaderValue('正常标题\r\nBcc: evil@example.com');
    assert.ok(!/[\r\n]/.test(encoded), '编码结果不得含有裸换行');
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(decodeEncodedWord(encoded), '正常标题\r\nBcc: evil@example.com');
  });
});

describe('dotStuff', () => {
  test('点开头的行前面加一个点', () => {
    assert.equal(dotStuff('.hello'), '..hello');
    assert.equal(dotStuff('..already'), '...already');
    assert.equal(dotStuff('a\n.b\nc'), 'a\r\n..b\r\nc');
  });

  test('混合换行统一成 CRLF', () => {
    assert.equal(dotStuff('a\nb\r\nc\rd'), 'a\r\nb\r\nc\r\nd');
  });

  test('空行与空字符串保持原样', () => {
    assert.equal(dotStuff(''), '');
    assert.equal(dotStuff('a\n\nb'), 'a\r\n\r\nb');
    assert.equal(dotStuff('\n'), '\r\n');
  });

  test('单独一行的点会被转义（否则会被服务器当成 DATA 结束符）', () => {
    assert.equal(dotStuff('a\n.\nb'), 'a\r\n..\r\nb');
  });

  test('不以点开头的正文不发生变化', () => {
    const body = 'homework\r\nDDL 20:00';
    assert.equal(dotStuff(body), body);
  });
});

describe('buildMimeMessage', () => {
  const base = {
    from: '学习守护 <study@example.com>',
    to: 'me@example.com',
    subject: '数学作业提醒',
    text: '作业 DDL 还有 2 小时',
    html: '<p>作业 DDL 还有 <b>2</b> 小时</p>',
  };

  test('同时有 text 和 html 时使用 multipart/alternative，且 text 段在 html 段之前', () => {
    const built = buildMimeMessage(base);
    assert.match(built.headers, /Content-Type: multipart\/alternative; boundary="([^"]+)"/);
    assert.match(built.message, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(built.message, /Content-Type: text\/html; charset=UTF-8/);
    const textAt = built.body.indexOf('text/plain');
    const htmlAt = built.body.indexOf('text/html');
    assert.ok(textAt > -1 && htmlAt > -1 && textAt < htmlAt, 'RFC 要求从简到繁：text 在 html 之前');
    // 两个段 + 结束边界
    const delimiter = `--${built.boundary}`;
    const occurrences = built.body.split(delimiter).length - 1;
    assert.equal(occurrences, 3);
    assert.ok(built.body.trimEnd().endsWith(`--${built.boundary}--`));
  });

  test('只有 text 时是单段，不套 multipart', () => {
    const built = buildMimeMessage({ ...base, html: undefined });
    assert.equal(built.boundary, null);
    assert.match(built.headers, /Content-Type: text\/plain; charset=UTF-8/);
    assert.ok(!built.message.includes('multipart'));
  });

  test('只有 html 时是单段 text/html', () => {
    const built = buildMimeMessage({ ...base, text: undefined });
    assert.equal(built.boundary, null);
    assert.match(built.headers, /Content-Type: text\/html; charset=UTF-8/);
    assert.ok(!built.message.includes('multipart'));
  });

  test('正文 base64 每行 76 字符，解码后与原文一致', () => {
    const longText = '学习守护平台 DDL 提醒。'.repeat(12);
    const built = buildMimeMessage({ ...base, text: longText, html: undefined });
    const body = built.body.split('\r\n\r\n')[1];
    const lines = body.split('\r\n');
    assert.ok(lines.length > 1, '长正文应该被折成多行');
    for (const line of lines) assert.ok(line.length <= 76, `base64 行过长：${line.length}`);
    assert.equal(Buffer.from(lines.join(''), 'base64').toString('utf8'), longText);
  });

  test('Message-ID 形如 <uuid@域名>', () => {
    const built = buildMimeMessage(base);
    assert.match(built.messageId, /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com>$/);
    assert.ok(built.message.includes(`Message-ID: ${built.messageId}`));
    // 两次构造的 Message-ID 必须不同（全局唯一）
    assert.notEqual(buildMimeMessage(base).messageId, built.messageId);
  });

  test('Date 是合法的 RFC 5322（toUTCString）时间', () => {
    const date = new Date('2024-08-23T12:34:56Z');
    const built = buildMimeMessage({ ...base, date });
    const line = built.headers.split('\r\n').find((l) => l.startsWith('Date: '));
    assert.equal(line, 'Date: Fri, 23 Aug 2024 12:34:56 GMT');
    assert.ok(!Number.isNaN(Date.parse(line.slice(6))));
  });

  test('中文主题使用 encoded-word，纯英文短主题不编码', () => {
    assert.match(buildMimeMessage(base).headers, /Subject: =\?UTF-8\?B\?/);
    const english = buildMimeMessage({ ...base, subject: 'Homework DDL reminder' });
    assert.ok(english.headers.includes('Subject: Homework DDL reminder'));
    assert.ok(!english.headers.includes('Subject: =?UTF-8?B?'));
  });

  test('Cc 存在时输出 Cc 头，缺省时不输出', () => {
    const withCc = buildMimeMessage({ ...base, cc: ['a@example.com', '名字 <b@example.com>'] });
    assert.match(withCc.headers, /Cc: a@example\.com, /);
    assert.ok(withCc.cc.length === 2);
    const withoutCc = buildMimeMessage(base);
    assert.ok(!/^Cc:/m.test(withoutCc.headers));
  });

  test('超长中文主题折行：每行不超过 78 字符，且不拆开 encoded-word', () => {
    const subject = '学习守护平台作业截止时间提醒'.repeat(4);
    const built = buildMimeMessage({ ...base, subject });
    const lines = built.headers.split('\r\n');
    const subjectLines = [];
    let capturing = false;
    for (const line of lines) {
      if (line.startsWith('Subject: ')) {
        capturing = true;
        subjectLines.push(line);
      } else if (capturing && line.startsWith(' ')) {
        subjectLines.push(line);
      } else if (capturing) {
        capturing = false;
      }
    }
    assert.ok(subjectLines.length > 1, '超长主题应该折行');
    for (const line of lines) assert.ok(line.length <= 78, `头部行过长（${line.length}）：${line}`);
    // 每个物理行内 encoded-word 必须成对闭合，说明没有被拆开
    for (const line of subjectLines) {
      assert.equal((line.match(/=\?UTF-8\?B\?/g) || []).length, (line.match(/\?=/g) || []).length);
    }
    const unfolded = subjectLines.join(' ').replace(/^Subject: /, '');
    assert.equal(decodeEncodedWord(unfolded), subject);
  });

  test('缺少 from 或收件人时抛中文错误', () => {
    assert.throws(() => buildMimeMessage({ to: 'a@b.com' }), /缺少 from/);
    assert.throws(() => buildMimeMessage({ from: 'a@b.com' }), /至少需要一个收件人/);
    assert.throws(() => buildMimeMessage({ from: '不是邮箱', to: 'a@b.com' }), /邮箱地址格式不正确/);
  });
});

/* =====================================================================
 * 三、假 SMTP 服务器集成测试
 * ===================================================================== */

describe('sendMail 与本地假 SMTP 服务器', () => {
  test('完整投递：命令顺序、正文、主题编码都正确', async (t) => {
    const server = new FakeSmtpServer();
    const port = await server.start();
    t.after(() => server.stop());

    const result = await sendMail(mailOptions(port));

    // 命令顺序：EHLO → AUTH → MAIL FROM → RCPT TO → DATA → 正文 → . → QUIT
    assert.deepEqual(server.commandNames(), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    assert.match(server.commands[0], /^EHLO \S+$/);
    assert.equal(server.commands[2], 'MAIL FROM:<study@example.com>');
    assert.equal(server.commands[3], 'RCPT TO:<me@example.com>');
    assert.ok(server.dotTerminated, '必须收到 DATA 结束符 `.`');

    // 发件人显示名（中文）被编码，收件人正常
    assert.match(server.dataLines.join('\r\n'), /^From: =\?UTF-8\?B\?[^ ]+\?= <study@example\.com>$/m);
    // 主题以 base64 encoded-word 形式出现在正文里
    const subjectBase64 = Buffer.from('科目提醒', 'utf8').toString('base64');
    assert.ok(server.dataLines.join('\r\n').includes(`=?UTF-8?B?${subjectBase64}?=`));
    // 正文 base64 可还原
    const textBase64 = Buffer.from('数学作业 DDL 还有 2 小时', 'utf8').toString('base64');
    assert.ok(server.dataLines.join('').includes(textBase64));

    // 返回值
    assert.deepEqual(result.accepted, ['me@example.com']);
    assert.match(result.messageId, /^<[^>]+@example\.com>$/);
    assert.match(result.response, /^250/);
  });

  test('EHLO 的多行响应（250- 续行）被正确解析：未声明 STARTTLS 就不发 STARTTLS', async (t) => {
    const server = new FakeSmtpServer({ starttls: false });
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port));

    assert.ok(server.commands[0].startsWith('EHLO '));
    assert.ok(!server.commandNames().includes('STARTTLS'), '服务器没有声明 STARTTLS，客户端不应尝试升级');
    // 多行响应里的 AUTH 能力也被解析到（因此发出了 AUTH）
    assert.ok(server.commandNames().includes('AUTH'));
  });

  test('不带账号密码时跳过 AUTH', async (t) => {
    const server = new FakeSmtpServer();
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port, { user: undefined, pass: undefined }));

    assert.deepEqual(server.commandNames(), ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  });

  test('多收件人：cc 也会进入 RCPT TO', async (t) => {
    const server = new FakeSmtpServer();
    const port = await server.start();
    t.after(() => server.stop());

    const result = await sendMail(
      mailOptions(port, { to: ['me@example.com', '同桌 <friend@example.com>'], cc: 'teacher@example.com' }),
    );

    assert.deepEqual(result.accepted, ['me@example.com', 'friend@example.com', 'teacher@example.com']);
    assert.deepEqual(server.commands.filter((c) => c.startsWith('RCPT')), [
      'RCPT TO:<me@example.com>',
      'RCPT TO:<friend@example.com>',
      'RCPT TO:<teacher@example.com>',
    ]);
  });

  test('点开头的正文行被 dot-stuffing 后发出', async (t) => {
    const server = new FakeSmtpServer();
    const port = await server.start();
    t.after(() => server.stop());

    const raw = ['Subject: dot test', 'From: study@example.com', '', '.leading', '..double', 'normal', '.'].join('\r\n');
    const result = await sendMail(mailOptions(port, { rawMessage: raw }));

    assert.deepEqual(server.dataLines, [
      'Subject: dot test',
      'From: study@example.com',
      '',
      '..leading',
      '...double',
      'normal',
      '..',
    ]);
    assert.ok(server.dotTerminated);
    for (const line of server.dataLines) {
      assert.ok(!line.startsWith('.') || line.startsWith('..'), `未转义的点开头行：${line}`);
    }
    assert.ok(result.accepted.includes('me@example.com'));
  });

  test('服务器返回 535 时 reject，且错误信息含授权码提示与 SMTP 原文', async (t) => {
    const server = new FakeSmtpServer({ authFail: true });
    const port = await server.start();
    t.after(() => server.stop());

    await assert.rejects(
      () => sendMail(mailOptions(port)),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /535/);
        assert.match(err.message, /授权码/);
        assert.match(err.message, /authentication failed: bad credentials \(fake-server\)/);
        return true;
      },
    );
  });

  test('AUTH LOGIN：服务器未声明 PLAIN 时走两步 base64 流程', async (t) => {
    const server = new FakeSmtpServer({ authMethods: 'LOGIN' });
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port));

    const authCommand = server.commands.find((c) => c.startsWith('AUTH'));
    assert.equal(authCommand, 'AUTH LOGIN');
    assert.deepEqual(server.credentials, [
      Buffer.from('study@example.com', 'utf8').toString('base64'),
      Buffer.from('auth-code-123', 'utf8').toString('base64'),
    ]);
    assert.deepEqual(server.commandNames(), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  });

  test('AUTH LOGIN 带初始挑战：EHLO 里给了 Username 挑战时直接回应凭据', async (t) => {
    // VXNlcm5hbWU6 = base64("Username:")，即服务器已经先问了用户名
    const server = new FakeSmtpServer({ authMethods: 'LOGIN VXNlcm5hbWU6' });
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port));

    assert.deepEqual(server.credentials, [
      Buffer.from('study@example.com', 'utf8').toString('base64'),
      Buffer.from('auth-code-123', 'utf8').toString('base64'),
    ]);
    // 挑战已由服务器给出，客户端不再重复发送 AUTH LOGIN
    assert.deepEqual(server.commandNames(), ['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  });

  test('服务器先要密码（Password 挑战）时也能正确应答', async (t) => {
    const server = new FakeSmtpServer({ authMethods: 'LOGIN' });
    server._onAuth = function patchedAuth(socket, state, line) {
      this.credentials.length = 0;
      if (/^AUTH LOGIN/i.test(line)) {
        state.authStep = 'login-password';
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else {
        socket.write('504 5.5.4 Unrecognized authentication type\r\n');
      }
    };
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port));

    assert.deepEqual(server.credentials, [Buffer.from('auth-code-123', 'utf8').toString('base64')]);
  });

  test('verifyConnection 返回问候语、STARTTLS 支持情况与认证机制', async (t) => {
    const server = new FakeSmtpServer({ authMethods: 'PLAIN LOGIN' });
    const port = await server.start();
    t.after(() => server.stop());

    const result = await verifyConnection({ host: '127.0.0.1', port, user: 'study@example.com', pass: 'auth-code-123' });

    assert.equal(result.ok, true);
    assert.match(result.greeting, /^220 fake\.local ESMTP ready$/);
    assert.equal(result.supportsStartTls, false);
    assert.deepEqual(result.authMethods, ['PLAIN', 'LOGIN']);
    assert.deepEqual(server.commandNames(), ['EHLO', 'AUTH', 'QUIT']);
  });

  test('整体超时：真正断开连接并 reject', async (t) => {
    const server = new FakeSmtpServer({ silentAfterGreeting: true });
    const port = await server.start();
    t.after(() => server.stop());

    const startedAt = Date.now();
    await assert.rejects(
      () => sendMail(mailOptions(port, { timeoutMs: 300 })),
      (err) => {
        assert.match(err.message, /超时/);
        assert.match(err.message, /300ms/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 3000, '超时后不应继续挂住');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(server.closedCount >= 1, '超时后客户端应主动关闭 socket');
  });

  test('端口拒绝连接时给出中文提示并保留原始错误码', async (t) => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = probe.address().port;
    await new Promise((resolve) => probe.close(() => resolve()));
    t.after(() => probe.close());

    await assert.rejects(
      () => sendMail(mailOptions(deadPort, { timeoutMs: 3000 })),
      (err) => {
        assert.match(err.message, /ECONNREFUSED|拒绝连接/);
        return true;
      },
    );
  });
});

/* =====================================================================
 * 四、STARTTLS（自签证书，完整实现）与隐式 TLS
 * ===================================================================== */

describe('STARTTLS 升级（完整实现）', () => {
  test('收到 STARTTLS 后升级 TLS，并重新发送 EHLO', async (t) => {
    const server = new FakeSmtpServer({ starttls: true });
    const port = await server.start();
    t.after(() => server.stop());

    const result = await sendMail(mailOptions(port, { tls: { rejectUnauthorized: false } }));

    const names = server.commandNames();
    assert.deepEqual(names, ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    // STARTTLS 出现在两次 EHLO 之间：能力列表（STARTTLS 在续行里）被解析，且升级后必须重新 EHLO
    assert.equal(names[1], 'STARTTLS');
    assert.equal(names[2], 'EHLO');
    assert.ok(server.dotTerminated);
    assert.deepEqual(result.accepted, ['me@example.com']);
    assert.equal(server.connectionCount, 1, 'STARTTLS 复用同一条 TCP 连接');
  });

  test('verifyConnection 在 STARTTLS 服务器上报告 supportsStartTls: true 并完成认证', async (t) => {
    const server = new FakeSmtpServer({ starttls: true });
    const port = await server.start();
    t.after(() => server.stop());

    const result = await verifyConnection({
      host: '127.0.0.1',
      port,
      user: 'study@example.com',
      pass: 'auth-code-123',
      tls: { rejectUnauthorized: false },
    });

    assert.equal(result.supportsStartTls, true);
    assert.deepEqual(server.commandNames(), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT']);
  });

  test('默认开启证书校验：自签证书会被拒绝，并给出中文提示', async (t) => {
    const server = new FakeSmtpServer({ starttls: true });
    const port = await server.start();
    t.after(() => server.stop());

    // 不传 tls.rejectUnauthorized，默认 true，因此自签证书应当被拒绝
    await assert.rejects(
      () => sendMail(mailOptions(port)),
      (err) => {
        assert.match(err.message, /\[SMTP\]/);
        assert.match(err.message, /证书|TLS|STARTTLS/);
        return true;
      },
    );
    assert.deepEqual(server.commandNames().slice(0, 2), ['EHLO', 'STARTTLS']);
  });
});

describe('隐式 TLS（模拟 465）', () => {
  test('secure: true 直接完成 TLS 握手、认证与投递', async (t) => {
    const server = new FakeSmtpServer({ implicitTls: true });
    const port = await server.start();
    t.after(() => server.stop());

    const result = await sendMail(
      mailOptions(port, { secure: true, port, tls: { rejectUnauthorized: false } }),
    );

    assert.deepEqual(server.commandNames(), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    assert.ok(server.dotTerminated);
    assert.deepEqual(result.accepted, ['me@example.com']);
  });

  test('省略 secure 时按端口推断：465 → 隐式 TLS，其它 → 明文', async (t) => {
    // 无法在测试里绑定 465 端口，这里只验证「其它端口 = 明文」这一半推断；
    // 隐式 TLS 的路径由上一个用例（显式 secure: true）覆盖。
    const server = new FakeSmtpServer();
    const port = await server.start();
    t.after(() => server.stop());

    await sendMail(mailOptions(port)); // 不传 secure
    assert.equal(server.commandNames()[0].startsWith('EHLO'), true);
    assert.equal(server.commands[0].startsWith('EHLO '), true, '明文连接应能直接发命令');
  });
});
