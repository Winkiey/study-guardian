/**
 * 调休 / 停课覆盖。
 *
 * ## 要解决什么
 *
 * 课表原本是「每周固定重复」的。但国内大学每学期都会遇到法定节假日调休，
 * 教务处的通知长这样：
 *
 *   「10 月 1 日至 7 日放假停课。」
 *   「10 月 11 日（周六）上 10 月 7 日（周三）的课。」
 *
 * 这两句话固定周重复的课表一句都表达不了 —— 那一周的课表**全错**，
 * 而且错得很自然：看起来就是一张正常的课表，你不会怀疑它。
 *
 * ## 两种覆盖，正好对应那两句话
 *
 *   · `off`  —— 这一天停课（放假）。这一天的课全部不出现。
 *   · `swap` —— 这一天**按另一个星期几的课表上**。
 *              这一天的课被替换掉，换成目标星期几的课（课程不变、日期改到这天）。
 *
 * ## 一个容易想错的地方
 *
 * 上面例子里 10 月 7 日（周三）**本身是放假的**，但 10 月 11 日仍然要上
 * 「周三的课」。所以 swap 的来源必须是**原始课表**（还没被 off 删掉的那份），
 * 不能是"处理完覆盖之后剩下的"。applyOverrides 里两步都基于同一份原始数据，
 * 就是为了这个 —— 按顺序原地改的话，先停课后调休和先调休后停课会得出
 * 两个不同的结果，而那是同一个学期安排。
 *
 * ## 明确不做的
 *
 * 不做「某天某一门课单独停上一次」（老师出差那种）。教务的调休通知是按天发的，
 * 而按天做已经能把"那一周全错"变成"那一周是对的"。加单课粒度会让
 * 编辑界面和冲突判断都复杂好几倍，而这个项目里每多一个判断点就多一处会漏。
 */

import { all, get, run } from '../db/index.js';
import { isValidDateStr, weekdayOf, weekdayCn } from './datetime.js';

/** 两种覆盖。key 存进库，label 给界面用 */
export const OVERRIDE_KINDS = [
  { key: 'off', label: '停课（放假）', hint: '这一天的课全部不出现' },
  { key: 'swap', label: '按另一天的课表上', hint: '例如「周六上周三的课」' },
];

export function isKnownOverrideKind(value) {
  return OVERRIDE_KINDS.some((k) => k.key === value);
}

/** 某天有没有覆盖（Map：date → override），供渲染用 */
export function overridesInRange(userId, from, to) {
  const rows = all(
    `SELECT * FROM schedule_overrides
      WHERE user_id = ? AND date >= ? AND date <= ?
      ORDER BY date`,
    userId, from, to,
  );
  return new Map(rows.map((r) => [r.date, normalizeOverride(r)]));
}

/** 全部覆盖（设置/管理用） */
export function listOverrides(userId, { limit = 200 } = {}) {
  return all(
    `SELECT * FROM schedule_overrides WHERE user_id = ?
      ORDER BY date DESC LIMIT ?`,
    userId, Math.min(Math.max(Number(limit) || 200, 1), 1000),
  ).map(normalizeOverride);
}

function normalizeOverride(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    kind: row.kind,
    // swapTo 只在 kind='swap' 时有意义。存的是 1-7（周一到周日）
    swapTo: row.swap_to == null ? null : Number(row.swap_to),
    note: row.note || '',
  };
}

/**
 * 日期必须是**严格**的 `YYYY-MM-DD`。
 *
 * ⚠️ 这里刻意不用 datetime.js 的 isValidDateStr()：它底下是 parseLocal()，
 *    而那家伙对认不出的写法会退回 `new Date(s)` —— 于是 `2026/10/01`
 *    也会被判定成"合法日期"（JS 的 Date 认斜杠写法）。
 *    这个值要当**字符串键**用（和 'YYYY-MM-DD' 比大小、和别的行比相等），
 *    `2026/10/01` 存进去永远匹配不到任何一天，而且在界面上看起来完全正常。
 */
function isStrictDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (!isValidDateStr(s)) return false;
  // 排掉 2026-02-30 这种：Date 会把它滚到 3 月 2 日
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 写一条覆盖（同一天只留一条，重复写就是改）。
 *
 * @throws {Error} 参数不合法时抛中文原因 —— 调用方直接回 400
 */
export function setOverride(userId, { date, kind, swapTo = null, note = '' } = {}) {
  const d = String(date || '').trim();
  if (!isStrictDate(d)) throw new Error('日期格式不对，应该是 YYYY-MM-DD 这样的真实日期');
  if (!isKnownOverrideKind(kind)) throw new Error('覆盖类型不对（只能是停课或调课）');

  let target = null;
  if (kind === 'swap') {
    target = Number(swapTo);
    if (!Number.isInteger(target) || target < 1 || target > 7) {
      throw new Error('调课要说明"按星期几上"（1~7）');
    }
    // 「按自己这天原本的课表上」是没有意义的，挡掉 ——
    // 留着它不会报错，但界面上会显示成一句让人看不懂的"按周六上周六的课"。
    if (target === weekdayOf(d)) {
      throw new Error('调课的目标不能是这一天自己 —— 那样等于没调');
    }
  }

  run(
    `INSERT INTO schedule_overrides (user_id, date, kind, swap_to, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       kind = excluded.kind, swap_to = excluded.swap_to, note = excluded.note`,
    Number(userId), d, kind, target, String(note || '').trim().slice(0, 100),
  );
  return normalizeOverride(get(
    'SELECT * FROM schedule_overrides WHERE user_id = ? AND date = ?', Number(userId), d,
  ));
}

/** 删一条覆盖。返回是否真的删掉了（和 deleteTerm 一样，调用方据此回 404） */
export function deleteOverride(userId, id) {
  const result = run(
    'DELETE FROM schedule_overrides WHERE id = ? AND user_id = ?',
    Number(id), Number(userId),
  );
  return (Number(result?.changes) || 0) > 0;
}

/** 一句人话描述，界面上和自测里都用它 */
export function describeOverride(ov) {
  if (!ov) return '';
  if (ov.kind === 'off') return '停课';
  return `按${weekdayCn(ov.swapTo)}的课表上`;
}

/**
 * 把覆盖作用到一份**原始**课表上（纯函数，不碰数据库）。
 *
 * @param {Array} occurrences 某个区间内的原始 occurrence（有 date / startTime / 课程信息）
 * @param {Map<string, object>} byDate overridesInRange 的结果
 * @param {{from: string, to: string}} clip 只保留这个区间里的结果
 * @returns {Array} 处理后的 occurrence；被调课挪过来的会带上 `movedFrom`
 */
export function applyOverrides(occurrences, byDate, clip) {
  if (!byDate || byDate.size === 0) {
    return clip ? occurrences.filter((o) => o.date >= clip.from && o.date <= clip.to) : occurrences;
  }

  // ⚠️ 两步都基于**同一份原始数据**（不是边算边改）：
  //    10 月 7 日（周三）本身停课，但 10 月 11 日仍要上"周三的课"——
  //    来源必须是原始课表，不能是"已经删掉停课那天"之后剩下的。
  const out = [];

  // 第一遍：不加任何东西，只挑出"这一天的课还该不该在"
  for (const o of occurrences) {
    const ov = byDate.get(o.date);
    if (ov && ov.kind === 'off') continue;      // 停课：这一天的课不出现
    if (ov && ov.kind === 'swap') continue;     // 调课：这一天的课被换掉（下面再补）
    out.push(o);
  }

  // 第二遍：把调课那天要上的课补上
  for (const [date, ov] of byDate) {
    if (ov.kind !== 'swap') continue;
    for (const src of occurrences) {
      if (weekdayOf(src.date) !== ov.swapTo) continue;
      out.push({
        ...src,
        date,                        // 日期改到调课这一天
        // `moved` 是课表页认的标记（courseBlock 里那个「调课」小旗子，
        // 样式 .is-moved / .course-block__flag 早就在了）。名字必须对上，
        // 写错的话页面不会报错，只是那个旗子永远不出现。
        moved: true,
        movedFrom: src.date,         // 留着，界面上要说明"这节课本来是周三的"
        weekday: weekdayOf(date),
      });
    }
  }

  out.sort((a, b) => (a.date === b.date
    ? a.startTime.localeCompare(b.startTime)
    : a.date.localeCompare(b.date)));

  return clip ? out.filter((o) => o.date >= clip.from && o.date <= clip.to) : out;
}
