/**
 * ics.js —— 零第三方依赖的 iCalendar (RFC 5545) 解析 / 生成 / 重复规则展开模块。
 *
 * 设计要点：
 * - 纯函数优先：坏数据一律记入 `warnings` 或直接跳过，绝不抛未捕获异常。
 * - 折行 (line folding) 按「字节」处理（UTF-8），避免中文被切断产生乱码。
 * - 时间统一使用「墙上时间」字符串：定时事件为 'YYYY-MM-DDTHH:mm:ss'，全天事件为 'YYYY-MM-DD'。
 *   （墙上时间 = 该事件在其 TZID 时区里表的钟面时间，不带时区后缀，便于直接展示）
 * - 时区使用内置固定偏移表；America/New_York 等带夏令时的时区用简化 DST 规则近似处理，
 *   并在 warnings 中明确说明；未知 TZID 按本地时间原样保留并记 warning。
 *
 * @module src/lib/ics
 */

/** iCalendar 行尾符 */
const CRLF = '\r\n';
/** 默认目标时区（UTC 值换算、重复展开比较时使用） */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 折行后每行最大字节数（不含 CRLF），RFC5545 建议 75，续行首字符为空格 */
const FOLD_LIMIT = 75;
/** 定时事件在缺少结束时间时的默认时长（毫秒，1 小时） */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. 时区表与偏移计算
// ---------------------------------------------------------------------------

/**
 * 内置时区偏移表。`offset` 为标准时间偏移（分钟）；
 * `dst` + `rule` 表示该时区存在夏令时，我们按简化规则近似处理（rule: 'US' | 'EU'）。
 * 表中未列出的时区视为未知，按本地时间原样保留并记 warning。
 */
const TZ_TABLE = {
  // —— 无夏令时的固定偏移时区 ——
  UTC: { offset: 0 },
  'Etc/UTC': { offset: 0 },
  GMT: { offset: 0 },
  'Etc/GMT': { offset: 0 },
  'Asia/Shanghai': { offset: 480 },
  'Asia/Chongqing': { offset: 480 },
  'Asia/Harbin': { offset: 480 },
  PRC: { offset: 480 },
  'Asia/Hong_Kong': { offset: 480 },
  'Asia/Macau': { offset: 480 },
  'Asia/Taipei': { offset: 480 },
  'Asia/Singapore': { offset: 480 },
  'Asia/Kuala_Lumpur': { offset: 480 },
  'Asia/Manila': { offset: 480 },
  'Asia/Tokyo': { offset: 540 },
  Japan: { offset: 540 },
  'Asia/Seoul': { offset: 540 },
  'Asia/Pyongyang': { offset: 540 },
  'Asia/Bangkok': { offset: 420 },
  'Asia/Jakarta': { offset: 420 },
  'Asia/Ho_Chi_Minh': { offset: 420 },
  'Asia/Kolkata': { offset: 330 },
  'Asia/Calcutta': { offset: 330 },
  'Asia/Kathmandu': { offset: 345 },
  'Asia/Dhaka': { offset: 360 },
  'Asia/Karachi': { offset: 300 },
  'Asia/Dubai': { offset: 240 },
  'Asia/Istanbul': { offset: 180 },
  'Europe/Moscow': { offset: 180 },
  'Europe/Athens': { offset: 120 },
  'Europe/Helsinki': { offset: 120 },
  'Europe/Bucharest': { offset: 120 },
  'Africa/Cairo': { offset: 120 },
  'Africa/Johannesburg': { offset: 120 },
  'Africa/Nairobi': { offset: 180 },
  'Africa/Lagos': { offset: 60 },
  'America/Phoenix': { offset: -420 },
  'America/Sao_Paulo': { offset: -180 },
  'Australia/Sydney': { offset: 600 },
  'Australia/Melbourne': { offset: 600 },
  'Australia/Brisbane': { offset: 600 },
  'Australia/Perth': { offset: 480 },
  'Pacific/Auckland': { offset: 720 },
  // —— 带夏令时（简化规则）——
  'Europe/London': { offset: 0, dst: 60, rule: 'EU' },
  'Europe/Dublin': { offset: 0, dst: 60, rule: 'EU' },
  'Europe/Lisbon': { offset: 0, dst: 60, rule: 'EU' },
  'Europe/Paris': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Berlin': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Madrid': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Rome': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Amsterdam': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Brussels': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Vienna': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Prague': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Warsaw': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Stockholm': { offset: 60, dst: 120, rule: 'EU' },
  'Europe/Zurich': { offset: 60, dst: 120, rule: 'EU' },
  'America/New_York': { offset: -300, dst: -240, rule: 'US' },
  'America/Toronto': { offset: -300, dst: -240, rule: 'US' },
  'America/Chicago': { offset: -360, dst: -300, rule: 'US' },
  'America/Denver': { offset: -420, dst: -360, rule: 'US' },
  'America/Los_Angeles': { offset: -480, dst: -420, rule: 'US' },
};

/** 大小写不敏感索引：tzid(lowercase) -> 时区定义 */
const TZ_INDEX = new Map(
  Object.entries(TZ_TABLE).map(([id, def]) => [id.toLowerCase(), { id, ...def }]),
);

/** Windows 时区名等常见别名 */
const TZ_ALIASES = {
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Paris',
  utc: 'UTC',
  gmt: 'UTC',
};

/** 某年某月（1-12）的天数 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 计算某月第 n 个（n>0 从前数，n<0 从后数）星期几是几号。
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} jsWeekday 0=周日 … 6=周六
 * @param {number} n 序号，如 1 表示第一个、-1 表示最后一个
 * @returns {number|null} 几号；不存在时返回 null
 */
function nthWeekdayOfMonth(year, month, jsWeekday, n) {
  const dim = daysInMonth(year, month);
  if (n > 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((jsWeekday - firstDow + 7) % 7) + (n - 1) * 7;
    return day <= dim ? day : null;
  }
  const lastDow = new Date(Date.UTC(year, month - 1, dim)).getUTCDay();
  const day = dim - ((lastDow - jsWeekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
}

/** 判断某个 UTC 时刻是否处于（简化）夏令时期间 */
function isDst(rule, utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  if (rule === 'US') {
    // 3 月第二个周日 02:00 本地标准时间 ～ 11 月第一个周日 02:00 本地夏令时
    const startDay = nthWeekdayOfMonth(year, 3, 0, 2);
    const endDay = nthWeekdayOfMonth(year, 11, 0, 1);
    // 02:00 EST = 07:00Z；02:00 EDT = 06:00Z
    const start = Date.UTC(year, 2, startDay, 7, 0, 0);
    const end = Date.UTC(year, 10, endDay, 6, 0, 0);
    return utcMs >= start && utcMs < end;
  }
  if (rule === 'EU') {
    // 3 月最后一个周日 01:00 UTC ～ 10 月最后一个周日 01:00 UTC
    const startDay = nthWeekdayOfMonth(year, 3, 0, -1);
    const endDay = nthWeekdayOfMonth(year, 10, 0, -1);
    const start = Date.UTC(year, 2, startDay, 1, 0, 0);
    const end = Date.UTC(year, 9, endDay, 1, 0, 0);
    return utcMs >= start && utcMs < end;
  }
  return false;
}

/** 规整 TZID：去掉引号、前缀斜杠、空白 */
function normalizeTzid(tzid) {
  if (tzid === null || tzid === undefined) return null;
  let s = String(tzid).trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).trim();
  if (s.startsWith('/')) s = s.slice(1).trim();
  return s === '' ? null : s;
}

/**
 * 查询时区在某个 UTC 时刻的偏移。
 * @param {string} tzid
 * @param {number} utcMs UTC 毫秒时间戳
 * @returns {{ offset: number, id: string|null, known: boolean, approximate: boolean }}
 */
function timezoneInfo(tzid, utcMs) {
  const id = normalizeTzid(tzid);
  if (!id) return { offset: 0, id: null, known: true, approximate: false };
  const lower = id.toLowerCase();
  let def = TZ_INDEX.get(lower);
  if (!def && TZ_ALIASES[lower]) def = TZ_INDEX.get(TZ_ALIASES[lower].toLowerCase());
  if (!def) {
    // 未知时区：按本地时间处理（偏移 0，即不做换算）
    return { offset: 0, id, known: false, approximate: false };
  }
  if (def.rule) {
    const dstNow = isDst(def.rule, Number.isFinite(utcMs) ? utcMs : Date.now());
    return {
      offset: dstNow ? def.dst : def.offset,
      id: def.id,
      known: true,
      approximate: true,
    };
  }
  return { offset: def.offset, id: def.id, known: true, approximate: false };
}

// ---------------------------------------------------------------------------
// 2. 基础工具：折行 / 展开 / 转义
// ---------------------------------------------------------------------------

/** 单字符（码点）的 UTF-8 字节长度 */
function utf8ByteLength(str) {
  let bytes = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes += 1;
    else if (cp < 0x800) bytes += 2;
    else if (cp < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 按 RFC5545 规则折行：每行不超过 75 字节，续行以空格开头。
 * 完全按 UTF-8 字节切割，绝不会把一个多字节字符切开。
 * @param {string} line 逻辑行（不含换行）
 * @returns {string} 折行后的文本（内部含 CRLF + 空格）
 */
function foldLine(line) {
  const text = String(line ?? '');
  if (utf8ByteLength(text) <= FOLD_LIMIT) return text;
  const chunks = [];
  let current = '';
  let bytes = 0;
  let limit = FOLD_LIMIT; // 首行 75 字节，续行含前导空格共 75 字节
  for (const ch of text) {
    const chBytes = utf8ByteLength(ch);
    if (bytes + chBytes > limit) {
      chunks.push(current);
      current = '';
      bytes = 0;
      limit = FOLD_LIMIT - 1;
    }
    current += ch;
    bytes += chBytes;
  }
  chunks.push(current);
  return chunks.join(`${CRLF} `);
}

/**
 * 展开 iCalendar 文本为逻辑行：处理 BOM、CRLF/LF/CR 混用与折行续行。
 * @param {string|Buffer} text iCalendar 文本
 * @param {string[]} [warnings] 可选，收集折行异常等告警（中文）
 * @returns {string[]} 逻辑行数组（已去掉空行）
 */
export function unfoldLines(text, warnings) {
  const warn = (msg) => {
    if (Array.isArray(warnings)) warnings.push(msg);
  };
  if (text === null || text === undefined) return [];
  let str;
  if (typeof text === 'string') str = text;
  else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(text)) str = text.toString('utf8');
  else str = String(text);
  if (str.length === 0) return [];
  if (str.charCodeAt(0) === 0xfeff) {
    str = str.slice(1); // 去掉 UTF-8 BOM
    warn('已忽略文件开头的 UTF-8 BOM');
  }
  const physical = str.split(/\r\n|\n|\r/);
  /** @type {string[]} */
  const logical = [];
  for (const line of physical) {
    const isContinuation = line.length > 0 && (line[0] === ' ' || line[0] === '\t');
    if (isContinuation) {
      if (logical.length === 0) {
        warn('文件以折行续行开头，已忽略该行');
        continue;
      }
      logical[logical.length - 1] += line.slice(1);
      continue;
    }
    if (line.trim() === '') continue; // 空行无意义，直接跳过
    logical.push(line);
  }
  return logical;
}

/**
 * 转义 iCalendar 文本值（TEXT 类型）：\ ; , 与换行。
 * 注意：RFC5545 规定换行统一用 \n 表示，因此 CRLF / CR / LF 都会被规整为 \n
 * （这是标准行为，反转义后回车符不会单独还原）。
 * @param {*} s 任意值（null/undefined 视为空串）
 * @returns {string}
 */
export function escapeText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * 反转义 iCalendar 文本值：\n / \N -> 换行，\; \, \\ 还原，未知转义去掉反斜杠。
 * 与 {@link escapeText} 互为逆运算（换行统一还原为 \n）。
 * @param {*} s
 * @returns {string}
 */
export function unescapeText(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === undefined) {
      out += '\\'; // 末尾孤立的反斜杠
      break;
    }
    if (next === 'n' || next === 'N') out += '\n';
    else out += next; // \\ \; \, 以及未知转义
    i += 1;
  }
  return out;
}

/** 按未转义的分隔符切分（用于 CATEGORIES、EXDATE 多值等） */
function splitUnescaped(str, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      cur += ch + str[i + 1];
      i += 1;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// 3. 墙上时间与日期工具
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const pad4 = (n) => String(n).padStart(4, '0');

/** 'YYYY-MM-DD' -> UTC 毫秒（仅用于日期算术，不涉及时区语义） */
function dateStrToUtcMs(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC 毫秒 -> 'YYYY-MM-DD' */
function utcMsToDateStr(ms) {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 日期加减天数，返回 'YYYY-MM-DD' */
function addDays(dateStr, days) {
  const ms = dateStrToUtcMs(dateStr);
  if (Number.isNaN(ms)) return null;
  return utcMsToDateStr(ms + days * 86400000);
}

/** 两个日期字符串相差的天数（b - a） */
function daysBetween(a, b) {
  return Math.round((dateStrToUtcMs(b) - dateStrToUtcMs(a)) / 86400000);
}

/** iCalendar 星期名（MO..SU，索引 0=周一） */
const WEEKDAY_NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_INDEX = new Map(WEEKDAY_NAMES.map((n, i) => [n, i]));

/**
 * 解析星期名 -> 索引（0=MO … 6=SU），自动忽略 BYDAY 的序号前缀（如 '1MO'、'-1FR'）。
 * @returns {number} 无法识别返回 -1
 */
function weekdayIndexOf(name) {
  const s = String(name ?? '').trim().toUpperCase().replace(/^[+-]?\d+/, '');
  return WEEKDAY_INDEX.has(s) ? WEEKDAY_INDEX.get(s) : -1;
}

/** 'YYYY-MM-DD' 的 iCalendar 星期索引（0=MO … 6=SU） */
function icalWeekday(dateStr) {
  const ms = dateStrToUtcMs(dateStr);
  if (Number.isNaN(ms)) return -1;
  const js = new Date(ms).getUTCDay(); // 0=周日
  return (js + 6) % 7;
}

/** 以 wkst 为一周起点，返回 dateStr 所在周的周一（相对起点）日期 */
function startOfWeek(dateStr, wkstIndex) {
  const cur = icalWeekday(dateStr);
  if (cur < 0) return null;
  const delta = (cur - wkstIndex + 7) % 7;
  return addDays(dateStr, -delta);
}

/** 一天中的毫秒数（取自墙上时间） */
function timeOfDayMs(wall) {
  if (!wall || !wall.time) return 0;
  const [h, mi, s] = wall.time.split(':').map(Number);
  return ((h * 60 + mi) * 60 + s) * 1000;
}

/** 墙上时间 -> 「墙上纪元毫秒」（把钟面时间当作 UTC 计算的毫秒数，仅用于比较/加减） */
function wallToEpoch(wall) {
  const base = dateStrToUtcMs(wall.date);
  if (Number.isNaN(base)) return NaN;
  return base + timeOfDayMs(wall);
}

/** 墙上纪元毫秒 -> 'YYYY-MM-DDTHH:mm:ss' */
function wallEpochToDateTime(ms) {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** UTC 毫秒 -> 'YYYYMMDDTHHmmssZ' */
function formatUtcStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${pad4(d.getUTCFullYear())}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(
    d.getUTCHours(),
  )}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/**
 * 解析墙上时间字符串。
 * @param {string} value 'YYYY-MM-DD' | 'YYYY-MM-DDTHH:mm[:ss]' | 'YYYYMMDD[THHmmss]'
 * @returns {{date:string,time:string|null,allDay:boolean}|null} 无法解析返回 null
 */
function parseWall(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const Y = Number(y);
  const Mo = Number(mo);
  const D = Number(d);
  if (Mo < 1 || Mo > 12 || D < 1 || D > daysInMonth(Y, Mo)) return null;
  if (h === undefined) return { date: `${y}-${mo}-${d}`, time: null, allDay: true };
  const H = Number(h);
  const Mi = Number(mi);
  const S = Number(sec ?? '00');
  if (H > 23 || Mi > 59 || S > 59) return null;
  return { date: `${y}-${mo}-${d}`, time: `${pad2(H)}:${pad2(Mi)}:${pad2(S)}`, allDay: false };
}

// ---------------------------------------------------------------------------
// 4. 面向外部的日期函数
// ---------------------------------------------------------------------------

/**
 * 把 Date（或墙上时间字符串）格式化为 iCalendar 日期/时间值（不带 Z，表示墙上时间）。
 * @param {Date|string|number} date 时间对象；字符串会被规整为紧凑格式
 * @param {{allDay?: boolean}} [options] allDay 为 true 时只输出日期
 * @returns {string} 'YYYYMMDD' 或 'YYYYMMDDTHHmmss'；无法解析返回 ''
 */
export function formatIcsDate(date, options = {}) {
  const allDay = options.allDay === true;
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) return '';
    // 取本地时间分量：Date 代表一个时刻，输出它在本机时区的钟面时间
    const y = pad4(date.getFullYear());
    const mo = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    if (allDay) return `${y}${mo}${d}`;
    return `${y}${mo}${d}T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  }
  const wall = parseWall(typeof date === 'number' ? new Date(date) : date) ?? null;
  if (!wall) {
    if (typeof date === 'number') return formatIcsDate(new Date(date), options);
    return '';
  }
  const compactDate = wall.date.replace(/-/g, '');
  if (allDay || wall.time === null) return compactDate;
  return `${compactDate}T${wall.time.replace(/:/g, '')}`;
}

/**
 * 解析 iCalendar 日期/时间属性值，统一成墙上时间字符串。
 * - `VALUE=DATE` 或 8 位纯数字 -> 全天事件，返回 'YYYY-MM-DD'
 * - 以 Z 结尾的 UTC 值 -> 用 TZID（缺省 Asia/Shanghai）换算成墙上时间
 * - 带 TZID 的本地值 -> 原样保留
 * @param {string} value 属性值，如 '20240902T080000'、'20240902T000000Z'、'20240902'
 * @param {Object|string} [params] 属性参数对象（键不区分大小写，含 TZID / VALUE），或原始参数字符串
 * @returns {{value: string, allDay: boolean}}
 */
export function parseIcsDateValue(value, params) {
  const parsed = parseDateValueDetailed(value, normalizeParams(params), DEFAULT_TIMEZONE, null);
  return { value: parsed.value, allDay: parsed.allDay };
}

/** 把参数（对象或字符串）规整成大写键的对象 */
function normalizeParams(params) {
  if (!params) return {};
  if (typeof params === 'string') {
    const out = {};
    for (const piece of params.split(';')) {
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      out[piece.slice(0, eq).trim().toUpperCase()] = piece.slice(eq + 1).trim().replace(/^"|"$/g, '');
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(params)) out[String(k).toUpperCase()] = v;
  return out;
}

/**
 * 解析日期值的内部实现（额外返回告警与是否解析成功）。
 * @returns {{value:string, allDay:boolean, parsed:boolean, warning:string|null, tzid:string|null}}
 */
function parseDateValueDetailed(value, params, defaultTz, warnings) {
  const p = params || {};
  const tzid = normalizeTzid(p.TZID);
  const raw = String(value ?? '').trim();
  const fail = (msg) => {
    if (Array.isArray(warnings) && msg) warnings.push(msg);
    return { value: raw, allDay: false, parsed: false, warning: msg || null, tzid };
  };
  if (raw === '') return fail('日期属性值为空');

  // 纯日期（全天事件）
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  if (m) {
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (parseWall(day) === null) return fail(`无效的日期值 "${raw}"`);
    return { value: day, allDay: true, parsed: true, warning: null, tzid };
  }

  // 日期 + 时间
  m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})?(Z)?$/i.exec(raw);
  if (!m) return fail(`无法识别的日期值 "${raw}"，已忽略该属性`);
  const [, Y, Mo, D, H, Mi, S, Z] = m;
  const second = Number(S ?? '00');
  const localWall = `${Y}-${Mo}-${D}T${pad2(Number(H))}:${pad2(Number(Mi))}:${pad2(second)}`;
  if (parseWall(localWall) === null) return fail(`无效的日期值 "${raw}"`);

  if (Z) {
    // UTC 值：换算到目标时区（TZID 优先，否则用默认时区）的墙上时间
    const targetTz = tzid || defaultTz || DEFAULT_TIMEZONE;
    const instant = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), second);
    const info = timezoneInfo(targetTz, instant);
    if (!info.known && Array.isArray(warnings)) {
      warnings.push(`未知时区 "${targetTz}"，UTC 时间按零偏移处理（可能与实际不符）`);
    } else if (info.approximate && Array.isArray(warnings)) {
      warnings.push(`时区 "${info.id}" 使用内置简化夏令时规则近似处理，历史或未来日期可能有偏差`);
    }
    const shifted = new Date(instant + info.offset * 60000);
    const value2 = `${utcMsToDateStr(shifted.getTime())}T${pad2(shifted.getUTCHours())}:${pad2(
      shifted.getUTCMinutes(),
    )}:${pad2(shifted.getUTCSeconds())}`;
    return { value: value2, allDay: false, parsed: true, warning: null, tzid: tzid || info.id };
  }

  if (tzid) {
    const info = timezoneInfo(tzid, Date.now());
    if (!info.known && Array.isArray(warnings)) {
      warnings.push(`未知时区 "${tzid}"，该时间按本地墙上时间原样保留`);
    } else if (info.approximate && Array.isArray(warnings)) {
      warnings.push(`时区 "${info.id}" 使用内置简化夏令时规则近似处理，历史或未来日期可能有偏差`);
    }
  }
  return { value: localWall, allDay: false, parsed: true, warning: null, tzid };
}

// ---------------------------------------------------------------------------
// 5. 内容行解析
// ---------------------------------------------------------------------------

/** 找到第一个不在双引号内的分隔冒号 */
function findValueSeparator(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) return i;
  }
  return -1;
}

/** 按分号切分（忽略双引号内的分号） */
function splitOutsideQuotes(str, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === sep && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 解析一行内容行（content line）。
 * @param {string} line 逻辑行
 * @param {number} lineNo 行号（用于告警）
 * @param {string[]} warnings
 * @returns {{name:string,params:Object,value:string}|null}
 */
function parseContentLine(line, lineNo, warnings) {
  const sep = findValueSeparator(line);
  if (sep < 0) {
    warnings.push(`第 ${lineNo} 行不是合法的属性行（缺少分隔冒号），已忽略`);
    return null;
  }
  const left = line.slice(0, sep);
  const value = line.slice(sep + 1);
  const pieces = splitOutsideQuotes(left, ';');
  const name = pieces[0].trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) {
    warnings.push(`第 ${lineNo} 行的属性名 "${pieces[0].trim()}" 不合法，已忽略`);
    return null;
  }
  const params = {};
  for (let i = 1; i < pieces.length; i += 1) {
    const piece = pieces[i].trim();
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim().toUpperCase();
    let val = piece.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

// ---------------------------------------------------------------------------
// 6. RRULE 解析
// ---------------------------------------------------------------------------

/** 把可能是字符串/数组/数字的输入转成整数数组 */
function toIntArray(value) {
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr.map((v) => Number(String(v).trim())).filter((n) => Number.isFinite(n));
}

/**
 * 解析 RRULE 值。
 * @param {string} raw 如 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=16'
 * @param {string} defaultTz 用于 UNTIL(UTC) 换算的目标时区
 * @param {string[]|null} warnings
 * @returns {Object|null} 无法解析（缺 FREQ）返回 null
 */
function parseRRuleValue(raw, defaultTz, warnings) {
  const out = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    byday: [],
    wkst: null,
  };
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim();
    if (val === '') continue;
    switch (key) {
      case 'FREQ':
        out.freq = val.toUpperCase();
        break;
      case 'INTERVAL': {
        const n = Number.parseInt(val, 10);
        out.interval = Number.isFinite(n) && n > 0 ? n : 1;
        break;
      }
      case 'COUNT': {
        const n = Number.parseInt(val, 10);
        out.count = Number.isFinite(n) && n >= 0 ? n : null;
        break;
      }
      case 'UNTIL': {
        const parsed = parseDateValueDetailed(val, {}, defaultTz, warnings);
        if (parsed.parsed) out.until = parsed.value;
        else if (Array.isArray(warnings)) warnings.push(`RRULE 的 UNTIL 值 "${val}" 无法解析，已忽略`);
        break;
      }
      case 'BYDAY':
        out.byday = val
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        break;
      case 'WKST':
        out.wkst = val.toUpperCase();
        break;
      case 'BYMONTHDAY':
        out.bymonthday = toIntArray(val);
        break;
      case 'BYMONTH':
        out.bymonth = toIntArray(val);
        break;
      default:
        // 其它规则（BYSETPOS、BYYEARDAY 等）暂不支持，忽略即可
        break;
    }
  }
  if (!out.freq) {
    if (Array.isArray(warnings)) warnings.push(`RRULE "${raw}" 缺少 FREQ，已忽略该重复规则`);
    return null;
  }
  return out;
}

/** 把 event.rrule（对象或字符串）规整成统一结构 */
function normalizeRRule(rrule) {
  if (!rrule) return null;
  if (typeof rrule === 'string') return parseRRuleValue(rrule, DEFAULT_TIMEZONE, null);
  if (typeof rrule !== 'object') return null;
  const freq = String(rrule.freq ?? '').trim().toUpperCase();
  if (!freq) return null;
  const intervalRaw = Number(rrule.interval);
  // 注意：Number(null) === 0，所以必须先判断是否真的给了值
  const countRaw =
    rrule.count === null || rrule.count === undefined || rrule.count === '' ? null : Number(rrule.count);
  const bydayInput = rrule.byday;
  const out = {
    freq,
    interval: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : 1,
    count: Number.isFinite(countRaw) && countRaw >= 0 ? Math.floor(countRaw) : null,
    until: rrule.until ? String(rrule.until) : null,
    byday: Array.isArray(bydayInput)
      ? bydayInput.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
      : bydayInput
        ? String(bydayInput)
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        : [],
    wkst: rrule.wkst ? String(rrule.wkst).trim().toUpperCase() : null,
  };
  if (rrule.bymonthday !== undefined) out.bymonthday = toIntArray(rrule.bymonthday);
  if (rrule.bymonth !== undefined) out.bymonth = toIntArray(rrule.bymonth);
  return out;
}

// ---------------------------------------------------------------------------
// 7. parseICS
// ---------------------------------------------------------------------------

/** VEVENT 中被识别的属性名，其余进入 raw */
const RECOGNIZED_EVENT_PROPS = new Set([
  'UID',
  'SUMMARY',
  'DESCRIPTION',
  'LOCATION',
  'DTSTART',
  'DTEND',
  'RRULE',
  'EXDATE',
  'RDATE',
  'CATEGORIES',
  'STATUS',
]);

/** 去重后追加告警 */
function addWarning(warnings, msg) {
  if (!msg) return;
  if (!warnings.includes(msg)) warnings.push(msg);
}

/** 预扫描日历级时区（X-WR-TIMEZONE 或第一个 VTIMEZONE 的 TZID） */
function scanCalendarTimezone(lines) {
  let vtimezoneTzid = null;
  let inVtimezone = false;
  for (const line of lines) {
    const sep = findValueSeparator(line);
    if (sep < 0) continue;
    const left = line.slice(0, sep);
    const name = left.split(';')[0].trim().toUpperCase();
    const value = line.slice(sep + 1).trim();
    if (name === 'BEGIN' && value.toUpperCase() === 'VTIMEZONE') {
      inVtimezone = true;
      continue;
    }
    if (name === 'END' && value.toUpperCase() === 'VTIMEZONE') {
      inVtimezone = false;
      continue;
    }
    if (name === 'X-WR-TIMEZONE') {
      const tz = normalizeTzid(unescapeText(value));
      if (tz) return tz; // 优先使用显式的日历时区
    }
    if (name === 'TZID' && inVtimezone && !vtimezoneTzid) {
      vtimezoneTzid = normalizeTzid(unescapeText(value));
    }
  }
  return vtimezoneTzid;
}

/**
 * 由 VEVENT 属性列表构造事件对象。
 * @returns {Object|null} 关键信息缺失时返回 null（并记 warning）
 */
function buildEvent(block, calTz, warnings) {
  const byName = new Map();
  for (const prop of block.props) {
    if (!byName.has(prop.name)) byName.set(prop.name, []);
    byName.get(prop.name).push(prop);
  }
  const first = (name) => (byName.get(name) || [])[0] || null;

  const dtstartProp = first('DTSTART');
  if (!dtstartProp) {
    warnings.push(`第 ${block.index} 行开始的 VEVENT 缺少 DTSTART，已忽略该事件`);
    return null;
  }
  const startInfo = parseDateValueDetailed(dtstartProp.value, dtstartProp.params, calTz, warnings);
  if (!startInfo.parsed) {
    warnings.push(`第 ${block.index} 行的 VEVENT 的 DTSTART 无法解析，已忽略该事件`);
    return null;
  }
  const timezone = startInfo.tzid || null;

  // —— 结束时间 ——
  let endValue = startInfo.value;
  let allDay = startInfo.allDay;
  const dtendProp = first('DTEND');
  if (dtendProp) {
    const endInfo = parseDateValueDetailed(dtendProp.value, dtendProp.params, calTz, warnings);
    if (endInfo.parsed) {
      if (allDay && endInfo.allDay) {
        // RFC5545：VALUE=DATE 的 DTEND 是非包含的（次日起算），转成「最后一天的日期」
        const lastDay = addDays(endInfo.value, -1);
        endValue = lastDay && lastDay >= startInfo.value ? lastDay : startInfo.value;
      } else {
        endValue = endInfo.value;
        allDay = false;
      }
    }
  } else if (first('DURATION')) {
    addWarning(warnings, 'DURATION 属性暂不支持，已按默认时长处理');
    endValue = allDay ? startInfo.value : defaultValueEnd(startInfo.value);
  } else {
    addWarning(warnings, `第 ${block.index} 行的 VEVENT 缺少 DTEND，已按默认时长补全`);
    endValue = allDay ? startInfo.value : defaultValueEnd(startInfo.value);
  }

  // —— 重复规则 ——
  const rruleProp = first('RRULE');
  const rrule = rruleProp ? parseRRuleValue(rruleProp.value, timezone || calTz, warnings) : null;

  // —— 排除/追加日期 ——
  const collectDates = (name) => {
    const out = [];
    for (const prop of byName.get(name) || []) {
      for (const piece of splitUnescaped(prop.value, ',')) {
        const piece2 = piece.trim();
        if (piece2 === '') continue;
        const parsed = parseDateValueDetailed(piece2, prop.params, calTz, warnings);
        if (!parsed.parsed) {
          warnings.push(`${name} 中的值 "${piece2}" 无法解析，已忽略`);
          continue;
        }
        const day = parsed.value.slice(0, 10);
        if (!out.includes(day)) out.push(day);
      }
    }
    return out;
  };

  // —— 分类 ——
  const categories = [];
  for (const prop of byName.get('CATEGORIES') || []) {
    for (const piece of splitUnescaped(prop.value, ',')) {
      const cat = unescapeText(piece.trim());
      if (cat !== '' && !categories.includes(cat)) categories.push(cat);
    }
  }

  // —— UID ——
  const uidProp = first('UID');
  let uid = uidProp ? unescapeText(uidProp.value).trim() : '';
  if (uid === '') {
    uid = `generated-${block.index}@study-guard.local`;
    warnings.push(`第 ${block.index} 行的 VEVENT 缺少 UID，已自动生成 "${uid}"`);
  }

  // —— 其余属性进 raw ——
  const raw = {};
  for (const prop of block.props) {
    if (RECOGNIZED_EVENT_PROPS.has(prop.name)) continue;
    raw[prop.name] = raw[prop.name] === undefined ? prop.value : `${raw[prop.name]};${prop.value}`;
  }

  return {
    uid,
    summary: unescapeText(first('SUMMARY')?.value ?? ''),
    description: unescapeText(first('DESCRIPTION')?.value ?? ''),
    location: unescapeText(first('LOCATION')?.value ?? ''),
    start: startInfo.value,
    end: endValue,
    allDay,
    timezone,
    rrule,
    exdates: collectDates('EXDATE'),
    rdates: collectDates('RDATE'),
    categories,
    status: first('STATUS') ? unescapeText(first('STATUS').value).trim().toUpperCase() : null,
    raw,
  };
}

/** 定时事件缺省结束时间：+1 小时 */
function defaultValueEnd(startValue) {
  const wall = parseWall(startValue);
  if (!wall) return startValue;
  return wallEpochToDateTime(wallToEpoch(wall) + DEFAULT_DURATION_MS);
}

/** 处理一个闭合的组件块 */
function emitBlock(block, ctx, parentName) {
  const { warnings } = ctx;
  switch (block.name) {
    case 'VCALENDAR': {
      for (const prop of block.props) {
        if (prop.name === 'PRODID') ctx.calendar.prodId = prop.value.trim();
        else if (prop.name === 'X-WR-CALNAME') ctx.calendar.name = unescapeText(prop.value).trim();
        else if (prop.name === 'X-WR-TIMEZONE') {
          const tz = normalizeTzid(unescapeText(prop.value));
          if (tz) ctx.calendar.timezone = tz;
        }
      }
      break;
    }
    case 'VEVENT': {
      const event = buildEvent(block, ctx.calTz, warnings);
      if (event) ctx.events.push(event);
      break;
    }
    case 'VTIMEZONE':
      addWarning(warnings, '已忽略 VTIMEZONE 组件，时区改用内置偏移表处理');
      break;
    case 'STANDARD':
    case 'DAYLIGHT':
      break; // VTIMEZONE 内部的子组件，随 VTIMEZONE 一起忽略，不重复告警
    case 'VALARM':
      if (parentName === 'VEVENT') addWarning(warnings, '已忽略 VEVENT 内的 VALARM 提醒');
      break;
    case 'VTODO':
    case 'VJOURNAL':
    case 'VFREEBUSY':
      addWarning(warnings, `已忽略不支持的组件 ${block.name}`);
      break;
    default:
      addWarning(warnings, `已忽略未知组件 ${block.name}`);
      break;
  }
}

/**
 * 解析 iCalendar 文本。
 * @param {string|Buffer} text iCalendar 文本（支持 BOM、CRLF/LF 混用、折行）
 * @returns {{
 *   calendar: {name?: string, timezone?: string, prodId?: string},
 *   events: Array<Object>,
 *   warnings: string[]
 * }} 解析结果；无法解析的内容以中文描述写入 warnings
 */
export function parseICS(text) {
  /** @type {string[]} */
  const warnings = [];
  const lines = unfoldLines(text, warnings);
  const calTz = scanCalendarTimezone(lines) || DEFAULT_TIMEZONE;
  const ctx = { warnings, calendar: {}, events: [], calTz };
  if (lines.length === 0) {
    warnings.push('输入内容为空或没有任何有效行');
    return { calendar: ctx.calendar, events: [], warnings };
  }

  /** @type {Array<{name:string,index:number,props:Array<Object>}>} */
  const stack = [];
  let sawCalendar = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const prop = parseContentLine(lines[i], lineNo, warnings);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      const name = prop.value.trim().toUpperCase();
      if (name === 'VCALENDAR') sawCalendar = true;
      stack.push({ name, index: lineNo, props: [] });
      continue;
    }

    if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      if (stack.length === 0) {
        warnings.push(`第 ${lineNo} 行出现多余的 END:${name}，已忽略`);
        continue;
      }
      const top = stack[stack.length - 1];
      if (top.name === name) {
        stack.pop();
        emitBlock(top, ctx, stack.length ? stack[stack.length - 1].name : null);
        continue;
      }
      // 不匹配：尝试恢复到最近的同名 BEGIN
      warnings.push(
        `第 ${lineNo} 行的 END:${name} 与最近的 BEGIN:${top.name}（第 ${top.index} 行）不匹配`,
      );
      let matchIndex = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) {
          matchIndex = k;
          break;
        }
      }
      if (matchIndex < 0) continue;
      while (stack.length > matchIndex) {
        const unclosed = stack.pop();
        if (stack.length > matchIndex) {
          warnings.push(`第 ${unclosed.index} 行的 BEGIN:${unclosed.name} 未闭合，已强制结束`);
        }
        emitBlock(unclosed, ctx, stack.length ? stack[stack.length - 1].name : null);
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (!top) {
      addWarning(warnings, `第 ${lineNo} 行的属性 ${prop.name} 不在任何组件内，已忽略`);
      continue;
    }
    if (top.name === 'VCALENDAR' || top.name === 'VEVENT') top.props.push(prop);
    // 其它组件（VTIMEZONE/VALARM 等）内部属性直接丢弃
  }

  while (stack.length > 0) {
    const unclosed = stack.pop();
    warnings.push(`第 ${unclosed.index} 行的 BEGIN:${unclosed.name} 未闭合，已强制结束`);
    emitBlock(unclosed, ctx, stack.length ? stack[stack.length - 1].name : null);
  }
  if (!sawCalendar) addWarning(warnings, '文件中没有找到 BEGIN:VCALENDAR');
  return { calendar: ctx.calendar, events: ctx.events, warnings };
}

// ---------------------------------------------------------------------------
// 8. generateICS
// ---------------------------------------------------------------------------

/** 简单稳定的 32 位哈希（FNV-1a），用于生成可复现的 UID */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 把输入的事件起止时间规整为墙上时间 */
function resolveEventDates(event) {
  const startInput = event.start instanceof Date ? formatIcsDate(event.start) : event.start;
  const startWall = parseWall(typeof startInput === 'string' ? startInput : '');
  if (!startWall) return null;
  const inferredAllDay = startWall.allDay;
  const allDay = event.allDay === undefined ? inferredAllDay : event.allDay === true;
  let endWall = null;
  if (event.end !== undefined && event.end !== null && event.end !== '') {
    const endInput = event.end instanceof Date ? formatIcsDate(event.end) : event.end;
    endWall = parseWall(typeof endInput === 'string' ? endInput : '');
  }
  let endValue;
  if (endWall) {
    endValue = allDay ? endWall.date : endWall.time ? `${endWall.date}T${endWall.time}` : `${endWall.date}T00:00:00`;
  } else if (allDay) {
    endValue = startWall.date; // 全天事件默认当天
  } else {
    endValue = defaultValueEnd(`${startWall.date}T${startWall.time}`);
  }
  const startValue = allDay ? startWall.date : `${startWall.date}T${startWall.time}`;
  if (allDay && endValue < startValue) endValue = startValue;
  if (!allDay && endValue <= startValue) endValue = defaultValueEnd(startValue);
  return { start: startValue, end: endValue, allDay };
}

/** 生成 UID（同一输入稳定复现，便于日历订阅去重） */
function makeUid(event, index) {
  const basis = `${event.uid ?? ''}|${event.start ?? ''}|${event.summary ?? ''}|${index}`;
  return `${hash32(basis)}-${index}@study-guard.local`;
}

/** 把 RRULE 输入（字符串或对象）序列化成属性值 */
function serializeRRule(rrule) {
  if (!rrule) return null;
  if (typeof rrule === 'string') return rrule.trim() === '' ? null : rrule.trim();
  if (typeof rrule !== 'object') return null;
  const norm = normalizeRRule(rrule);
  if (!norm) return null;
  const parts = [`FREQ=${norm.freq}`];
  if (norm.interval && norm.interval > 1) parts.push(`INTERVAL=${norm.interval}`);
  if (norm.count !== null) parts.push(`COUNT=${norm.count}`);
  if (norm.until) parts.push(`UNTIL=${String(norm.until).replace(/[-:]/g, '')}`);
  if (norm.byday.length) parts.push(`BYDAY=${norm.byday.join(',')}`);
  if (norm.wkst) parts.push(`WKST=${norm.wkst}`);
  if (norm.bymonthday && norm.bymonthday.length) parts.push(`BYMONTHDAY=${norm.bymonthday.join(',')}`);
  if (norm.bymonth && norm.bymonth.length) parts.push(`BYMONTH=${norm.bymonth.join(',')}`);
  return parts.join(';');
}

/** 把 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:mm:ss' 转成 iCalendar 值形式 */
function toIcsDateValue(value, allDay) {
  if (allDay) return String(value).slice(0, 10).replace(/-/g, '');
  return String(value).replace(/[-:]/g, '');
}

/**
 * 生成 iCalendar 文本（CRLF 行尾、按 75 字节折行、末尾带换行）。
 * @param {{
 *   calendar?: {name?: string, timezone?: string, prodId?: string},
 *   events?: Array<{
 *     uid?: string, summary?: string, description?: string, location?: string,
 *     start: string|Date, end?: string|Date, allDay?: boolean,
 *     rrule?: string|Object, alarms?: Array<{triggerMinutesBefore: number, description?: string}>,
 *     url?: string, categories?: string[]|string, exdates?: string[], status?: string,
 *     timezone?: string
 *   }>,
 *   dtstamp?: Date|string
 * }} input
 * @returns {string} iCalendar 文本
 */
export function generateICS(input) {
  const src = input && typeof input === 'object' ? input : {};
  const cal = src.calendar && typeof src.calendar === 'object' ? src.calendar : {};
  const events = Array.isArray(src.events) ? src.events : [];
  const lines = [];
  const calTz = cal.timezone ? String(cal.timezone) : null;
  const prodId = cal.prodId ? String(cal.prodId) : '-//学习守护平台//Study Guard Calendar 1.0//CN';

  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${prodId}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  if (cal.name) lines.push(`X-WR-CALNAME:${escapeText(cal.name)}`);
  if (calTz) lines.push(`X-WR-TIMEZONE:${calTz}`);

  // DTSTAMP：默认取当前时间；允许通过 input.dtstamp 传入 Date 或时间字符串（便于测试复现）
  let dtstampValue;
  if (src.dtstamp instanceof Date) {
    dtstampValue = formatUtcStamp(src.dtstamp);
  } else if (typeof src.dtstamp === 'string') {
    const parsedStamp = new Date(src.dtstamp);
    dtstampValue = Number.isNaN(parsedStamp.getTime()) ? formatUtcStamp(new Date()) : formatUtcStamp(parsedStamp);
  } else {
    dtstampValue = formatUtcStamp(new Date());
  }

  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return;
    const dates = resolveEventDates(event);
    if (!dates) return; // 关键时间缺失，跳过该事件
    const eventTz = event.timezone ? String(event.timezone) : calTz;
    const tzParam = !dates.allDay && eventTz ? `;TZID=${eventTz}` : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid ? String(event.uid) : makeUid(event, index)}`);
    lines.push(`DTSTAMP:${dtstampValue}`);
    lines.push(`DTSTART${dates.allDay ? ';VALUE=DATE' : tzParam}:${toIcsDateValue(dates.start, dates.allDay)}`);
    lines.push(
      `DTEND${dates.allDay ? ';VALUE=DATE' : tzParam}:${toIcsDateValue(
        dates.allDay ? (addDays(dates.end, 1) ?? dates.end) : dates.end,
        dates.allDay,
      )}`,
    );
    if (event.summary !== undefined) lines.push(`SUMMARY:${escapeText(event.summary)}`);
    if (event.description !== undefined && event.description !== '') {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    if (event.location !== undefined && event.location !== '') {
      lines.push(`LOCATION:${escapeText(event.location)}`);
    }
    if (event.url) lines.push(`URL:${String(event.url)}`);
    if (event.categories) {
      const cats = Array.isArray(event.categories)
        ? event.categories.map((c) => escapeText(c)).join(',')
        : escapeText(event.categories);
      if (cats !== '') lines.push(`CATEGORIES:${cats}`);
    }
    if (event.status) lines.push(`STATUS:${String(event.status).toUpperCase()}`);
    const rruleValue = serializeRRule(event.rrule);
    if (rruleValue) lines.push(`RRULE:${rruleValue}`);
    if (Array.isArray(event.exdates) && event.exdates.length > 0) {
      const days = event.exdates
        .map((d) => String(d).slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (days.length > 0) {
        lines.push(`EXDATE;VALUE=DATE:${days.map((d) => d.replace(/-/g, '')).join(',')}`);
      }
    }
    const alarms = Array.isArray(event.alarms) ? event.alarms : [];
    for (const alarm of alarms) {
      if (!alarm || typeof alarm !== 'object') continue;
      const minutes = Math.abs(Math.floor(Number(alarm.triggerMinutesBefore) || 0));
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(
        `DESCRIPTION:${escapeText(alarm.description ?? event.summary ?? '日程提醒')}`,
      );
      lines.push(`TRIGGER:${minutes === 0 ? 'PT0M' : `-PT${minutes}M`}`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map((line) => foldLine(line)).join(CRLF) + CRLF;
}

// ---------------------------------------------------------------------------
// 9. expandRecurrence
// ---------------------------------------------------------------------------

/**
 * 按 RRULE 依次产出发生日期（'YYYY-MM-DD'，升序，不处理 COUNT/UNTIL/窗口）。
 * 支持的 FREQ：DAILY / WEEKLY / MONTHLY / YEARLY（其它 FREQ 不产出任何日期）。
 * @param {Object} rrule 规整后的重复规则
 * @param {{date:string,time:string|null,allDay:boolean}} startInfo DTSTART 墙上时间
 * @returns {Generator<string>}
 */
function* iterateRuleDates(rrule, startInfo) {
  const interval = Math.max(1, rrule.interval || 1);
  const startDate = startInfo.date;
  const freq = rrule.freq;

  if (freq === 'WEEKLY') {
    const wkst = weekdayIndexOf(rrule.wkst ?? 'MO');
    const wkstIndex = wkst < 0 ? 0 : wkst; // 默认周一为一周起点
    const days = rrule.byday.length
      ? rrule.byday.map(weekdayIndexOf).filter((n) => n >= 0)
      : [icalWeekday(startDate)];
    const sortedDays = [...new Set(days)].sort((a, b) => a - b);
    if (sortedDays.length === 0) return;
    const base = startOfWeek(startDate, wkstIndex);
    if (!base) return;
    for (let week = 0; ; week += 1) {
      const weekStart = addDays(base, week * 7 * interval);
      if (!weekStart) return;
      for (const wd of sortedDays) {
        const day = addDays(weekStart, (wd - wkstIndex + 7) % 7);
        if (!day) return;
        if (day < startDate) continue; // DTSTART 之前的日期不算
        yield day;
      }
    }
  }

  if (freq === 'DAILY') {
    const bydayFilter = rrule.byday.length ? new Set(rrule.byday.map(weekdayIndexOf)) : null;
    for (let n = 0; ; n += 1) {
      const day = addDays(startDate, n * interval);
      if (!day) return;
      if (bydayFilter && !bydayFilter.has(icalWeekday(day))) continue;
      yield day;
    }
  }

  if (freq === 'MONTHLY') {
    const startMs = dateStrToUtcMs(startDate);
    if (Number.isNaN(startMs)) return;
    const startD = new Date(startMs);
    const baseYear = startD.getUTCFullYear();
    const baseMonth = startD.getUTCMonth() + 1; // 1-12
    const startDayOfMonth = startD.getUTCDate();
    const bymonth = rrule.bymonth && rrule.bymonth.length ? new Set(rrule.bymonth) : null;
    for (let n = 0; ; n += 1) {
      const total = baseMonth - 1 + n * interval;
      const year = baseYear + Math.floor(total / 12);
      const month = (total % 12 + 12) % 12 + 1;
      if (bymonth && !bymonth.has(month)) continue;
      for (const day of monthCandidateDays(year, month, rrule, startDayOfMonth)) {
        yield `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
      }
    }
  }

  if (freq === 'YEARLY') {
    const startMs = dateStrToUtcMs(startDate);
    if (Number.isNaN(startMs)) return;
    const startD = new Date(startMs);
    const baseYear = startD.getUTCFullYear();
    const month = rrule.bymonth && rrule.bymonth.length ? rrule.bymonth[0] : startD.getUTCMonth() + 1;
    const day = rrule.bymonthday && rrule.bymonthday.length ? rrule.bymonthday[0] : startD.getUTCDate();
    for (let n = 0; ; n += 1) {
      const year = baseYear + n * interval;
      const dim = daysInMonth(year, month);
      if (day <= dim) yield `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
    }
  }
}

/** 计算某个月里符合 RRULE 的「几号」列表（升序） */
function monthCandidateDays(year, month, rrule, startDayOfMonth) {
  const dim = daysInMonth(year, month);
  const out = new Set();
  if (rrule.bymonthday && rrule.bymonthday.length) {
    for (const d of rrule.bymonthday) {
      const day = d > 0 ? d : dim + d + 1;
      if (day >= 1 && day <= dim) out.add(day);
    }
  }
  if (rrule.byday && rrule.byday.length) {
    for (const entry of rrule.byday) {
      const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(String(entry).toUpperCase());
      if (!m) continue;
      const icalIdx = WEEKDAY_INDEX.get(m[2]);
      const jsWeekday = (icalIdx + 1) % 7;
      if (m[1] === undefined) {
        // 不带序号：该月所有该星期几
        const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        const firstDay = 1 + ((jsWeekday - firstDow + 7) % 7);
        for (let d = firstDay; d <= dim; d += 7) out.add(d);
      } else {
        const day = nthWeekdayOfMonth(year, month, jsWeekday, Number(m[1]));
        if (day !== null) out.add(day);
      }
    }
  }
  if (out.size === 0) {
    if (startDayOfMonth <= dim) out.add(startDayOfMonth);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 把 RRULE 在 [rangeStart, rangeEnd] 区间展开成具体发生时间。
 *
 * 语义要点：
 * - WEEKLY：从 DTSTART 所在周（以 WKST 为一周起点，默认周一）开始按 BYDAY 生成，
 *   不在 BYDAY 中的日子跳过；INTERVAL=2 表示隔周；COUNT 从 DTSTART 起算（含被 EXDATE 排除的实例）；
 *   UNTIL 为上界（含）。DTSTART 本身若不在 BYDAY 中则不会出现。
 * - EXDATE 在计数之后生效（被排除的实例仍然占用 COUNT）。
 * - 非重复事件返回 0 或 1 个结果（落在区间内则 1 个）。
 * - 时间比较统一在 `opts.timezone`（默认 Asia/Shanghai）的墙上时间坐标系里进行。
 *
 * @param {Object} event IcsEvent（至少需要 start、end、allDay、rrule、exdates 等字段）
 * @param {Date} rangeStart 区间开始（含）
 * @param {Date} rangeEnd 区间结束（含）
 * @param {{maxOccurrences?: number, timezone?: string}} [opts]
 * @returns {Array<{start:string, end:string, allDay:boolean, occurrenceDate:string, isOverride?:boolean}>}
 */
export function expandRecurrence(event, rangeStart, rangeEnd, opts = {}) {
  if (!event || typeof event !== 'object') return [];
  const options = opts && typeof opts === 'object' ? opts : {};
  const maxOccurrences =
    Number.isFinite(Number(options.maxOccurrences)) && Number(options.maxOccurrences) > 0
      ? Math.floor(Number(options.maxOccurrences))
      : 1000;
  const tz =
    options.timezone !== undefined && options.timezone !== null
      ? String(options.timezone)
      : event.timezone
        ? String(event.timezone)
        : DEFAULT_TIMEZONE;

  const startInfo = parseWall(typeof event.start === 'string' ? event.start : '');
  if (!startInfo) return [];
  const allDay = event.allDay === true || startInfo.allDay;

  // —— 时长 ——
  const endInfo = parseWall(typeof event.end === 'string' ? event.end : '');
  let durationMs = DEFAULT_DURATION_MS;
  let spanDays = 0;
  if (allDay) {
    spanDays = endInfo ? Math.max(0, daysBetween(startInfo.date, endInfo.date)) : 0;
  } else if (endInfo) {
    const diff = wallToEpoch(endInfo) - wallToEpoch(startInfo);
    if (Number.isFinite(diff) && diff > 0) durationMs = diff;
  }

  // —— 区间换算到墙上时间坐标系 ——
  const rs =
    rangeStart instanceof Date && !Number.isNaN(rangeStart.getTime()) ? rangeStart : new Date();
  const re =
    rangeEnd instanceof Date && !Number.isNaN(rangeEnd.getTime())
      ? rangeEnd
      : new Date(rs.getTime() + 365 * 86400000);
  const winStart = rs.getTime() + timezoneInfo(tz, rs.getTime()).offset * 60000;
  const winEnd = re.getTime() + timezoneInfo(tz, re.getTime()).offset * 60000;

  const exdates = new Set(
    (Array.isArray(event.exdates) ? event.exdates : []).map((d) => String(d).slice(0, 10)),
  );
  const rdates = (Array.isArray(event.rdates) ? event.rdates : []).map((d) => String(d).slice(0, 10));

  /** @type {Array<Object>} */
  const collected = [];
  const timeMs = timeOfDayMs(startInfo);

  /** 依据发生日期产出结果对象并做区间过滤 */
  const pushOccurrence = (occDate, isOverride) => {
    if (typeof occDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(occDate)) return;
    let start;
    let end;
    let occEpoch;
    if (allDay) {
      start = occDate;
      end = addDays(occDate, spanDays) ?? occDate;
      occEpoch = dateStrToUtcMs(occDate);
    } else {
      const ms = dateStrToUtcMs(occDate);
      if (Number.isNaN(ms)) return;
      occEpoch = ms + timeMs;
      start = wallEpochToDateTime(occEpoch);
      end = wallEpochToDateTime(occEpoch + durationMs);
    }
    if (occEpoch < winStart || occEpoch > winEnd) return;
    const item = { start, end, allDay, occurrenceDate: occDate };
    if (isOverride) item.isOverride = true;
    collected.push(item);
  };

  const rule = normalizeRRule(event.rrule);
  if (!rule) {
    // 非重复事件：区间内则 1 个结果
    if (!exdates.has(startInfo.date)) pushOccurrence(startInfo.date, false);
  } else {
    const untilWall = rule.until ? parseWall(rule.until) : null;
    // 全天型 UNTIL 视为该日整天有效（含）
    const untilEpoch = untilWall
      ? wallToEpoch(untilWall) + (untilWall.time === null ? 86399999 : 0)
      : null;
    const countLimit = rule.count;
    let produced = 0;
    let guard = 0;
    for (const day of iterateRuleDates(rule, startInfo)) {
      guard += 1;
      if (guard > 100000) break; // 安全阀
      if (countLimit !== null && produced >= countLimit) break;
      const occEpoch = dateStrToUtcMs(day) + (allDay ? 0 : timeMs);
      if (untilEpoch !== null && occEpoch > untilEpoch) break;
      if (occEpoch > winEnd) break; // 日期单调递增，可以安全退出
      produced += 1;
      if (!exdates.has(day)) pushOccurrence(day, false);
    }
  }

  // RDATE 追加的额外发生日期
  for (const day of rdates) {
    if (exdates.has(day)) continue;
    pushOccurrence(day, true);
  }

  collected.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const seen = new Set();
  const unique = [];
  for (const item of collected) {
    if (seen.has(item.start)) continue;
    seen.add(item.start);
    unique.push(item);
    if (unique.length >= maxOccurrences) break;
  }
  return unique;
}
