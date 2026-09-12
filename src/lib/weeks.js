/**
 * 课表周次计算。
 *
 * 教务系统的课表不是「每周三 8 点」这么简单，而是：
 *   第 1-16 周的每周三 8:00，但第 5 周是单周不上，第 8 周停课，第 9 周调到周五。
 * 这个模块负责把「周次表达式 + 学期起始日」翻译成具体日期。
 */

import {
  addDays,
  daysBetween,
  parseLocal,
  startOfWeek,
  toDateStr,
  weekdayOf,
} from './datetime.js';
import { resolvePeriodSpan } from './periods.js';

/**
 * 解析周次表达式，返回周次数组（升序去重）。
 *
 * 支持的形式：
 *   '1-16'        第 1..16 周
 *   '1-16单'      第 1..16 周中的奇数周
 *   '1-16双'      偶数周
 *   '1-8,10-16'   多段（中文逗号也认）
 *   '3'           单周
 *   '1-16周'      带「周」字后缀
 *   '第1-16周'    带「第」前缀
 *   '1,3,5,7'     逐个列举
 *   ''            视为 1..maxWeek
 *
 * @param {string} spec 周次表达式
 * @param {number} maxWeek 上限，防止解析出天量周次
 * @returns {number[]} 周次数组
 */
export function parseWeekSpec(spec, maxWeek = 30) {
  const raw = String(spec ?? '').trim();
  if (!raw) return range(1, maxWeek);

  // 归一化：去掉「第」「周」「学期」等修饰，中文标点转英文
  const cleaned = raw
    .replace(/[第学期]/g, '')
    .replace(/[，、；]/g, ',')
    .replace(/[～—－]/g, '-')
    .replace(/周/g, (m, offset, str) => {
      // 只去掉作为后缀的「周」——简单起见全部去掉，因为数字段里不会出现「周」字
      return '';
    })
    .replace(/\s+/g, '');

  const result = new Set();

  for (const part of cleaned.split(',')) {
    if (!part) continue;

    // 奇偶标记
    let parity = null;
    let body = part;
    if (body.endsWith('单')) {
      parity = 1;
      body = body.slice(0, -1);
    } else if (body.endsWith('双')) {
      parity = 0;
      body = body.slice(0, -1);
    }

    let from;
    let to;
    const rangeMatch = /^(\d+)-(\d+)$/.exec(body);
    if (rangeMatch) {
      from = Number(rangeMatch[1]);
      to = Number(rangeMatch[2]);
    } else if (/^\d+$/.test(body)) {
      from = Number(body);
      to = Number(body);
    } else {
      // 无法解析的片段直接跳过，不抛错（真实文件里常有杂字符）
      continue;
    }

    if (from > to) [from, to] = [to, from];

    for (let w = Math.max(1, from); w <= Math.min(to, maxWeek); w += 1) {
      if (parity !== null && w % 2 !== parity) continue;
      result.add(w);
    }
  }

  // 全部解析失败时退化为全周次，避免课表整个消失
  if (result.size === 0) return range(1, maxWeek);
  return [...result].sort((a, b) => a - b);
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

/**
 * 判断某个周次是否命中周次表达式。用于渲染课表时快速过滤。
 */
export function weekMatches(spec, week, maxWeek = 30) {
  if (!week || week < 1) return false;
  return parseWeekSpec(spec, maxWeek).includes(week);
}

/**
 * 求「第 N 周的星期 X」对应的具体日期。
 * @param {string} termStart 第 1 周周一的日期 'YYYY-MM-DD'
 * @param {number} week 周次，从 1 开始
 * @param {number} weekday 1=周一 ... 7=周日
 * @returns {string|null} 'YYYY-MM-DD'
 */
export function dateForWeekday(termStart, week, weekday) {
  const monday = startOfWeek(termStart);
  if (!monday) return null;
  return addDays(monday, (week - 1) * 7 + (weekday - 1));
}

/**
 * 求某个日期属于学期第几周。
 * @returns {number} 1 开始；在学期开始之前返回 0；超出学期范围返回超大值
 */
export function weekOfDate(termStart, dateStr) {
  const monday = startOfWeek(termStart);
  if (!monday) return 0;
  const diff = daysBetween(monday, startOfWeek(dateStr));
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

/**
 * 把课程的上课时间展开成 [startDate, endDate] 区间内的具体课次。
 *
 * @param {object} params
 * @param {object} params.course 课程（需要 id、name、teacher、classroom）
 * @param {Array} params.sessions 该课程的上课时间记录
 * @param {Array} [params.exceptions] 调课/停课记录
 * @param {string} params.termStart 学期第 1 周周一 'YYYY-MM-DD'
 * @param {string} params.rangeStart 区间开始 'YYYY-MM-DD'
 * @param {string} params.rangeEnd 区间结束 'YYYY-MM-DD'
 * @returns {Array<{courseId, courseName, date, weekday, week, startTime, endTime, location, teacher, sessionId, moved?:boolean, cancelled?:boolean, note?:string}>}
 */
export function expandCourseSessions({
  course,
  sessions,
  exceptions = [],
  termStart,
  rangeStart,
  rangeEnd,
}) {
  const out = [];
  if (!termStart) return out;

  const startWeek = Math.max(1, weekOfDate(termStart, rangeStart) || 1);
  const endWeek = Math.max(startWeek, weekOfDate(termStart, rangeEnd) || startWeek);

  // 调课记录按日期索引，便于查找
  const cancelDates = new Map();
  const moveDates = new Map();
  for (const ex of exceptions) {
    if (ex.action === 'cancel') cancelDates.set(ex.date, ex);
    else moveDates.set(ex.date, ex);
  }

  for (const s of sessions) {
    const weeks = parseWeekSpec(s.weeks, Math.max(endWeek, 30));

    for (const week of weeks) {
      if (week < startWeek || week > endWeek) continue;

      const date = dateForWeekday(termStart, week, Number(s.weekday));
      if (!date || date < rangeStart || date > rangeEnd) continue;

      const base = {
        courseId: course.id,
        courseName: course.name,
        courseColor: course.color,
        sessionId: s.id,
        week,
        weekday: Number(s.weekday),
        date,
        startTime: s.start_time,
        endTime: s.end_time,
        location: s.location || course.classroom || '',
        teacher: s.teacher || course.teacher || '',
        credits: course.credits,
      };

      // 停课：不输出
      const cancel = cancelDates.get(date);
      if (cancel && String(cancel.session_id ?? s.id) === String(s.id)) continue;
      if (cancel && cancel.session_id == null) continue;

      // 调课：当天改到另一天
      const move = moveDates.get(date);
      if (move && (move.session_id == null || String(move.session_id) === String(s.id))) {
        out.push({
          ...base,
          originalDate: date,
          date: move.new_date || date,
          startTime: move.new_start_time || s.start_time,
          endTime: move.new_end_time || s.end_time,
          location: move.new_location || base.location,
          moved: true,
          note: move.note || '',
        });
        continue;
      }

      out.push(base);
    }
  }

  // 按时间排序，方便渲染
  out.sort((a, b) => (a.date === b.date
    ? a.startTime.localeCompare(b.startTime)
    : a.date.localeCompare(b.date)));

  return out;
}

/**
 * 生成周课表网格数据。
 *
 * 行标签有两种模式：
 *   'periods' —— 按用户配置的作息表，**一节课一行**，标签是「第3节」
 *   'hours'   —— 按整点分行，标签是「08:00」（退路）
 *
 * 节次模式下，单元格里返回的是 `blocks`：每门课带 `startRow/rowSpan`，
 * 让「第 5-7 节」这种跨三节的课在页面上真的占三行，
 * 而不是挤在一行里看不出来。
 *
 * 什么时候退化成 hours：只要有任意一节课的开始时间**或结束时间**落不进作息表的任何一节
 * （比如从 ICS 导入的时间是学校特有的、和作息表对不上），
 * 就说明这张作息表和实际课表不匹配，硬按节次分行会把课塞进错误的行。
 * 宁可用整点分行保证「至少能看」，并在页面上提示原因。
 *
 * @returns {{
 *   rows: Array<{label:string, start:string, end:string, index?:number}>,
 *   grid: Array<Array<Array>>,
 *   blocks: Array<{occurrence:object, column:number, startRow:number, rowSpan:number, rangeLabel:string}>,
 *   mode: 'periods'|'hours',
 *   aligned: boolean
 * }}
 */
export function buildTimetableGrid(occurrences, opts = {}) {
  const {
    dayStart = '08:00',
    dayEnd = '22:00',
    slotMinutes = 60,
    periods = null,
  } = opts;

  const usablePeriods = Array.isArray(periods) && periods.length > 0;

  // 每节课都要能同时对上「开始在哪一节」和「结束在哪一节」，
  // 否则节次分行就是错的
  const spans = usablePeriods
    ? occurrences.map((o) => resolvePeriodSpan(periods, o.startTime, o.endTime))
    : [];
  const aligned = usablePeriods && occurrences.every((o, i) => spans[i] !== null);

  if (usablePeriods && aligned) {
    const rows = periods.map((p) => ({
      label: `第${p.index}节`,
      start: p.start,
      end: p.end,
      index: p.index,
    }));

    const grid = rows.map(() => [[], [], [], [], [], [], []]);
    const blocks = [];

    occurrences.forEach((o, i) => {
      const span = spans[i];
      const column = Number(o.weekday) - 1;
      if (column < 0 || column > 6) return;

      // 同一格里可能有多门课（冲突），先按开始行放，渲染时再纵向错开
      grid[span.startRow][column].push(o);

      blocks.push({
        occurrence: o,
        column,
        startRow: span.startRow,
        rowSpan: span.rowSpan,
        from: span.from,
        to: span.to,
        rangeLabel: span.from === span.to ? `第${span.from}节` : `第${span.from}-${span.to}节`,
      });
    });

    return { rows, grid, blocks, mode: 'periods', aligned: true };
  }

  // ---- 整点分行（默认，也作为退路）----

  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };

  // 依据实际课次动态决定时间范围，避免出现大片空白
  let minStart = toMin(dayStart);
  let maxEnd = toMin(dayEnd);
  for (const o of occurrences) {
    minStart = Math.min(minStart, Math.floor(toMin(o.startTime) / 60) * 60);
    maxEnd = Math.max(maxEnd, Math.ceil(toMin(o.endTime) / 60) * 60);
  }
  minStart = Math.max(0, minStart);
  maxEnd = Math.min(24 * 60, Math.max(maxEnd, minStart + 60));

  const rows = [];
  for (let t = minStart; t < maxEnd; t += slotMinutes) {
    rows.push({
      start: minutesLabel(t),
      end: minutesLabel(Math.min(t + slotMinutes, 24 * 60)),
      label: minutesLabel(t),
    });
  }

  const grid = rows.map(() => [[], [], [], [], [], [], []]);
  const blocks = [];

  for (const o of occurrences) {
    const start = toMin(o.startTime);
    const rowIndex = Math.floor((start - minStart) / slotMinutes);
    const column = Number(o.weekday) - 1;
    if (rowIndex < 0 || rowIndex >= rows.length) continue;
    if (column < 0 || column > 6) continue;

    grid[rowIndex][column].push(o);
    blocks.push({
      occurrence: o,
      column,
      startRow: rowIndex,
      rowSpan: 1,
      rangeLabel: '',
    });
  }

  return { rows, grid, blocks, mode: 'hours', aligned: false, minStart, maxEnd };
}

function minutesLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 推断「现在」是学期的第几周第几天，用于首页提示 */
export function termProgress(term) {
  if (!term?.start_date) return null;
  const today = toDateStr(new Date());
  const week = weekOfDate(term.start_date, today);
  const total = Number(term.week_count) || 18;
  return {
    week: Math.min(Math.max(week, 1), total),
    rawWeek: week,
    total,
    isBefore: week < 1,
    isAfter: week > total,
    weekday: weekdayOf(today),
    startDate: term.start_date,
    endDate: addDays(startOfWeek(term.start_date), total * 7 - 1),
  };
}
