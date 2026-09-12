/**
 * 作息时间表。
 *
 * 「第 3-4 节」到底是几点到几点？每个学校、甚至每个校区都不一样。
 *
 * 关键设计：**以「单节课」为最小单位**，而不是「区段」。
 *
 * 为什么不能用区段：真实的课表里有「第 5-6 节」「第 5-7 节」这种任意跨度的课。
 * 如果表里存的是「第5-6节 13:00-14:35、第7-8节 15:30-17:05」这样的区段，
 * 那「第 5-7 节」就查不出来——开始时间能取到 13:00，
 * 结束时间却会取到第 7-8 节那一行的 17:05，直接错半小时以上。
 * 按单节课存就没这个问题：
 *
 *   第5节 13:00-13:45
 *   第6节 13:50-14:35
 *   第7节 14:40-15:25
 *
 * 于是 第5-6节 → 13:00-14:35，第5-7节 → 13:00-15:25，都对。
 *
 * 数据形状：`[{ index: 1, start: '08:00', end: '08:45' }, ...]`
 */

/**
 * 默认作息时间表：45 分钟一节课、课间 5 分钟、大课间 20 分钟的常见编排。
 *
 * 这只是**初始值**。用户可以在「设置 → 作息时间」里改成一节一节填，
 * 改完之后：导入课表时的节次换算、课程表页的时间轴都会跟着变。
 */
export const DEFAULT_PERIOD_SCHEDULE = [
  { index: 1, start: '08:00', end: '08:45' },
  { index: 2, start: '08:50', end: '09:35' },
  { index: 3, start: '09:55', end: '10:40' },
  { index: 4, start: '10:45', end: '11:30' },
  { index: 5, start: '13:30', end: '14:15' },
  { index: 6, start: '14:20', end: '15:05' },
  { index: 7, start: '15:25', end: '16:10' },
  { index: 8, start: '16:15', end: '17:00' },
  { index: 9, start: '18:30', end: '19:15' },
  { index: 10, start: '19:20', end: '20:05' },
  { index: 11, start: '20:25', end: '21:10' },
  { index: 12, start: '21:15', end: '22:00' },
];

/** 'HH:MM' 格式校验 */
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 补零成两位的 'HH:MM' */
function padTime(value) {
  const s = String(value || '').trim();
  return s.length === 4 && s[1] === ':' ? `0${s}` : s;
}

/** 'HH:MM' -> 分钟数 */
export function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** 分钟数 -> 'HH:MM' */
export function minutesToTime(min) {
  const v = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * 校验并清洗一份作息表，返回**单节课**数组。
 *
 * 兼容两种输入：
 *   - 新格式：`{ index, start, end }`
 *   - 旧格式：`{ from, to, start, end }`（按区段存的历史数据，会被拆成单节课）
 *
 * 坏行直接丢掉，保证返回值一定是可用的数组（或 null 表示全坏）。
 */
export function normalizePeriodSchedule(input) {
  if (!Array.isArray(input)) return null;

  const byIndex = new Map();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    // ---- 旧格式：区段，拆成单节课 ----
    if (item.index === undefined && item.from !== undefined) {
      for (const p of expandLegacyRow(item)) {
        byIndex.set(p.index, p);
      }
      continue;
    }

    // ---- 新格式：单节课 ----
    const index = Number.parseInt(item.index, 10);
    const start = padTime(item.start);
    const end = padTime(item.end);

    if (!Number.isFinite(index) || index < 1 || index > 30) continue;
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;
    if (start >= end) continue;

    byIndex.set(index, { index, start, end });
  }

  if (byIndex.size === 0) return null;
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * 把旧格式的一行区段「第 1-2 节 08:00-09:40」拆成单节课。
 * 按等分处理——不精确，但比直接丢掉用户的数据要好，而且用户一眼能看出并手动改。
 */
function expandLegacyRow(row) {
  const from = Number.parseInt(row.from, 10);
  const to = Number.parseInt(row.to, 10);
  const start = padTime(row.start);
  const end = padTime(row.end);

  if (!Number.isFinite(from) || from < 1 || from > 30) return [];
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return [];
  if (start >= end) return [];

  const last = Number.isFinite(to) && to >= from ? to : from;
  const count = last - from + 1;

  if (count === 1) return [{ index: from, start, end }];

  const startMin = timeToMinutes(start);
  const step = (timeToMinutes(end) - startMin) / count;

  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      index: from + i,
      start: minutesToTime(startMin + step * i),
      end: minutesToTime(startMin + step * (i + 1)),
    });
  }
  return out;
}

/**
 * 把「第 X-Y 节」换算成具体时间。
 *
 * 取第 X 节的开始时间 和 第 Y 节的结束时间。
 * 这样任意跨度都成立：
 *   第 5-6 节 → 第5节.start ~ 第6节.end
 *   第 5-7 节 → 第5节.start ~ 第7节.end
 *
 * @param {Array} schedule 作息表；传空则用默认值
 * @param {number} from 起始节次
 * @param {number} to 结束节次（可省略，等于 from）
 * @returns {{startTime:string,endTime:string}|null} 找不到对应节次时返回 null
 */
export function periodsToClock(schedule, from, to) {
  const list = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_PERIOD_SCHEDULE;

  let a = Number.parseInt(from, 10);
  let b = Number.parseInt(to, 10);
  if (!Number.isFinite(a)) return null;
  if (!Number.isFinite(b)) b = a;
  if (a > b) [a, b] = [b, a];

  const startPeriod = list.find((p) => p.index === a);
  const endPeriod = list.find((p) => p.index === b);
  if (!startPeriod || !endPeriod) return null;

  return { startTime: startPeriod.start, endTime: endPeriod.end };
}

/** 生成显示标签：「第 3 节」 */
export function periodLabel(period) {
  if (!period) return '';
  return `第 ${period.index} 节`;
}

/** 生成区段标签：「第 5-7 节」 */
export function rangeLabel(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a)) return '';
  if (!Number.isFinite(b) || a === b) return `第 ${a} 节`;
  return `第 ${a}-${b} 节`;
}

/**
 * 根据一个具体时刻，反查它属于第几节（用于把课程对齐到课表的某一行）。
 *
 * @param {'start'|'end'} mode
 *   start —— 判断「这个时刻是不是某一节课的开始时刻」，
 *            用左闭右开区间，避免 09:35 同时命中第2节的结束和第3节的开始
 *   end   —— 判断「这个时刻是不是某一节课的结束时刻」，用左开右闭区间
 * @returns {{position:number, period:object}|null} position 是作息表里的下标
 */
export function findPeriodByTime(schedule, hhmm, mode = 'start') {
  const list = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_PERIOD_SCHEDULE;
  const t = timeToMinutes(hhmm);

  for (let i = 0; i < list.length; i += 1) {
    const s = timeToMinutes(list[i].start);
    const e = timeToMinutes(list[i].end);
    if (mode === 'end' ? (t > s && t <= e) : (t >= s && t < e)) {
      return { position: i, period: list[i] };
    }
  }
  return null;
}

/**
 * 把一节课的「开始时刻 ~ 结束时刻」解析成它跨越的节次范围。
 *
 * 例：作息是 第5节 13:00-13:45、第6节 13:50-14:35、第7节 14:40-15:25 时，
 *     13:00 ~ 15:25 → { from: 5, to: 7, startRow: 4, endRow: 6, rowSpan: 3 }
 *
 * @returns {{from:number,to:number,startRow:number,endRow:number,rowSpan:number}|null}
 *          任何一端对不上作息表就返回 null，调用方应退化为整点分行
 */
export function resolvePeriodSpan(schedule, startTime, endTime) {
  const list = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_PERIOD_SCHEDULE;
  const startHit = findPeriodByTime(list, startTime, 'start');
  const endHit = findPeriodByTime(list, endTime, 'end');
  if (!startHit || !endHit) return null;

  // 理论上 endRow >= startRow；遇到异常数据时按单行处理，不让渲染炸掉
  const startRow = Math.min(startHit.position, endHit.position);
  const endRow = Math.max(startHit.position, endHit.position);

  return {
    from: list[startRow].index,
    to: list[endRow].index,
    startRow,
    endRow,
    rowSpan: endRow - startRow + 1,
  };
}

/** 生成一段人类可读的作息摘要，用于设置页展示 */
export function describeSchedule(schedule) {
  const list = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_PERIOD_SCHEDULE;
  return list.map((p) => `第${p.index}节 ${p.start}-${p.end}`).join('；');
}

/** 求作息表覆盖的最早/最晚时间，用于校验和展示 */
export function scheduleBounds(schedule) {
  const list = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_PERIOD_SCHEDULE;
  if (!list.length) return { earliest: '08:00', latest: '18:00' };
  return {
    earliest: list[0].start,
    latest: list[list.length - 1].end,
  };
}
