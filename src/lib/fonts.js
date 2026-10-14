/**
 * 系统里的中文字体。
 *
 * 为什么要有这个文件：PPT 转 PDF 是**用服务器上装了的字体**来画字的。
 * 云服务器的精简镜像里几乎不带任何中文字体，于是转出来的 PDF 里中文
 * 会变成方框或者乱码 —— 而文件本身是好的、转换也「成功」了，
 * 所以没有任何报错，只有人眼能看出来。
 *
 * 这是「纯文本环境」和「桌面环境」的经典差异：在 Windows / macOS 上
 * 永远遇不到（系统自带中文字体），一到 Linux 服务器就冒出来。
 */

import { execSync } from 'node:child_process';
import { readZip } from './zip.js';

let cached;

/** 清掉缓存（测试用） */
export function resetFontCache() {
  cached = undefined;
}

/**
 * 从 `fc-list :lang=zh family` 的输出里解析出字体族名。
 *
 * 抽成纯函数是为了能直接测：真实环境要验「装了字体」这一格，
 * 而这一格没法在测试里靠装字体来复现。
 *
 * fc-list 的每一行是一个字体，同族的不同语言名之间用逗号分隔，例如：
 *   Noto Sans CJK SC
 *   WenQuanYi Micro Hei,WenQuanYi Micro Hei Mono,文泉驿微米黑
 *
 * @returns {string[]} 去重后的族名
 */
export function parseCjkFontFamilies(output) {
  return [...new Set(
    String(output || '')
      .split('\n')
      .flatMap((line) => line.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )];
}

/**
 * 系统里有没有能显示中文的字体。
 *
 * @returns {{ok:boolean, skipped:boolean, reason:string, families:string[]}}
 *   ok      有中文字体（或者这个平台不需要查）
 *   skipped 这台机器不用查（非 Linux 系统自带中文字体）
 *   reason  'ok' | 'not-linux' | 'no-cjk-font' | 'fc-list-unavailable'
 */
export function cjkFontStatus() {
  if (cached) return cached;

  // Windows / macOS 自带中文字体，不用查也不该报警
  if (process.platform !== 'linux') {
    cached = { ok: true, skipped: true, reason: 'not-linux', families: [] };
    return cached;
  }

  let out = '';
  try {
    // :lang=zh 让 fontconfig 只列出覆盖中文的字体，不用我们自己猜哪个能显示中文
    out = execSync('fc-list :lang=zh family', {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (err) {
    // fc-list 都不在（fontconfig 没装）—— 这同样是「没有中文字体」，
    // 而且这种情况下 LibreOffice 也画不出中文，所以按缺字体处理
    cached = {
      ok: false,
      skipped: false,
      reason: 'fc-list-unavailable',
      families: [],
      detail: err.message,
    };
    return cached;
  }

  const families = parseCjkFontFamilies(out);
  cached = families.length
    ? { ok: true, skipped: false, reason: 'ok', families }
    : { ok: false, skipped: false, reason: 'no-cjk-font', families: [] };
  return cached;
}

/**
 * 装中文字体的命令（给用户复制的）。
 *
 * 只放**确定存在于 Ubuntu / Debian 仓库**的包名：一条 apt 命令里只要有一个
 * 包名不存在，整条命令就全都不装 —— 那种失败方式比缺字体更难查。
 * 想要宋体更像原件，可以另外单独补 `fonts-noto-cjk-extra`。
 */
export const CJK_FONT_INSTALL_HINT =
  'sudo apt install -y fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei';

// ============================================================
// 课件引用的字体 vs 这台机器上有的字体
// ============================================================

/**
 * 为什么还需要这一套（上面那个 cjkFontStatus 不够）：
 *
 * 它只问「有没有能显示中文的字体」，用的是 `fc-list :lang=zh` ——
 * 那个过滤**只列出覆盖中文的字体**，所以符号字体（Wingdings 之类）和
 * 西文字体（Calibri、Arial）它一个都看不到。
 *
 * 而「PPT 里的箭头变成方框」和「排版部分错位」正好出在这两类字体上：
 *   · 箭头常常是 **Wingdings 私用区字符**（U+F0xx）。找不到那个字体时，
 *     没有任何字体能提供那个字形 → 画成方框。
 *   · 排版错位是**字体替换**的后果：找不到 Calibri 就换一个别的，
 *     字宽不一样，于是换行、对齐、溢出全跟着变。
 *
 * 这一套做的是：把课件**实际引用了哪些字体**读出来，再和这台机器上有什么、
 * fontconfig 会拿什么替代，逐个对一遍 —— 这样才知道该装哪一个包，
 * 而不是把一堆字体全装上碰运气。
 */

/** 度量兼容（metric-compatible）的免费替代：换上去**排版不会变** */
export const METRIC_COMPATIBLE = [
  { from: /^arial( black)?$/i, to: 'liberation sans' },
  { from: /^times new roman$/i, to: 'liberation serif' },
  { from: /^courier new$/i, to: 'liberation mono' },
  { from: /^calibri( light)?$/i, to: 'carlito' },
  { from: /^cambria( math)?$/i, to: 'caladea' },
];

/**
 * 常见缺失字体的安装建议。
 *
 * ⚠️ Wingdings / Webdings / 微软雅黑 这类是**微软的商用字体**，
 *    没有免费的等价替代 —— 不能一句「apt install 就好了」糊过去。
 *    对这类只能如实说清：要么把字体本体放到服务器上（注意授权），
 *    要么改课件。这一点必须写进建议里，否则用户会一直找那个不存在的包。
 */
export const FONT_HINTS = [
  {
    match: /^(wingdings|webdings|marlett|symbol)/i,
    packages: [],
    note: '这是微软的符号字体（箭头、项目符号常常来自它），没有免费的等价替代。'
      + 'LibreOffice 一般会用自带的 OpenSymbol 兜底，多数箭头能出来；'
      + '少数仍会变方框 —— 那种情况只能改课件本身（把箭头换成真正的图形或 Unicode 箭头）。',
  },
  {
    match: /^(微软雅黑|microsoft yahei)/i,
    packages: ['fonts-wqy-microhei'],
    note: '没有度量兼容的免费替代：装文泉驿微米黑只是"能显示"，排版仍会和原件有出入。',
  },
  {
    match: /^(宋体|simsun|新宋体|nsimsun)/i,
    packages: ['fonts-arphic-uming'],
    note: '近似替代，不是度量兼容，排版会有出入。',
  },
  {
    match: /^(黑体|simhei|等线|dengxian|方正)/i,
    packages: ['fonts-wqy-zenhei'],
    note: '近似替代，不是度量兼容，排版会有出入。',
  },
  {
    match: /^(arial|times new roman|courier new)/i,
    packages: ['fonts-liberation'],
    note: 'Liberation 系列是**度量兼容**的，装上去排版不会变。',
  },
  { match: /^calibri/i, packages: ['fonts-crosextra-carlito'], note: 'Carlito 是度量兼容替代。' },
  { match: /^cambria/i, packages: ['fonts-crosextra-caladea'], note: 'Caladea 是度量兼容替代。' },
  {
    match: /^.+$/,
    packages: ['fonts-noto-cjk'],
    note: '先装 Noto CJK 兜底；如果排版仍不对，说明这份课件用了上面没列到的字体。',
  },
];

/** 给某个缺失的字体名配一条建议 */
export function installHintFor(name) {
  const n = String(name || '').trim();
  for (const h of FONT_HINTS) {
    if (h.match.test(n)) return h;
  }
  return null;
}

/**
 * 从一个 Office 文件里读出它**引用了哪些字体**（纯函数，不依赖系统环境）。
 *
 * 三种格式的写法不一样，都要认：
 *   · pptx（DrawingML）：`<a:latin typeface="Calibri"/>`，项目符号还有 `<a:sym>`
 *   · docx（WordprocessingML）：`w:ascii="Calibri"` / `w:eastAsia="宋体"`
 *   · xlsx：`<rFont val="Calibri"/>`
 *
 * ⚠️ 主题字体引用（`+mn-lt`、`+mj-ea` 这种）要**跳过**：那不是字体名，它指向
 *    theme1.xml 里的实际字体名，而主题文件本身也会被扫到 —— 照原样收集的话，
 *    会多出一串「+mn-lt」被当成缺失字体报出来。
 *
 * @param {Buffer|Uint8Array} buffer Office 文件内容
 * @returns {string[]} 去重后的字体名（保持出现顺序）
 */
export function referencedFontsFromBuffer(buffer) {
  const zip = readZip(buffer);
  const found = [];
  const seen = new Set();

  const add = (raw) => {
    const name = String(raw ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .trim();
    if (!name) return;
    if (name.startsWith('+')) return;        // 主题引用，不是字体名
    if (seen.has(name)) return;
    seen.add(name);
    found.push(name);
  };

  for (const entry of zip.list()) {
    // 只看内容部件（关系、媒体那些又大又没有字体信息）
    if (!/\.xml$/i.test(entry)) continue;
    if (!/(slides?|slideLayouts?|slideMasters?|theme|document|styles|header|footer|charts?|sharedStrings|worksheets?|drawings?|notesSlides?)/i.test(entry)) continue;

    let text;
    try {
      text = zip.readText(entry);
    } catch {
      continue;   // 单个部件读坏了不该让整件事失败
    }
    if (!text) continue;

    for (const m of text.matchAll(/typeface="([^"]*)"/g)) add(m[1]);
    for (const m of text.matchAll(/\bw:(?:ascii|eastAsia|hAnsi|cs)="([^"]*)"/g)) add(m[1]);
    for (const m of text.matchAll(/<rFont\s+val="([^"]*)"/g)) add(m[1]);
  }
  return found;
}

/**
 * 把「课件里请求的字体」和「fontconfig 实际会用的字体」对一下，判断属于哪种情况。
 *
 * 抽成纯函数是为了能直接测：真实结论要在一台装/没装字体的机器上才复现得了，
 * 而这里只要给一组"替代结果"就能把几种情况都钉住。
 *
 * @param {string} requested 课件里写的字体名
 * @param {string[]} resolvedFamilies fontconfig 说它会用的字体族
 * @returns {{requested:string, status:'exact'|'metric'|'substituted'|'missing', resolved:string}}
 */
export function classifyFont(requested, resolvedFamilies) {
  const req = String(requested || '').trim();
  const list = (resolvedFamilies || []).map((s) => String(s || '').trim()).filter(Boolean);
  const lower = list.map((s) => s.toLowerCase());
  const reqLower = req.toLowerCase();

  // ① 精确命中：fontconfig 给出的就是同名的字体
  if (reqLower && lower.some((s) => s === reqLower || s.includes(reqLower))) {
    return { requested: req, status: 'exact', resolved: list[0] || '' };
  }

  // ② 度量兼容替代：换上去排版不会变，算「没问题」
  for (const rule of METRIC_COMPATIBLE) {
    if (rule.from.test(req) && lower.some((s) => s.includes(rule.to))) {
      return { requested: req, status: 'metric', resolved: list[0] || '' };
    }
  }

  // ③ 被别的字体顶替了 → 排版会变（这是"格式混乱"的来源）
  //    ④ 连替代都算不上 → 基本等于没这个字体（这是"方框"的来源）
  return {
    requested: req,
    status: list.length ? 'substituted' : 'missing',
    resolved: list[0] || '',
  };
}

/**
 * fontconfig 会拿什么字体来渲染这个名字。
 *
 * ⚠️ `fc-match` **永远**会返回一个字体（找不到就兜底到默认字体），
 *    所以光看"有没有返回值"判断不出缺失 —— 必须把返回的族名和请求的名字
 *    比一遍，那正是 classifyFont 在做的事。
 *
 * @returns {string[]} 字体族名；非 Linux 或没有 fontconfig 时返回空数组
 */
export function resolveFontFamilies(name) {
  if (process.platform !== 'linux') return [];
  try {
    const out = execSync(`fc-match --format='%{family}' ${JSON.stringify(String(name))}`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return String(out || '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 把一份 Office 文件的字体情况查一遍。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{resolve?: (name:string)=>string[]}} [opts] resolve 可注入（测试用）
 */
export function fontCheckForBuffer(buffer, opts = {}) {
  const resolve = opts.resolve || resolveFontFamilies;
  const referenced = referencedFontsFromBuffer(buffer);
  const rows = referenced.map((name) => classifyFont(name, resolve(name)));
  return {
    referenced,
    rows,
    // 需要用户处理的：被顶替的（排版会变）+ 干脆没有的（会变方框）
    problems: rows.filter((r) => r.status === 'substituted' || r.status === 'missing'),
  };
}
