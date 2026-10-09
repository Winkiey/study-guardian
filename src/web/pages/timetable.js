/**
 * 课程表页：周视图网格 + 前后周切换。
 *
 * 这是很多同学最常打开的页面，所以做了移动端适配：
 * 窄屏时网格横向滚动，并自动滚到「今天」那一列。
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, emptyState, card, badge } from '../layout.js';
import { addDays, formatDateCn, nowStr, todayStr, weekdayCn, WEEKDAY_SHORT } from '../../lib/datetime.js';
import { OVERRIDE_KINDS, describeOverride } from '../../lib/schedule-overrides.js';
import { buildTimetableGrid } from '../../lib/weeks.js';

export function timetablePage({
  user,
  term,
  termProgress,
  weekStart,
  weekEnd,
  occurrences,
  courses,
  viewWeek,
  totalWeeks,
  importHint,
  periodSchedule = [],
  hasCustomPeriods = false,
  overrides = null,
  allOverrides = [],
  ovError = '',
}) {
  const today = todayStr();
  const currentHm = nowStr().slice(11, 16);

  // 按天分组，便于同时渲染「网格视图」和「列表视图」
  const byDate = new Map();
  for (const occ of occurrences) {
    if (!byDate.has(occ.date)) byDate.set(occ.date, []);
    byDate.get(occ.date).push(occ);
  }

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(weekStart, i);
    const ov = (overrides && overrides.get(date)) || null;
    days.push({
      date,
      // 星期几要按**覆盖之后**的来：调休那天显示"周六"但上的是周三的课，
      // 表头仍写周六（那是真实的日期），另用标记说明"按周三上"。
      weekday: i + 1,
      items: byDate.get(date) || [],
      override: ov,
      ovLabel: ov ? describeOverride(ov) : '',
    });
  }

  // 有作息表就按「第 1-2 节」分行；对不上则自动退回整点分行
  const grid = buildTimetableGrid(occurrences, { periods: periodSchedule });
  const usingPeriodRows = grid.mode === 'periods';

  const actions = `
    <div class="week-nav">
      <a class="btn btn--outline btn--icon" href="/timetable?week=${viewWeek - 1}" title="上一周" aria-label="上一周">${icon('chevronLeft', 18)}</a>
      <a class="btn btn--outline btn--sm" href="/timetable">本周</a>
      <a class="btn btn--outline btn--icon" href="/timetable?week=${viewWeek + 1}" title="下一周" aria-label="下一周">${icon('chevronRight', 18)}</a>
    </div>
    <button type="button" class="btn btn--outline btn--sm" data-export-calendar>${icon('download', 16)}<span>导出日历</span></button>
  `;

  if (!courses.length) {
    return {
      title: '课程表',
      active: 'timetable',
      body: `${pageHeader({ title: '课程表', subtitle: '还没有任何课程' })}
${emptyState({
  // 这一处直接挂在页面 h1 下面，标题层级要接 h2（默认的 h3 会跳级）
  level: 2,
        icon: 'calendar',
        title: '课程表还是空的',
        description: importHint
          ? '有三种方式可以把课表导进来，选一个最顺手的：'
            + '<ul class="hint-list">'
            + '<li><strong>上传教务处导出的 .ics 文件</strong> —— 最省事，自动识别课程、教师、时间、周次</li>'
            + '<li><strong>粘贴或上传 CSV/Excel</strong> —— 我们有现成的模板，填好导入</li>'
            + '<li><strong>手动添加课程</strong> —— 只有几门课时最快</li>'
            + '</ul>'
          : '',
        action: `<a class="btn btn--primary" href="/import">${icon('upload', 17)}<span>导入课表</span></a>
                 <a class="btn btn--outline" href="/courses?new=1">${icon('plus', 17)}<span>手动添加课程</span></a>`,
      })}`,
    };
  }

  const body = `
${pageHeader({
    title: '课程表',
    subtitle: term
      ? `${escapeHtml(term.name)} · 第 <strong>${viewWeek}</strong> 周 / 共 ${term.week_count} 周 · ${formatDateCn(weekStart)} ~ ${formatDateCn(weekEnd)}
         <a class="link small" href="/settings#term" title="周次是拿「第 1 周周一」推算的，日期差一周周次就全偏">周次不对？</a>`
      : `<span class="muted">还没设置学期，课表的周次无法计算。<a href="/settings#term">先去设置学期</a></span>`,
    actions,
    breadcrumb: `<a href="/">总览</a> ${icon('chevronRight', 12)} 课程表`,
  })}

${usingPeriodRows
      ? ''
      : `<div class="notice notice--info notice--compact">
  <div class="notice__icon">${icon('alert', 16)}</div>
  <div class="notice__body">
    <strong>时间轴用的是整点，不是节次</strong>
    <p class="small">
      因为本学期的课程时间和「作息时间表」对不上，按节次分行会把课程挤到错误的行里。
      ${hasCustomPeriods
        ? '去<a href="/settings#periods">设置 → 作息时间</a>核对一下，或者直接改单门课的时间。'
        : '如果你们学校的作息不是通用的那份，去<a href="/settings#periods">设置 → 作息时间</a>改成自己的，时间轴就会按节次显示。'}
    </p>
  </div>
</div>`}

<section class="week-grid-wrap">
  <div class="week-grid" data-week-grid style="--grid-rows:${grid.rows.length}">
    <!-- 表头 -->
    <div class="week-grid__head week-grid__corner" style="grid-row:1;grid-column:1">${usingPeriodRows ? '节次' : '时间'}</div>
    ${days.map((d, i) => `
      <div class="week-grid__head${d.date === today ? ' is-today' : ''}${d.override ? ' is-overridden' : ''}"
           style="grid-row:1;grid-column:${i + 2}" data-date="${d.date}">
        <span class="week-grid__weekday">${weekdayCn(d.weekday)}</span>
        <span class="week-grid__date">${Number(d.date.slice(8, 10))}</span>
        ${/* ⚠️ 停课/调休必须**显式标出来**。不标的话，那一天的课凭空消失
             （或者多出一节"周三的课"），看的人只会以为课表坏了 ——
             而"课表坏了"和"放假了"，在他心里的分量完全不同。 */ ''}
        ${d.override ? `<span class="week-grid__ov" title="${escapeHtml(d.ovLabel)}">${escapeHtml(d.ovLabel)}</span>` : ''}
      </div>`).join('')}

    <!-- 左侧时间列 -->
    ${grid.rows.map((row, r) => `
      <div class="week-grid__time" style="grid-row:${r + 2};grid-column:1"
           title="${escapeHtml(row.start)} - ${escapeHtml(row.end)}">
        ${escapeHtml(row.label)}
        ${usingPeriodRows ? `<span class="week-grid__timerange">${escapeHtml(row.start)}</span>` : ''}
      </div>`).join('')}

    <!-- 背景格子（不可点击，只负责画网格线和高亮今天） -->
    ${grid.rows.map((row, r) => days.map((d, c) => `
      <div class="week-grid__cell${d.date === today ? ' is-today' : ''}"
           style="grid-row:${r + 2};grid-column:${c + 2}"></div>`).join('')).join('')}

    <!-- 课程块。直接作为网格子元素，跨节次的课靠 grid-row 的 span 真正占多行 -->
    ${grid.blocks.map((b) => courseBlock(b, currentHm, today)).join('')}

    ${/* 「当前时间线」：一条细线 + 一个小圆点，标出现在上到哪儿了。
         只在**今天这一列**、而且现在确实落在某一行里时才渲染。
         位置由前端按那一行的实际高度现算（见 app.js 的 nowLineOffset）——
         因为 .week-grid 的行高是 minmax(42px, auto)，一节 45 分钟的课和
         一段两小时的课格子一样高，服务端算不出准确位置。 */ ''}
    ${nowLine(grid, days, today, currentHm)}
  </div>
</section>

${card({
    title: '每天安排',
    body: `<div class="day-list">
    ${days.map((d) => `
      <div class="day-row${d.date === today ? ' is-today' : ''}">
        <div class="day-row__head">
          <span class="day-row__name">${weekdayCn(d.weekday)}</span>
          <span class="day-row__date">${escapeHtml(d.date.slice(5))}</span>
          ${d.date === today ? badge('今天', 'primary') : ''}
          ${d.override ? badge(d.ovLabel, 'warn') : ''}
        </div>
        <div class="day-row__body">
          ${d.items.length
            ? d.items.map((o) => `
              <a class="course-chip" href="/courses/${o.courseId}" style="--chip-color:${escapeHtml(o.courseColor || '#3a63e8')}">
                <span class="course-chip__time">${escapeHtml(o.startTime)}-${escapeHtml(o.endTime)}</span>
                <span class="course-chip__name">${escapeHtml(o.courseName)}</span>
                ${o.location ? `<span class="course-chip__place">${escapeHtml(o.location)}</span>` : ''}
              </a>`).join('')
            : /* 「无课」和「停课」不是一回事：一个是本来就没有，一个是被取消了。
                 写成同一句的话，放假那几天看起来就像课表出了问题。 */
              (d.override && d.override.kind === 'off'
                ? '<span class="muted small">停课</span>'
                : '<span class="muted small">无课</span>')}
        </div>
      </div>`).join('')}
  </div>`,
  })}

${overridesCard({ allOverrides, viewWeek, ovError })}

<div class="grid grid--2 mt-lg">
  ${card({
    title: '本周课程汇总',
    body: courses.length
      ? `<div class="table-scroll"><table class="table">
      <thead><tr><th>课程</th><th>教师</th><th>学分</th><th>本周课时</th></tr></thead>
      <tbody>
        ${summarizeWeek(occurrences, courses).map((row) => `
          <tr>
            <td><a href="/courses/${row.id}"><span class="dot" style="--dot-color:${escapeHtml(row.color || '#3a63e8')}"></span> ${escapeHtml(row.name)}</a></td>
            <td>${escapeHtml(row.teacher || '—')}</td>
            <td>${row.credits ?? '—'}</td>
            <td>${row.count} 节</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`
      : '<p class="muted">本周没有课。</p>',
  })}

  ${card({
    title: '把课表放进手机日历',
    body: `
    <p class="small">导出一份 <code>.ics</code> 日历文件，用 iPhone「日历」App 打开就能导入。这样不用打开本平台也能看课表。</p>
    <div class="btn-row">
      <a class="btn btn--primary btn--sm" href="/calendar/download.ics">${icon('download', 16)}<span>下载 .ics 文件</span></a>
      <a class="btn btn--outline btn--sm" href="/settings#calendar">${icon('external', 16)}<span>订阅链接</span></a>
    </div>
    <p class="muted small mt-sm">
      说明：<strong>下载导入</strong>的日历事件带闹钟，到点会响；<strong>订阅</strong>的日历 iOS 会忽略闹钟，
      只适合用来看课表。作业提醒请用 Bark 或邮箱（在<a href="/settings#notify">设置</a>里开启）。
    </p>`,
  })}
</div>
`;

  return { title: '课程表', active: 'timetable', body };
}

/**
 * 网格里的课程块。
 *
 * 直接作为 .week-grid 的子元素，用显式的 grid-row / grid-column 定位，
 * 这样「第 5-7 节」这种跨三节的课能通过 grid-row 的 span 真正占三行高度，
 * 一眼就能看出它比其他课长。
 */
/**
 * 「停课 / 调休」管理面板。
 *
 * 做成**普通的表单 POST**（服务端处理完 302 回课表页），不是 fetch + JS：
 * 这一屏做的是"改课表"，最怕的是点了没反应；表单提交有明确的成败和刷新，
 * 而且没有 JS 也能用。删一条也是一次 POST（不是 GET）—— 删除不该是一条
 * 能被浏览器预取、能被"刷新重放"的链接。
 */
function overridesCard({ allOverrides, viewWeek, ovError }) {
  const weekdayOptions = [1, 2, 3, 4, 5, 6, 7]
    .map((w) => `<option value="${w}">${weekdayCn(w)}</option>`).join('');

  const rows = allOverrides.slice(0, 40).map((ov) => `
    <li class="ov-row">
      <span class="ov-row__date">${escapeHtml(ov.date)}</span>
      <span class="ov-row__what">${escapeHtml(describeOverride(ov))}</span>
      ${ov.note ? `<span class="ov-row__note muted small">${escapeHtml(ov.note)}</span>` : ''}
      <form method="post" action="/timetable/overrides/delete" class="ov-row__del">
        <input type="hidden" name="id" value="${Number(ov.id)}">
        <input type="hidden" name="week" value="${Number(viewWeek)}">
        <button type="submit" class="btn btn--ghost btn--sm btn--icon"
                title="删掉这条" aria-label="删掉 ${escapeHtml(ov.date)} 的${escapeHtml(describeOverride(ov))}">
          ${icon('trash', 15)}
        </button>
      </form>
    </li>`).join('');

  return card({
    title: '停课 / 调休',
    body: `
    <p class="small">
      法定节假日调休那几天，课表和平时不一样：有的日子停课，有的日子要
      「按周四的课表上」。在这里加一条，课表和首页的「今天的课」都会跟着改 ——
      不用去动课程本身。
    </p>
    ${ovError ? `<div class="notice notice--warn notice--compact" data-ov-error>
      <div class="notice__icon">${icon('alert', 16)}</div>
      <div class="notice__body"><p class="small">${escapeHtml(ovError)}</p></div>
    </div>` : ''}
    <form class="ov-form" method="post" action="/timetable/overrides" data-ov-form>
      <input type="hidden" name="week" value="${Number(viewWeek)}">
      <div class="ov-form__row">
        <div class="field">
          <label class="field__label" for="ov_date">日期</label>
          <input id="ov_date" class="input" type="date" name="date" required>
        </div>
        <div class="field">
          <label class="field__label" for="ov_kind">怎么处理</label>
          <select id="ov_kind" class="input" name="kind">
            ${OVERRIDE_KINDS.map((k) => `<option value="${escapeHtml(k.key)}">${escapeHtml(k.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="ov_swap">按星期几上</label>
          <select id="ov_swap" class="input" name="swapTo">
            <option value="">（停课时不用选）</option>${weekdayOptions}
          </select>
        </div>
        <div class="field field--grow">
          <label class="field__label" for="ov_note">备注</label>
          <input id="ov_note" class="input" name="note" maxlength="100" placeholder="例如：国庆">
        </div>
      </div>
      <div class="btn-row">
        <button type="submit" class="btn btn--primary btn--sm">${icon('calendar', 15)}<span>加一条</span></button>
      </div>
      <p class="field__help">
        「停课」= 这一天不上课；「按星期几上」= 这一天按那一天原本的课表上
        （例如「周六上周三的课」）。同一天只保留一条，再设一次就是改。
      </p>
    </form>
    ${allOverrides.length
      ? `<ul class="ov-list">${rows}</ul>
         ${allOverrides.length > 40 ? '<p class="field__help">只列了最近 40 条。</p>' : ''}`
      : '<p class="muted small">还没有设过停课或调休。</p>'}`,
  });
}

/**
 * 「当前时间线」。
 *
 * 只在今天这一列、而且现在正好落在某一行里时才有意义 ——
 * 否则（今天不在这一周 / 现在是深夜，课表根本没排到那个点）
 * 画一条线出来只会让人困惑"这条线为什么在这儿"。
 *
 * 行高不给死：服务端只标出"是哪一行、这一行的起止时间"，
 * 具体位置由前端按那一行的**实际像素高度**现算（见 app.js 的 nowLineOffset）。
 * 因为行高是 minmax(42px, auto)：一格的高度由内容决定，跟这一节有多长无关，
 * 所以"算个百分比"在服务端是算不准的。
 *
 * @param {{rows: Array<{start:string,end:string}>}} grid
 * @param {Array<{date:string}>} days
 */
function nowLine(grid, days, today, currentHm) {
  const todayColumn = days.findIndex((d) => d.date === today);
  if (todayColumn === -1) return '';

  const rowIndex = grid.rows.findIndex((r) => r.start <= currentHm && currentHm < r.end);
  if (rowIndex === -1) return '';

  const row = grid.rows[rowIndex];
  return `<div class="now-line" data-now-line
     data-start="${escapeHtml(row.start)}" data-end="${escapeHtml(row.end)}"
     style="grid-row:${rowIndex + 2};grid-column:${todayColumn + 2}"
     role="presentation"></div>`;
}

function courseBlock(block, currentHm, today) {
  const o = block.occurrence;
  const isNow = o.date === today && o.startTime <= currentHm && currentHm <= o.endTime;

  const tooltip = [
    o.courseName,
    `${o.startTime}-${o.endTime}`,
    block.rangeLabel,
    o.location,
    o.teacher,
  ].filter(Boolean).join('\n');

  return `<a class="course-block${isNow ? ' is-now' : ''}${o.moved ? ' is-moved' : ''}"
     href="/courses/${o.courseId}"
     data-date="${escapeHtml(o.date)}"
     style="grid-row:${block.startRow + 2} / span ${block.rowSpan};grid-column:${block.column + 2};--block-color:${escapeHtml(o.courseColor || '#3a63e8')}"
     title="${escapeHtml(tooltip)}">
  <span class="course-block__name">${escapeHtml(o.courseName)}</span>
  <span class="course-block__meta">${escapeHtml(o.startTime)}-${escapeHtml(o.endTime)}</span>
  ${block.rangeLabel ? `<span class="course-block__range">${escapeHtml(block.rangeLabel)}</span>` : ''}
  ${o.location ? `<span class="course-block__place">${escapeHtml(o.location)}</span>` : ''}
  ${o.moved ? '<span class="course-block__flag">调课</span>' : ''}
</a>`;
}

/** 汇总每门课本周有几节 */
function summarizeWeek(occurrences, courses) {
  const map = new Map();
  for (const o of occurrences) {
    const entry = map.get(o.courseId) || { count: 0 };
    entry.count += 1;
    map.set(o.courseId, entry);
  }
  return courses
    .map((c) => ({ ...c, count: map.get(c.id)?.count || 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}
