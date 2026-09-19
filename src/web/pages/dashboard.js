/**
 * 总览页（仪表盘）。
 *
 * 一屏回答四个问题：
 *   今天有什么课？哪些作业快到了？最近老师发了什么资料？这学期进度到哪了？
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, emptyState, statTile, timeTag } from '../layout.js';
import {
  formatDateCn,
  humanizeDistance,
  nowStr,
  todayStr,
  weekdayCn,
} from '../../lib/datetime.js';
import { URGENCY_LABELS } from '../../lib/assignments.js';

/** 根据当前时间生成问候语 */
function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function dashboardPage({
  user,
  termProgress,
  todayCourses,
  assignments,
  materialCount,
  recentMaterials,
  stats,
  nextCourse,
  schedulerOk,
}) {
  const body = `
${pageHeader({
    title: `${greeting()}，${escapeHtml(user.display_name || user.username)}`,
    subtitle: termProgress
      ? `${escapeHtml(termProgress.term.name)} · 第 <strong>${termProgress.week}</strong> 周 / 共 ${termProgress.total} 周 · ${formatDateCn(todayStr())}`
      : `<span class="muted">还没有设置学期。设置学期后就能看到「第几周」，课表也会自动按周次过滤。</span>`,
    actions: `
      <a class="btn btn--primary" href="/assignments?new=1">${icon('plus', 17)}<span>新建作业</span></a>
      <a class="btn btn--outline" href="/materials?upload=1">${icon('upload', 17)}<span>上传资料</span></a>`,
  })}

${!schedulerOk ? `
<div class="notice notice--warn">
  <div class="notice__icon">${icon('alert', 18)}</div>
  <div class="notice__body">
    <strong>还没设置提醒渠道</strong>
    <p>设置之后，作业快到截止时间时会自动推到你手机上。<a href="/settings#notify">去添加 Bark 或邮箱</a>，两分钟就能配好。</p>
  </div>
</div>` : ''}

<section class="stat-grid">
  ${statTile({
    label: '今日课程',
    value: todayCourses.length,
    hint: todayCourses.length ? `第一节 ${todayCourses[0].startTime}` : '今天没课',
    tone: todayCourses.length ? 'primary' : 'default',
    href: '/timetable',
  })}
  ${statTile({
    label: '待办作业',
    value: stats.pending,
    hint: stats.overdue > 0 ? `${stats.overdue} 项已过期` : (stats.dueToday > 0 ? `${stats.dueToday} 项今天截止` : '暂无紧急'),
    tone: stats.overdue > 0 ? 'danger' : (stats.dueToday > 0 ? 'warn' : 'default'),
    href: '/assignments',
  })}
  ${statTile({
    label: '资料',
    value: materialCount,
    hint: '份',
    href: '/materials',
  })}
  ${statTile({
    label: '已完成作业',
    value: stats.done,
    hint: '累计',
    href: '/assignments?status=done',
  })}
</section>

${nextCourse ? `
<div class="next-up">
  <div class="next-up__label">${icon('clock', 16)} 下一节课</div>
  <div class="next-up__main">
    <span class="next-up__name">${escapeHtml(nextCourse.courseName)}</span>
    <span class="next-up__meta">${escapeHtml(weekdayCn(nextCourse.weekday))} ${escapeHtml(nextCourse.startTime)}-${escapeHtml(nextCourse.endTime)}${nextCourse.location ? ` · ${escapeHtml(nextCourse.location)}` : ''}</span>
  </div>
  <div class="next-up__when">${escapeHtml(humanizeDistance(`${nextCourse.date} ${nextCourse.startTime}`))}</div>
</div>` : ''}

<div class="grid grid--2">
  ${card({
    title: '今日课程',
    actions: `<a class="link" href="/timetable">查看完整课表 ${icon('chevronRight', 14)}</a>`,
    body: todayCourses.length
      ? `<ul class="timeline">${todayCourses.map(courseTimelineItem).join('')}</ul>`
      : emptyState({
        icon: 'calendar',
        title: '今天没有课',
        description: '好好休息，或者提前看看这周的安排。',
        action: '<a class="btn btn--outline btn--sm" href="/timetable">查看本周课表</a>',
      }),
  })}

  ${card({
    title: '待办作业',
    actions: `<a class="link" href="/assignments">全部作业 ${icon('chevronRight', 14)}</a>`,
    body: assignments.length
      ? `<ul class="task-list">${assignments.slice(0, 6).map(assignmentRow).join('')}</ul>`
      : emptyState({
        icon: 'check',
        title: '没有待办作业',
        description: '新建作业后可以设置截止时间，到点会推送到你手机。',
        action: '<a class="btn btn--primary btn--sm" href="/assignments?new=1">新建作业</a>',
      }),
  })}
</div>

${recentMaterials.length ? card({
    title: '最近上传的资料',
    actions: `<a class="link" href="/materials">全部资料 ${icon('chevronRight', 14)}</a>`,
    body: `<div class="material-mini-grid">${recentMaterials.map(materialMini).join('')}</div>`,
  }) : ''}

${termProgress ? card({
    title: '学期进度',
    body: `
  <div class="progress-row">
    <div class="progress">
      <div class="progress__bar" style="width:${Math.round((termProgress.week / termProgress.total) * 100)}%"></div>
    </div>
    <span class="progress__label">第 ${termProgress.week} / ${termProgress.total} 周 · 已过 ${Math.round((termProgress.week / termProgress.total) * 100)}%</span>
  </div>
  <p class="muted small">学期从 ${escapeHtml(termProgress.term.start_date)} 开始，预计 ${escapeHtml(termProgress.endDate)} 结束。</p>`,
  }) : ''}
`;

  return { title: '总览', body, active: 'dashboard' };
}

function courseTimelineItem(c) {
  const isPast = c.endTime < nowStr().slice(11, 16);
  const isNow = c.startTime <= nowStr().slice(11, 16) && nowStr().slice(11, 16) <= c.endTime;
  return `<li class="timeline__item${isPast ? ' is-past' : ''}${isNow ? ' is-now' : ''}">
  <span class="timeline__time">${escapeHtml(c.startTime)}</span>
  <span class="timeline__dot" style="--dot-color:${escapeHtml(c.courseColor || '#3a63e8')}"></span>
  <span class="timeline__body">
    <a class="timeline__title" href="/courses/${c.courseId}">${escapeHtml(c.courseName)}</a>
    <span class="timeline__meta">
      ${escapeHtml(c.startTime)}-${escapeHtml(c.endTime)}
      ${c.location ? ` · ${escapeHtml(c.location)}` : ''}
      ${c.teacher ? ` · ${escapeHtml(c.teacher)}` : ''}
    </span>
  </span>
  ${isNow ? '<span class="badge badge--primary">进行中</span>' : ''}
</li>`;
}

function assignmentRow(a) {
  const tone = a.urgency === 'overdue' ? 'danger'
    : a.urgency === 'urgent' ? 'warn'
      : a.urgency === 'soon' ? 'primary' : 'neutral';
  return `<li class="task">
  <a class="task__main" href="/assignments?highlight=${a.id}">
    <span class="task__title">${escapeHtml(a.title)}</span>
    <span class="task__meta">
      ${a.course_name ? `<span class="dot" style="--dot-color:${escapeHtml(a.course_color || '#3a63e8')}"></span>${escapeHtml(a.course_name)} · ` : ''}
      ${escapeHtml(a.dueDistance)}（${escapeHtml(a.due_at ? a.due_at.slice(5, 16) : '')}）
    </span>
  </a>
  <span class="badge badge--${tone}">${escapeHtml(URGENCY_LABELS[a.urgency] || '')}</span>
</li>`;
}

function materialMini(m) {
  return `<a class="material-mini" href="/materials/${m.id}">
  <span class="material-mini__icon">${m.kindIcon || '📎'}</span>
  <span class="material-mini__body">
    <span class="material-mini__title" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</span>
    <span class="material-mini__meta">${escapeHtml(m.course_name || '未归类')} · ${escapeHtml(m.created_at?.slice(5, 10) || '')}</span>
  </span>
</a>`;
}
