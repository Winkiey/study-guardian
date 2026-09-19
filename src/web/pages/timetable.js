/**
 * 课程表页：周视图网格 + 前后周切换。
 *
 * 这是很多同学最常打开的页面，所以做了移动端适配：
 * 窄屏时网格横向滚动，并自动滚到「今天」那一列。
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, emptyState, card, badge } from '../layout.js';
import { addDays, formatDateCn, nowStr, todayStr, weekdayCn, WEEKDAY_SHORT } from '../../lib/datetime.js';
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
    days.push({ date, weekday: i + 1, items: byDate.get(date) || [] });
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
      <div class="week-grid__head${d.date === today ? ' is-today' : ''}"
           style="grid-row:1;grid-column:${i + 2}" data-date="${d.date}">
        <span class="week-grid__weekday">${weekdayCn(d.weekday)}</span>
        <span class="week-grid__date">${Number(d.date.slice(8, 10))}</span>
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
        </div>
        <div class="day-row__body">
          ${d.items.length
            ? d.items.map((o) => `
              <a class="course-chip" href="/courses/${o.courseId}" style="--chip-color:${escapeHtml(o.courseColor || '#3a63e8')}">
                <span class="course-chip__time">${escapeHtml(o.startTime)}-${escapeHtml(o.endTime)}</span>
                <span class="course-chip__name">${escapeHtml(o.courseName)}</span>
                ${o.location ? `<span class="course-chip__place">${escapeHtml(o.location)}</span>` : ''}
              </a>`).join('')
            : '<span class="muted small">无课</span>'}
        </div>
      </div>`).join('')}
  </div>`,
  })}

<div class="grid grid--2 mt-lg">
  ${card({
    title: '本周课程汇总',
    body: courses.length
      ? `<table class="table">
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
    </table>`
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
