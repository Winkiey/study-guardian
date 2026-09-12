/**
 * 日期时间工具。
 *
 * 全站统一使用**本地时间字符串**，不用 Date 对象在数据库里往返，
 * 避免时区转换带来的各种意外。格式约定见 db/schema.js 顶部注释。
 */

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

export { WEEKDAY_CN, WEEKDAY_SHORT };

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 'YYYY-MM-DD' */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Date -> 'YYYY-MM-DD HH:MM' */
export function toDateTimeStr(d) {
  return `${toDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Date -> 'YYYY-MM-DD HH:MM:SS' */
export function toDateTimeSecStr(d) {
  return `${toDateTimeStr(d)}:${pad2(d.getSeconds())}`;
}

/** 当前本地时间 'YYYY-MM-DD HH:MM:SS' */
export function nowStr() {
  return toDateTimeSecStr(new Date());
}

/** 当前本地时间 'YYYY-MM-DD HH:MM' */
export function nowMinuteStr() {
  return toDateTimeStr(new Date());
}

/** 今天 'YYYY-MM-DD' */
export function todayStr() {
  return toDateStr(new Date());
}

/**
 * 把本地时间字符串解析成 Date。
 * 支持 'YYYY-MM-DD'、'YYYY-MM-DD HH:MM'、'YYYY-MM-DD HH:MM:SS'、'YYYY-MM-DDTHH:MM'。
 * 也兼容带时区的 ISO 字符串（此时按 Date 原生规则解析）。
 * 非法输入返回 null。
 */
export function parseLocal(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const s = String(value).trim();
  if (!s) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const [, y, mo, da, hh, mi, ss] = m;
  const d = new Date(
    Number(y),
    Number(mo) - 1,
    Number(da),
    Number(hh || 0),
    Number(mi || 0),
    Number(ss || 0),
    0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 在本地时间字符串上加分钟，返回 'YYYY-MM-DD HH:MM:SS' */
export function addMinutes(value, minutes) {
  const d = parseLocal(value);
  if (!d) return null;
  return toDateTimeSecStr(new Date(d.getTime() + minutes * 60_000));
}

/** 日期加减天数，返回 'YYYY-MM-DD' */
export function addDays(dateStr, days) {
  const d = parseLocal(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** b - a 的分钟差（正数表示 b 在 a 之后） */
export function diffMinutes(a, b) {
  const da = parseLocal(a);
  const db = parseLocal(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 60_000);
}

/** 取某个日期所在周的周一（ISO 周：周一为一周第一天） */
export function startOfWeek(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return null;
  const dow = d.getDay(); // 0=周日
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + delta);
  return toDateStr(d);
}

/** 星期几：1=周一 ... 7=周日 */
export function weekdayOf(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return 0;
  const dow = d.getDay();
  return dow === 0 ? 7 : dow;
}

/** 两个 'YYYY-MM-DD' 之间相差几天 */
export function daysBetween(fromDate, toDate) {
  const a = parseLocal(fromDate);
  const b = parseLocal(toDate);
  if (!a || !b) return 0;
  const ms = b.setHours(0, 0, 0, 0) - a.setHours(0, 0, 0, 0);
  return Math.round(ms / 86_400_000);
}

/** 'HH:MM' -> 一天中的分钟数 */
export function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分钟数 -> 'HH:MM' */
export function minutesToTime(min) {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

/** 中文星期：'周三' */
export function weekdayCn(weekday) {
  return WEEKDAY_CN[weekday] || '';
}

/** 中文短星期：'三' */
export function weekdayShort(weekday) {
  return WEEKDAY_SHORT[weekday] || '';
}

/** '2024-10-08' -> '10月8日' */
export function formatMonthDay(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** '2024-10-08' -> '10月8日 周二' */
export function formatDateCn(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return '';
  return `${formatMonthDay(dateStr)} ${weekdayCn(weekdayOf(dateStr))}`;
}

/** '2024-10-08 14:30' -> '10月8日 14:30' */
export function formatDateTimeCn(value) {
  const d = parseLocal(value);
  if (!d) return '';
  const hasTime = /\d{2}:\d{2}/.test(String(value));
  if (!hasTime) return formatDateCn(value);
  return `${formatMonthDay(toDateStr(d))} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 把时间差变成人话：'3 天后'、'2 小时 15 分后'、'已过期 1 天'、'刚刚'
 * @param {string} target 目标时间
 * @param {string} [from] 基准时间，默认现在
 */
export function humanizeDistance(target, from) {
  const base = from || nowStr();
  const minutes = diffMinutes(base, target);
  const abs = Math.abs(minutes);
  const suffix = minutes >= 0 ? '后' : '前';

  if (abs < 1) return '就是现在';
  if (abs < 60) return `${abs} 分钟${suffix}`;
  if (abs < 60 * 24) {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m ? `${h} 小时 ${m} 分${suffix}` : `${h} 小时${suffix}`;
  }
  const days = Math.floor(abs / (60 * 24));
  const restH = Math.floor((abs % (60 * 24)) / 60);
  if (days < 30) return restH ? `${days} 天 ${restH} 小时${suffix}` : `${days} 天${suffix}`;
  return `${Math.floor(days / 30)} 个月${suffix}`;
}

/**
 * 把「提前多少分钟」变成人话：1440 -> '提前 1 天'
 */
export function humanizeOffset(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '不提醒';
  if (m % (60 * 24) === 0) return `提前 ${m / (60 * 24)} 天`;
  if (m % 60 === 0) return `提前 ${m / 60} 小时`;
  return `提前 ${m} 分钟`;
}

/** 判断 value 是否为合法的 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:MM' */
export function isValidDateStr(value) {
  return parseLocal(value) !== null;
}

/** 生成「距 DDL 还有」的紧急程度：overdue / urgent / soon / normal */
export function urgencyOf(dueAt, from) {
  if (!dueAt) return 'none';
  const minutes = diffMinutes(from || nowStr(), dueAt);
  if (minutes < 0) return 'overdue';
  if (minutes <= 60 * 24) return 'urgent';
  if (minutes <= 60 * 24 * 3) return 'soon';
  return 'normal';
}
