/**
 * 通知渠道注册表。
 *
 * 设计目标：想加一个新的推送方式，只需要在 CHANNELS 数组里加一项，
 * 设置页的表单、测试按钮、发送逻辑都会自动接上，不用改其它文件。
 *
 * 每个渠道的形状：
 *   {
 *     type:      'bark'                   唯一标识，存进数据库
 *     label:     'Bark'                   显示名
 *     tagline:   '一句话说明'               设置页的副标题
 *     docs:      'https://...'            官方说明链接，设置页会给个链接
 *     badge:     'iPhone 推荐'            角标
 *     fields:    [ {...} ]                配置表单字段
 *     guide:     '<ol>...</ol>'           选填。渠道专属的分步引导（静态 HTML，
 *                                         不含用户输入，设置页会折叠展示）
 *     normalize(config)                   选填。入库/发送前修正用户填的内容。
 *                                         返回新对象，不要就地改。抛错会被忽略。
 *     async send(config, msg)             返回 { ok: boolean, detail: string }
 *   }
 */

import crypto from 'node:crypto';
import { sendMail, verifyConnection } from '../smtp.js';

// ============================================================
// 公共工具
// ============================================================

/**
 * 把 fetch 抛出的网络错误翻译成用户能照着做的话。
 *
 * Node 的 fetch（undici）失败时只会给一句 "fetch failed"，
 * 真正的原因藏在 err.cause 里（ECONNREFUSED、ENOTFOUND……）。
 * 只看 err.message 的话，用户拿到的信息量是零。
 */
export function explainNetworkFailure(err) {
  const cause = err?.cause || {};
  const code = String(cause.code || err?.code || '');
  const target = cause.address ? `（${cause.address}:${cause.port}）` : '';

  switch (code) {
    case 'ECONNREFUSED':
      return `连不上服务器${target}。服务器地址或端口可能填错了，也可能服务没启动。`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '服务器地址解析不了。检查一下域名有没有打错字，或者当前网络能不能上外网。';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return '连接服务器超时。检查网络，或者服务器地址是否可达。';
    case 'ECONNRESET':
      return '连接被服务器中断了。稍后重试；如果用自建服务器，检查它是否正常运行。';
    case 'CERT_HAS_EXPIRED':
      return '服务器证书已过期，浏览器/系统不信任它。';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return '服务器用的是自签名证书，无法验证。请换成受信任的证书。';
    default:
      break;
  }

  // 没有可识别的错误码时，把 cause 的原话带上——总比干巴巴一句
  // "fetch failed" 强，至少能拿去搜索。undici 对畸形 URL 会直接抛
  // "bad port" / "Invalid URL"，这类基本等于「地址填错了」。
  const detail = cause.message || err?.message || String(err);
  if (/bad port|invalid url|invalid port/i.test(detail)) {
    return `服务器地址不合法（${detail}）。检查一下是不是多了空格、少了端口号或者协议头写错了。`;
  }
  return `网络请求失败：${detail}`;
}

/**
 * 带超时的 fetch，返回解析后的 JSON（或文本）。
 * 统一处理「网络不通」「超时」「返回非 JSON」这几类常见故障，
 * 并把错误信息翻译成中文，方便在日志里看。
 */
async function requestJson(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 有些服务返回纯文本 */
    }
    return { status: res.status, ok: res.ok, text, json };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或服务器地址`);
    }
    throw new Error(explainNetworkFailure(err));
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url, body, timeoutMs) {
  return requestJson(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

/** 生成纯文本消息（用于只支持文本的渠道） */
function toPlainText(msg) {
  const lines = [msg.title];
  if (msg.body) lines.push('', msg.body);
  if (msg.url) lines.push('', msg.url);
  return lines.join('\n');
}

/** 生成 Markdown 消息（企业微信/钉钉/飞书用） */
function toMarkdown(msg) {
  const lines = [`**${msg.title}**`];
  if (msg.body) lines.push('', msg.body);
  if (msg.url) lines.push('', `[点击查看](${msg.url})`);
  return lines.join('\n');
}

/** 生成简单 HTML（邮件用） */
function toHtml(msg) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#222">
  <h2 style="margin:0 0 12px">${esc(msg.title)}</h2>
  <div style="white-space:pre-wrap">${esc(msg.body)}</div>
  ${msg.url ? `<p style="margin-top:16px"><a href="${esc(msg.url)}">在「学习守护」中打开 →</a></p>` : ''}
</body></html>`;
}

/** 校验必填字段，缺失时给出清晰的中文提示 */
function requireFields(config, keys) {
  const missing = keys.filter((k) => !String(config?.[k] ?? '').trim());
  if (missing.length) throw new Error(`配置不完整，缺少：${missing.join('、')}`);
}

/** 去掉结尾多余的斜杠 */
function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// ============================================================
// 渠道定义
// ============================================================

/**
 * 把 Bark 返回的英文错误翻译成「照着做就行」的中文提示。
 *
 * Bark 的报错就那几种，但直接甩给用户基本看不懂：
 * 「device token is not exists」到底是什么坏了？没人知道。
 */
export function explainBarkError(raw, status, server, key) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  /**
   * 只露前 3 位、后 2 位。
   *
   * ⚠️ 这里以前是 `key.slice(0, 6)` —— 前 6 位。问题在于这句话会被写进
   * `notify_log.detail`，然后在设置页的「发送记录」里原样显示出来：
   * 一条推送失败，就等于把 Key 的前 6 位长期挂在页面上（截图、共享屏幕就漏了）。
   * 前 3 + 后 2 足够用户对照「填的是不是这一个」，和渠道表单打码的口径也一致。
   */
  const rawKey = String(key || '');
  const keyHint = rawKey.length > 8
    ? `${rawKey.slice(0, 3)}•••${rawKey.slice(-2)}`
    : '（看不出来，太短了）';

  if (/device token is not exists|failed to get device token|invalid device token/.test(lower)) {
    return '推送 Key 不对。'
      + '请打开 Bark App，在首页长按那串 Key 复制，重新粘贴到「推送 Key」里'
      + `（你现在填的是「${keyHint}」）。`
      + `服务器原话：${text}`;
  }
  if (/no such device|device not found/.test(lower)) {
    return `Bark 服务器上找不到这个设备。多半是 Key 复制错了，或者这个 Key 属于别的 Bark 服务器。服务器原话：${text}`;
  }
  if (status === 404) {
    return `推送接口不存在（HTTP 404）。请检查「服务器地址」——官方地址是 https://api.day.app（当前填的是 ${server}）。`;
  }
  if (status === 401 || status === 403) {
    return `服务器拒绝了这次推送（HTTP ${status}）。如果用自建 Bark，检查一下是否开启了访问鉴权。`;
  }
  if (status === 429) {
    return '推送太频繁被服务器限流了（HTTP 429）。等一会儿再试。';
  }
  if (text) return `推送失败：${text}（服务器地址 ${server}）`;
  return `推送失败：HTTP ${status}（服务器地址 ${server}）`;
}

/**
 * 整理 Bark 的配置，把「人能看懂但机器不能直接用」的输入修正过来。
 *
 * 提到模块级（而不是写在渠道对象的方法里）是为了让 send() 也能直接调它——
 * 只要有一处调用绕过了 index.js 的 normalizeConfig，清洗就会被跳过，
 * 那样用户还是会撞上那句英文报错。这个函数是幂等的，重复调用无害。
 *
 * 处理三件事：
 *   ① 清掉 Key 里的空白与换行
 *   ② 把误粘进 Key / 服务器地址的完整网址拆开
 *   ③ 服务器地址补协议、去结尾斜杠
 */
function normalizeBarkConfig(config) {
  const out = { ...config };

  // ① Bark 对 Key 是精确匹配的，多一个空格或换行就会被判成
  //    「device token is not exists」。从备忘录、微信里复制时很常见，
  //    而且肉眼几乎看不出来，所以必须统一清掉。
  const cleanKey = String(out.key || '').replace(/\s+/g, '');
  out.key = cleanKey;

  // ②a 「推送 Key」框里可能是完整网址
  const urlInKey = /^(https?:\/\/)?([^/\s]+)\/([A-Za-z0-9_-]{6,})\/?$/.exec(cleanKey);
  if (urlInKey) {
    const host = urlInKey[2];
    const currentServer = String(out.server || '').trim();
    // 只有服务器地址是空的、或者还是官方默认值时，才用网址里的域名覆盖，
    // 避免把用户自己填的自建地址冲掉
    if (!currentServer || /api\.day\.app/i.test(currentServer)) {
      out.server = `https://${host}`;
    }
    out.key = urlInKey[3];
  }

  // ②b 「服务器地址」框里可能带着 Key
  const rawServer = String(out.server || '').trim().replace(/\s+/g, '');
  const urlInServer = /^(https?:\/\/)?([^/\s]+)\/([A-Za-z0-9_-]{6,})\/?$/.exec(rawServer);
  if (urlInServer) {
    out.server = `${urlInServer[1] || 'https://'}${urlInServer[2]}`;
    if (!String(out.key || '').trim()) out.key = urlInServer[3];
  }

  // ③ 补协议、去结尾斜杠（否则会拼出 https://api.day.app//push）
  let server = String(out.server || '').trim();
  if (server && !/^https?:\/\//i.test(server)) server = `https://${server}`;
  out.server = server.replace(/\/+$/, '') || 'https://api.day.app';

  return out;
}

export const CHANNELS = [
  // ----------------------------------------------------------
  // 1. Bark —— iPhone 用户首选
  // ----------------------------------------------------------
  {
    type: 'bark',
    label: 'Bark',
    tagline: 'iPhone 免费推送。App Store 装个 Bark，把首页那串 Key 填进来就行，不用注册账号。',
    docs: 'https://bark.day.app',
    badge: 'iPhone 推荐',

    /**
     * 规范化用户输入。实现见模块顶部的 normalizeBarkConfig ——
     * send() 里也会调同一个函数，两处行为保证一致。
     */
    normalize: normalizeBarkConfig,

    fields: [
      {
        key: 'key',
        label: '推送 Key',
        type: 'text',
        required: true,
        placeholder: '例如 AbCdEf123456',
        help: 'Bark App 首页那串字符。<strong>也可以把首页显示的完整网址整段粘进来</strong>，我们会自动识别。',
      },
      {
        key: 'server',
        label: '服务器地址',
        type: 'text',
        placeholder: 'https://api.day.app',
        default: 'https://api.day.app',
        help: '用官方服务器就保持默认。自建 Bark 服务端填自己的地址。',
      },
      {
        key: 'level',
        label: '通知级别',
        type: 'select',
        options: [
          { value: 'timeSensitive', label: '时效性通知（推荐，能穿透专注模式）' },
          { value: 'active', label: '普通通知' },
          { value: 'passive', label: '静默通知（不亮屏、不出声）' },
          { value: 'critical', label: '重要警告（会响铃，需要专门授权）' },
        ],
        default: 'timeSensitive',
        help: '选了「时效性通知」之后，要去 iPhone「设置 → 通知 → Bark → 时效性通知」把开关打开，'
          + '否则会被自动降级成普通通知，专注模式下收不到。',
      },
      {
        key: 'sound',
        label: '提示音',
        type: 'select',
        options: [
          { value: '', label: '系统默认' },
          { value: 'bell', label: 'bell —— 铃声（推荐）' },
          { value: 'alarm', label: 'alarm —— 闹钟' },
          { value: 'birdsong', label: 'birdsong —— 鸟鸣' },
          { value: 'electronic', label: 'electronic —— 电子音' },
          { value: 'glass', label: 'glass —— 玻璃' },
          { value: 'horn', label: 'horn —— 喇叭' },
          { value: 'mail', label: 'mail —— 邮件' },
          { value: 'newmail', label: 'newmail —— 新邮件' },
          { value: 'sparkles', label: 'sparkles —— 闪光' },
          { value: 'suspense', label: 'suspense —— 悬念' },
          { value: 'telegraph', label: 'telegraph —— 电报' },
          { value: 'typewriter', label: 'typewriter —— 打字机' },
          { value: 'silence', label: 'silence —— 静音' },
        ],
        default: 'bell',
        help: '在 Bark App「设置 → 提示音」里可以先试听，挑一个喜欢的。',
      },
      {
        key: 'group',
        label: '消息分组',
        type: 'text',
        placeholder: '学习守护',
        default: '学习守护',
        help: '同一个分组的消息会在通知中心折叠在一起，方便回看。留空就用「学习守护」。',
      },
      {
        key: 'icon',
        label: '自定义图标',
        type: 'text',
        placeholder: 'https://example.com/icon.png',
        help: '选填。填一个图片网址，通知左侧会显示它（比如放自己学校的校徽）。',
      },
    ],

    /**
     * 渠道专属的图文引导。
     * 这些是平台自己写好的内容（不含用户输入），所以可以直接按 HTML 渲染。
     */
    guide: `
<ol class="guide-steps">
  <li>
    <strong>装 Bark</strong>
    打开 App Store 搜索 <code>Bark</code>（图标是个铃铛），安装。免费开源，<strong>不需要注册任何账号</strong>。
  </li>
  <li>
    <strong>第一次打开时点「允许」</strong>
    iOS 会弹通知权限请求，必须点允许，否则后面收不到提醒。这一步错了后面全白搭。
  </li>
  <li>
    <strong>复制 Key</strong>
    Bark 首页会显示一串字符，形如 <code>AbCdEf123456</code>。
    <em>长按它就能复制</em>。也可以直接复制整段网址 <code>https://api.day.app/AbCdEf123456</code>——
    <strong>两种都行，我们会自动识别</strong>。
  </li>
  <li>
    <strong>粘贴到上面的「推送 Key」，然后点「发送测试」</strong>
    如果填错了，这里会明确告诉你错在哪，不用猜。
  </li>
  <li>
    <strong>确认 iPhone 收到了测试消息</strong>
    应该几乎立刻就弹出来。收到了就说明配好了，直接保存。
  </li>
</ol>

<details class="guide-details">
  <summary>没收到测试消息？按这个顺序排查</summary>
  <ol>
    <li>
      <strong>先看 Bark App 里有没有这条历史消息。</strong>
      <br>有 → 说明推送发出去了，是手机通知被挡住了，看后面几条。
      <br>没有 → Key 或服务器地址不对，回首页重新复制一次 Key。
    </li>
    <li>打开 iPhone「设置 → 通知 → Bark」，确认「允许通知」是开着的。</li>
    <li>
      是不是开着专注模式 / 勿扰模式？
      把上面的「通知级别」改成<strong>时效性通知</strong>，
      再去「设置 → 通知 → Bark → 时效性通知」把开关打开。
    </li>
    <li>手机是不是静音了？Bark 走的是通知，静音时不会响（除非用「重要警告」级别，但那个要在 iOS 里单独授权）。</li>
    <li>用自建服务器的：用手机浏览器打开你的服务器地址，能打开才说明网络通。</li>
  </ol>
</details>

<details class="guide-details">
  <summary>Bark 首页显示的不是 Key，而是一堆按钮？</summary>
  <p>
    有些版本的 Bark 首页把 Key 收起来了。点右上角的<strong>服务器图标</strong>，
    或者进「设置」里能看到当前设备的 Key，长按复制即可。
  </p>
  <p>如果 App 里绑定了多台设备，注意复制<strong>当前这台 iPhone</strong> 的 Key。</p>
</details>

<details class="guide-details">
  <summary>自建 Bark 服务器怎么填</summary>
  <ul>
    <li>「服务器地址」填你的地址，例如 <code>https://bark.你的域名.com</code>（不要带结尾斜杠）</li>
    <li>Key 还是从 Bark App 首页复制。自建服务器需要在 App 里手动添加服务器地址</li>
    <li>如果服务端开了访问鉴权，先在 App 里配置好对应的 Token</li>
    <li>手机不在同一个局域网时，服务器地址必须能从外网访问</li>
  </ul>
</details>
`,

    async send(rawConfig, msg) {
      // 调用方（index.js）通常已经规范化过了，这里再走一遍是兜底：
      // 万一有别的代码路径直接调 send，也不该因为一个换行符就失败。
      const config = normalizeBarkConfig(rawConfig);
      requireFields(config, ['key']);
      const server = config.server;

      const payload = {
        title: msg.title,
        body: msg.body || '',
        group: config.group || '学习守护',
        level: config.level || 'timeSensitive',
      };
      if (config.sound) payload.sound = config.sound;
      if (config.icon) payload.icon = config.icon;
      if (msg.url) payload.url = msg.url;

      // 两种调用方式都试一遍，兼容不同版本的 Bark 服务端：
      //   ① POST /push      —— JSON 里带 device_key（新版推荐写法）
      //   ② POST /{key}     —— Key 放在路径里（老版本也支持）
      const attempts = [
        { label: 'POST /push', url: `${server}/push`, body: { ...payload, device_key: config.key } },
        { label: 'POST /{key}', url: `${server}/${encodeURIComponent(config.key)}`, body: payload },
      ];

      /** 网络层的失败（连不上、超时、DNS）——和「Bark 明确拒绝了」是两回事 */
      const netErrors = [];
      /** Bark 明确返回的失败 */
      const apiErrors = [];

      for (const attempt of attempts) {
        let res;
        try {
          res = await postJson(attempt.url, attempt.body);
        } catch (err) {
          netErrors.push(err.message);
          continue;
        }

        const code = Number(res.json?.code ?? res.status);
        if (code === 200) return { ok: true, detail: '推送成功' };

        const raw = String(res.json?.message || res.text || '').trim();
        apiErrors.push(explainBarkError(raw, res.status, server, config.key));

        // Key 本身不对的话，换一种调用方式也一样失败，没必要再试
        if (/device token|device not found|no such device/i.test(raw)) break;
      }

      // 连不上服务器时，两种调用方式给出的原因必然一样，
      // 而且 "POST /push：…" 这种前缀对用户毫无意义，直接给裸的原因。
      if (apiErrors.length) throw new Error(apiErrors[0]);
      if (netErrors.length) throw new Error(netErrors[0]);
      throw new Error('推送失败，原因未知');
    },
  },

  // ----------------------------------------------------------
  // 2. 邮件
  // ----------------------------------------------------------
  {
    type: 'email',
    label: '邮件',
    tagline: '发到你自己的邮箱，手机邮件 App 会弹通知。QQ / 163 / Gmail / 学校邮箱都支持。',
    docs: '',
    badge: '通用',
    fields: [
      {
        key: 'host',
        label: 'SMTP 服务器',
        type: 'text',
        required: true,
        placeholder: 'smtp.qq.com',
        help: 'QQ 邮箱 smtp.qq.com；163 邮箱 smtp.163.com；Gmail smtp.gmail.com。',
      },
      {
        key: 'port',
        label: '端口',
        type: 'number',
        placeholder: '465',
        default: '465',
        help: '465 = SSL 直连，587 = STARTTLS。',
      },
      {
        key: 'secure',
        label: '加密方式',
        type: 'select',
        options: [
          { value: '', label: '按端口自动判断' },
          { value: 'true', label: 'SSL（465）' },
          { value: 'false', label: 'STARTTLS（587 / 25）' },
        ],
        default: '',
      },
      {
        key: 'user',
        label: '邮箱账号',
        type: 'text',
        required: true,
        placeholder: 'yourname@qq.com',
      },
      {
        key: 'pass',
        label: '授权码',
        type: 'password',
        required: true,
        placeholder: '不是邮箱登录密码！',
        help: '国内邮箱必须在网页版设置里开启 SMTP 并生成「授权码」，直接填登录密码会报 535 错误。',
      },
      {
        key: 'from',
        label: '发件人',
        type: 'text',
        placeholder: '学习守护 <yourname@qq.com>',
        help: '留空则用邮箱账号。可以写成「学习守护 &lt;你的邮箱&gt;」的格式。',
      },
      {
        key: 'to',
        label: '收件人',
        type: 'text',
        required: true,
        placeholder: 'yourname@qq.com',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['host', 'user', 'pass', 'to']);
      const port = Number(config.port) || 465;
      const secure = config.secure === '' || config.secure === undefined
        ? port === 465
        : config.secure === 'true';

      await sendMail({
        host: config.host,
        port,
        secure,
        user: config.user,
        pass: config.pass,
        from: config.from || config.user,
        to: config.to,
        subject: msg.title,
        text: toPlainText(msg),
        html: toHtml(msg),
      });
      return { ok: true, detail: `已发送到 ${config.to}` };
    },
    async test(config) {
      requireFields(config, ['host', 'user', 'pass']);
      const port = Number(config.port) || 465;
      const secure = config.secure === '' || config.secure === undefined
        ? port === 465
        : config.secure === 'true';
      const info = await verifyConnection({
        host: config.host,
        port,
        secure,
        user: config.user,
        pass: config.pass,
      });
      return { ok: true, detail: `SMTP 连接与登录成功（${info.greeting}）` };
    },
  },

  // ----------------------------------------------------------
  // 3. 企业微信机器人
  // ----------------------------------------------------------
  {
    type: 'wecom',
    label: '企业微信机器人',
    tagline: '在群聊里加个「群机器人」，把 Webhook 地址粘进来。手机装企业微信就能收到，个人也能免费用。',
    docs: 'https://developer.work.weixin.qq.com/document/path/91770',
    badge: '国内通用',
    fields: [
      {
        key: 'webhook',
        label: 'Webhook 地址',
        type: 'text',
        required: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
        help: '企业微信 → 任意群 → 群机器人 → 添加 → 复制 Webhook 地址。',
      },
      {
        key: 'mentioned',
        label: '@成员手机号',
        type: 'text',
        placeholder: '13800138000,13900139000',
        help: '选填。填写后会 @ 你，手机通知更醒目。',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['webhook']);
      const content = toMarkdown(msg);
      const body = { msgtype: 'markdown', markdown: { content } };

      // @成员需要走 text 类型（markdown 不支持 @）
      if (config.mentioned && config.mentioned.trim()) {
        const mobiles = config.mentioned.split(',').map((s) => s.trim()).filter(Boolean);
        body.msgtype = 'text';
        body.text = {
          content: `${msg.title}\n\n${msg.body || ''}${msg.url ? `\n\n${msg.url}` : ''}`,
          mentioned_mobile_list: mobiles,
        };
        delete body.markdown;
      }

      const res = await postJson(config.webhook, body);
      if (res.json && Number(res.json.errcode) === 0) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.json?.errmsg || res.text.slice(0, 200) || `HTTP ${res.status}`}`);
    },
  },

  // ----------------------------------------------------------
  // 4. 钉钉机器人
  // ----------------------------------------------------------
  {
    type: 'dingtalk',
    label: '钉钉机器人',
    tagline: '钉钉群 → 智能群助手 → 添加机器人 → 自定义。支持加签校验。',
    docs: 'https://open.dingtalk.com/document/robots/custom-robot-access',
    badge: '国内通用',
    fields: [
      {
        key: 'webhook',
        label: 'Webhook 地址',
        type: 'text',
        required: true,
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx',
      },
      {
        key: 'secret',
        label: '加签密钥（SEC 开头）',
        type: 'text',
        placeholder: 'SECxxxxxxxxxxxxxxxx',
        help: '选填。机器人安全设置选了「加签」时必填；选了「自定义关键词」则留空。',
      },
      {
        key: 'keyword',
        label: '自定义关键词',
        type: 'text',
        placeholder: '学习守护',
        help: '选填。安全设置选了「自定义关键词」时，消息标题必须包含这个词。',
        default: '学习守护',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['webhook']);
      let url = config.webhook;

      // 加签：timestamp + "\n" + secret 做 HMAC-SHA256，再 base64 并 URL 编码
      if (config.secret && config.secret.trim()) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${config.secret.trim()}`;
        const sign = crypto
          .createHmac('sha256', config.secret.trim())
          .update(stringToSign)
          .digest('base64');
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }

      const title = config.keyword && !msg.title.includes(config.keyword)
        ? `${config.keyword} ${msg.title}`
        : msg.title;

      const res = await postJson(url, {
        msgtype: 'markdown',
        markdown: { title, text: toMarkdown({ ...msg, title }) },
      });

      if (res.json && Number(res.json.errcode) === 0) return { ok: true, detail: '推送成功' };
      const errmsg = res.json?.errmsg || res.text.slice(0, 200) || `HTTP ${res.status}`;
      if (/keywords|310000/i.test(errmsg)) {
        throw new Error(`推送失败：${errmsg}（请在机器人安全设置里加上自定义关键词「${config.keyword || '学习守护'}」）`);
      }
      throw new Error(`推送失败：${errmsg}`);
    },
  },

  // ----------------------------------------------------------
  // 5. 飞书机器人
  // ----------------------------------------------------------
  {
    type: 'feishu',
    label: '飞书机器人',
    tagline: '飞书群 → 设置 → 群机器人 → 添加「自定义机器人」。',
    docs: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
    badge: '国内通用',
    fields: [
      {
        key: 'webhook',
        label: 'Webhook 地址',
        type: 'text',
        required: true,
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
      },
      {
        key: 'secret',
        label: '签名校验密钥',
        type: 'text',
        placeholder: '选填',
        help: '机器人安全设置勾选了「签名校验」时必填。',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['webhook']);
      const body = {
        msg_type: 'text',
        content: { text: toPlainText(msg) },
      };

      // 飞书签名：以 "timestamp\nsecret" 为**密钥**，对空字符串做 HMAC-SHA256
      if (config.secret && config.secret.trim()) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = crypto
          .createHmac('sha256', `${timestamp}\n${config.secret.trim()}`)
          .update('')
          .digest('base64');
        body.timestamp = timestamp;
        body.sign = sign;
      }

      const res = await postJson(config.webhook, body);
      const code = res.json?.code ?? res.json?.StatusCode;
      if (Number(code) === 0) return { ok: true, detail: '推送成功' };
      throw new Error(
        `推送失败：${res.json?.msg || res.text.slice(0, 200) || `HTTP ${res.status}`}`,
      );
    },
  },

  // ----------------------------------------------------------
  // 6. ntfy（开源，可自建）
  // ----------------------------------------------------------
  {
    type: 'ntfy',
    label: 'ntfy',
    tagline: '开源推送服务，安卓 / iOS 都有 App，也可以完全自建（不依赖任何第三方）。',
    docs: 'https://ntfy.sh',
    badge: '开源可自建',
    fields: [
      {
        key: 'server',
        label: '服务器地址',
        type: 'text',
        placeholder: 'https://ntfy.sh',
        default: 'https://ntfy.sh',
        help: '用官方公共服就填 https://ntfy.sh；自建填自己的域名。',
      },
      {
        key: 'topic',
        label: '主题（Topic）',
        type: 'text',
        required: true,
        placeholder: 'study-guardian-你的随机串',
        help: '相当于密码，别人知道了就能给你发消息，建议加一长串随机字符。',
      },
      {
        key: 'token',
        label: '访问令牌',
        type: 'text',
        placeholder: '选填，自建服务开启鉴权时填',
      },
      {
        key: 'priority',
        label: '优先级',
        type: 'select',
        options: [
          { value: '5', label: '5 - Max（穿透免打扰）' },
          { value: '4', label: '4 - High（高，默认）' },
          { value: '3', label: '3 - Default' },
          { value: '2', label: '2 - Low' },
        ],
        default: '4',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['topic']);
      const server = trimSlash(config.server || 'https://ntfy.sh');
      const headers = {
        Title: encodeURIComponent(msg.title),
        Priority: String(config.priority || '4'),
        Tags: 'books,memo',
      };
      // ntfy 的标题头要求纯 ASCII，中文用 RFC 2047 编码更稳，这里用 base64 兜底
      if (/[^\x20-\x7E]/.test(msg.title)) {
        headers.Title = `=?UTF-8?B?${Buffer.from(msg.title, 'utf8').toString('base64')}?=`;
      }
      if (msg.url) headers.Click = msg.url;
      if (config.token) headers.Authorization = `Bearer ${config.token}`;

      const res = await requestJson(`${server}/${encodeURIComponent(config.topic)}`, {
        method: 'POST',
        headers,
        body: toPlainText(msg),
      });

      if (res.ok) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.text.slice(0, 200) || `HTTP ${res.status}`}`);
    },
  },

  // ----------------------------------------------------------
  // 7. PushPlus（微信推送，国内）
  // ----------------------------------------------------------
  {
    type: 'pushplus',
    label: 'PushPlus（微信）',
    tagline: '关注公众号后用微信收提醒。微信扫一扫登录就能拿到 token。',
    docs: 'https://www.pushplus.plus',
    badge: '微信',
    fields: [
      {
        key: 'token',
        label: 'Token',
        type: 'text',
        required: true,
        placeholder: '在 pushplus.plus 首页登录后复制',
      },
      {
        key: 'topic',
        label: '群组编码',
        type: 'text',
        placeholder: '选填，一对多推送时用',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['token']);
      const res = await postJson('https://www.pushplus.plus/send', {
        token: config.token,
        title: msg.title,
        content: toHtml(msg),
        template: 'html',
        topic: config.topic || undefined,
      });
      if (res.json && Number(res.json.code) === 200) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.json?.msg || res.text.slice(0, 200)}`);
    },
  },

  // ----------------------------------------------------------
  // 8. Server 酱
  // ----------------------------------------------------------
  {
    type: 'serverchan',
    label: 'Server 酱',
    tagline: '老牌微信推送服务，SendKey 在 sct.ftqq.com 获取。',
    docs: 'https://sct.ftqq.com',
    badge: '微信',
    fields: [
      {
        key: 'sendkey',
        label: 'SendKey',
        type: 'text',
        required: true,
        placeholder: 'SCTxxxxxxxxxxxxxxxx',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['sendkey']);
      const key = config.sendkey.trim().replace(/^sctp?/i, '');
      const res = await requestJson(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          title: msg.title,
          desp: toMarkdown(msg),
        }).toString(),
      });
      const code = res.json?.code ?? res.json?.data?.code;
      if (Number(code) === 0) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.json?.message || res.text.slice(0, 200)}`);
    },
  },

  // ----------------------------------------------------------
  // 9. Telegram
  // ----------------------------------------------------------
  {
    type: 'telegram',
    label: 'Telegram',
    tagline: '找 @BotFather 建个机器人拿 Token，再找 @userinfobot 查自己的 Chat ID。',
    docs: 'https://core.telegram.org/bots',
    badge: '海外',
    fields: [
      {
        key: 'botToken',
        label: 'Bot Token',
        type: 'text',
        required: true,
        placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      },
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: '123456789',
        help: '注意：Chat ID 前面要带 - 的是群组，个人是纯数字。',
      },
      {
        key: 'apiBase',
        label: 'API 地址',
        type: 'text',
        placeholder: 'https://api.telegram.org',
        default: 'https://api.telegram.org',
        help: '国内网络不通时，填自建反代地址。',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['botToken', 'chatId']);
      const base = trimSlash(config.apiBase || 'https://api.telegram.org');
      const res = await postJson(
        `${base}/bot${config.botToken}/sendMessage`,
        {
          chat_id: config.chatId,
          text: toPlainText(msg),
          disable_web_page_preview: true,
        },
      );
      if (res.json?.ok) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.json?.description || res.text.slice(0, 200)}`);
    },
  },

  // ----------------------------------------------------------
  // 10. Gotify（自建）
  // ----------------------------------------------------------
  {
    type: 'gotify',
    label: 'Gotify（自建）',
    tagline: '完全自托管的推送服务，数据不出自己的服务器。',
    docs: 'https://gotify.net',
    badge: '自建',
    fields: [
      {
        key: 'server',
        label: '服务器地址',
        type: 'text',
        required: true,
        placeholder: 'https://gotify.example.com',
      },
      {
        key: 'token',
        label: '应用 Token',
        type: 'text',
        required: true,
        placeholder: '在 Gotify 后台 Apps 里创建',
      },
      {
        key: 'priority',
        label: '优先级',
        type: 'number',
        default: '5',
        placeholder: '5',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['server', 'token']);
      const res = await postJson(
        `${trimSlash(config.server)}/message?token=${encodeURIComponent(config.token)}`,
        {
          title: msg.title,
          message: msg.body || '',
          priority: Number(config.priority) || 5,
        },
      );
      if (res.ok && res.json?.id) return { ok: true, detail: '推送成功' };
      throw new Error(`推送失败：${res.text.slice(0, 200) || `HTTP ${res.status}`}`);
    },
  },

  // ----------------------------------------------------------
  // 11. 通用 Webhook
  // ----------------------------------------------------------
  {
    type: 'webhook',
    label: '自定义 Webhook',
    tagline: 'POST 一段 JSON 到你自己的地址。想接什么都能接，比如自己写的小程序、IFTTT、HomeAssistant。',
    docs: '',
    badge: 'DIY',
    fields: [
      {
        key: 'url',
        label: '地址',
        type: 'text',
        required: true,
        placeholder: 'https://example.com/hook',
      },
      {
        key: 'method',
        label: '请求方法',
        type: 'select',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'GET', label: 'GET' },
        ],
        default: 'POST',
      },
      {
        key: 'headers',
        label: '额外请求头',
        type: 'text',
        placeholder: 'Authorization: Bearer xxx',
        help: '选填。多行用 | 分隔。',
      },
      {
        key: 'bodyTemplate',
        label: '请求体模板',
        type: 'text',
        placeholder: '{"text":"{{title}}\\n{{body}}"}',
        help: '选填。可用变量：{{title}} {{body}} {{url}} {{firedAt}}。留空则发送标准 JSON。',
      },
    ],
    async send(config, msg) {
      requireFields(config, ['url']);
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };

      if (config.headers) {
        for (const line of String(config.headers).split(/[|\n]/)) {
          const idx = line.indexOf(':');
          if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }

      if (config.bodyTemplate && config.bodyTemplate.trim()) {
        const rendered = config.bodyTemplate
          .replace(/\{\{title\}\}/g, msg.title)
          .replace(/\{\{body\}\}/g, msg.body || '')
          .replace(/\{\{url\}\}/g, msg.url || '')
          .replace(/\{\{firedAt\}\}/g, new Date().toISOString());
        const res = await requestJson(config.url, {
          method: config.method || 'POST',
          headers,
          body: rendered,
        });
        if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
        throw new Error(`推送失败：HTTP ${res.status} ${res.text.slice(0, 200)}`);
      }

      const payload = {
        title: msg.title,
        body: msg.body || '',
        url: msg.url || '',
        firedAt: new Date().toISOString(),
      };

      if ((config.method || 'POST') === 'GET') {
        const u = new URL(config.url);
        for (const [k, v] of Object.entries(payload)) u.searchParams.set(k, v);
        const res = await requestJson(u.toString(), { method: 'GET', headers });
        if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
        throw new Error(`推送失败：HTTP ${res.status}`);
      }

      const res = await postJson(config.url, payload);
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
      throw new Error(`推送失败：HTTP ${res.status} ${res.text.slice(0, 200)}`);
    },
  },
];

/** type -> 渠道定义 */
export const CHANNEL_MAP = new Map(CHANNELS.map((c) => [c.type, c]));

export function getChannelDef(type) {
  return CHANNEL_MAP.get(type) || null;
}

/** 面向设置页的清单（去掉 send / normalize 函数，不能序列化进 HTML/JSON） */
export function channelCatalog() {
  return CHANNELS.map((c) => ({
    type: c.type,
    label: c.label,
    tagline: c.tagline,
    docs: c.docs || '',
    badge: c.badge || '',
    fields: c.fields || [],
    guide: c.guide || '',
  }));
}
