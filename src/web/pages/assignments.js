/**
 * 作业页。
 *
 * 设计上强调「一眼看出先做哪个」：按紧急程度分组，
 * 每项直接显示 DDL 距离现在多久，以及已经安排了几次提醒。
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, emptyState, badge, assignmentCheck } from '../layout.js';
import { humanizeOffset } from '../../lib/datetime.js';
import { URGENCY_LABELS, STATUS_LABELS } from '../../lib/assignments.js';
import { channelCatalog } from '../../lib/notify/index.js';

/**
 * 分组标题按「离 DDL 多远」的事实来写，不用评价性说法。
 *
 * 这一组原先是「稍后截止」——但它的范围是 3 天以上、上不封顶，
 * 三周后的作业被叫「稍后」是在淡化它，容易让人以为还有的是时间。
 * 现在跟上面两组一样，直接把分档边界说出来。
 *
 * 这里写的数字必须和 datetime.js 的 urgencyOf 一致（24 小时 / 3 天）。
 * 导出是为了让测试能拿它跟 urgencyOf 的实际行为对照 —— 改了一边没改另一边的话，
 * 页面就会挂着一个和事实不符的标题，而这种错没人会主动发现。
 */
export const GROUP_META = [
  { key: 'overdue', title: '已过期', tone: 'danger', hint: '这些作业已经过了截止时间，尽快补交' },
  { key: 'urgent', title: '24 小时内截止', tone: 'warn', hint: '最需要优先处理' },
  { key: 'soon', title: '3 天内截止', tone: 'primary', hint: '' },
  { key: 'normal', title: '3 天以后截止', tone: 'neutral', hint: '' },
  { key: 'none', title: '没有截止时间', tone: 'neutral', hint: '建议补上 DDL，这样才能自动提醒你' },
];

export function assignmentsPage({
  user,
  assignments,
  grouped,
  courses,
  stats,
  filters,
  channels,
  defaultOffsets,
  highlightId,
}) {
  const activeCount = assignments.filter((a) => a.status !== 'done').length;

  // 「待办」视图里完成的作业会从列表消失。告诉前端这件事，
  // 它才知道打勾之后该把整张卡片做退场动画，而不是让它原地变灰。
  // 让服务端说了算，比前端去猜当前是哪个筛选页可靠。
  const hidesDone = filters.status !== 'done' && filters.status !== 'all';

  const body = `
${pageHeader({
    title: '作业',
    subtitle: `共 ${activeCount} 项待办${filters.courseId ? '（已按课程筛选）' : ''}`,
    actions: `<button type="button" class="btn btn--primary" data-new-assignment>${icon('plus', 17)}<span>新建作业</span></button>`,
  })}

<section class="stat-grid stat-grid--4">
  <div class="stat ${stats.overdue > 0 ? 'stat--danger' : ''}">
    <span class="stat__label">已过期</span><span class="stat__value">${stats.overdue}</span>
  </div>
  <div class="stat ${stats.dueToday > 0 ? 'stat--warn' : ''}">
    <span class="stat__label">今天截止</span><span class="stat__value">${stats.dueToday}</span>
  </div>
  <div class="stat"><span class="stat__label">待办合计</span><span class="stat__value">${stats.pending}</span></div>
  <div class="stat"><span class="stat__label">已完成</span><span class="stat__value">${stats.done}</span></div>
</section>

<div class="toolbar">
  <div class="filter-tabs">
    <a class="filter-tab${!filters.status ? ' is-active' : ''}" href="/assignments${filters.courseId ? `?courseId=${filters.courseId}` : ''}">待办</a>
    <a class="filter-tab${filters.status === 'done' ? ' is-active' : ''}" href="/assignments?status=done">已完成</a>
    <a class="filter-tab${filters.status === 'all' ? ' is-active' : ''}" href="/assignments?status=all">全部</a>
  </div>
  ${courses.length ? `
  <form class="inline-form" method="get" action="/assignments">
    ${filters.status ? `<input type="hidden" name="status" value="${escapeHtml(filters.status)}">` : ''}
    <select class="input input--sm" name="courseId" onchange="this.form.submit()">
      <option value="">全部课程</option>
      ${courses.map((c) => `<option value="${c.id}"${String(filters.courseId) === String(c.id) ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
    </select>
  </form>` : ''}
  <div class="toolbar__spacer"></div>
  ${channels.length === 0
      ? `<a class="badge badge--warn" href="/settings#notify">${icon('alert', 14)} 未配置提醒渠道</a>`
      : `<span class="muted small">提醒将发送到：${channels.map((c) => escapeHtml(c.name)).join('、')}</span>`}
</div>

${activeCount === 0 && filters.status !== 'done' && filters.status !== 'all'
      ? emptyState({
        icon: 'check',
        title: '当前没有待办作业',
        description: '新建作业时填上截止时间，并选好提前多久提醒，到点会自动推送到你手机。',
        action: `<button type="button" class="btn btn--primary" data-new-assignment>${icon('plus', 17)}<span>新建作业</span></button>`,
      })
      : GROUP_META.map((meta) => {
        const list = grouped[meta.key] || [];
        if (!list.length) return '';
        return `<section class="group" id="group-${meta.key}">
    <div class="group__head">
      <h2 class="group__title">${escapeHtml(meta.title)} <span class="group__count">${list.length}</span></h2>
      ${meta.hint ? `<span class="muted small">${escapeHtml(meta.hint)}</span>` : ''}
    </div>
    <div class="assignment-list"${hidesDone ? ' data-hides-done="1"' : ''}>
      ${list.map((a) => assignmentCard(a, highlightId)).join('')}
    </div>
  </section>`;
      }).join('')}

${renderAssignmentForm({ courses, channels, defaultOffsets })}
`;

  return { title: '作业', active: 'assignments', body };
}

function assignmentCard(a, highlightId) {
  const isDone = a.status === 'done';
  const tone = a.isOverdue ? 'danger'
    : a.urgency === 'urgent' ? 'warn'
      : a.urgency === 'soon' ? 'primary' : 'neutral';

  const offsets = a.offsetsList || [];

  return `<article class="assignment${isDone ? ' is-done' : ''}${String(highlightId) === String(a.id) ? ' is-highlight' : ''}"
     id="assignment-${a.id}" data-assignment="${a.id}">
  <div class="assignment__left">
    ${assignmentCheck({ id: a.id, status: a.status, title: a.title })}
  </div>

  <div class="assignment__body">
    <header class="assignment__head">
      <h3 class="assignment__title">${escapeHtml(a.title)}</h3>
      <div class="assignment__badges">
        ${a.priority === 2 ? badge('高优先级', 'danger') : ''}
        ${a.status === 'doing' ? badge('进行中', 'primary') : ''}
        ${isDone ? badge('已完成', 'success') : badge(URGENCY_LABELS[a.urgency] || '', tone)}
      </div>
    </header>

    <div class="assignment__meta">
      ${a.course_name ? `<a class="meta-item" href="/courses/${a.course_id}"><span class="dot" style="--dot-color:${escapeHtml(a.course_color || '#3a63e8')}"></span>${escapeHtml(a.course_name)}</a>` : '<span class="meta-item muted">未关联课程</span>'}
      <span class="meta-item">${icon('clock', 14)} ${escapeHtml(a.dueLabel)}</span>
      ${!isDone && a.dueDistance ? `<span class="meta-item ${a.isOverdue ? 'text-danger' : ''}">${escapeHtml(a.dueDistance)}</span>` : ''}
    </div>

    ${a.description ? `<p class="assignment__desc">${escapeHtml(a.description.slice(0, 200))}${a.description.length > 200 ? '…' : ''}</p>` : ''}

    ${a.progress > 0 && a.progress < 100 ? `
      <div class="progress progress--sm">
        <div class="progress__bar" style="width:${a.progress}%"></div>
      </div>` : ''}

    <div class="assignment__foot">
      ${offsets.length
      ? `<span class="reminder-tags" title="这些时间点会推送提醒到你的手机">
          ${icon('bell', 14)}
          ${offsets.slice(0, 4).map((o) => `<span class="reminder-tag">${escapeHtml(humanizeOffset(o))}</span>`).join('')}
          ${offsets.length > 4 ? `<span class="reminder-tag">+${offsets.length - 4}</span>` : ''}
        </span>`
      : '<span class="muted small">未设置提醒</span>'}
      ${a.material_title ? `<span class="meta-item">${icon('folder', 14)} ${escapeHtml(a.material_title)}</span>` : ''}
      ${a.score !== null && a.score !== undefined ? `<span class="meta-item">得分 ${escapeHtml(String(a.score))} / ${escapeHtml(String(a.full_score ?? 100))}</span>` : ''}
      <div class="assignment__actions">
        <button type="button" class="btn btn--ghost btn--sm" data-edit-assignment="${a.id}">${icon('edit', 15)}<span>编辑</span></button>
        <button type="button" class="btn btn--ghost btn--sm btn--icon" data-delete-assignment="${a.id}" data-title="${escapeHtml(a.title)}" title="删除">${icon('trash', 15)}</button>
      </div>
    </div>
  </div>
</article>`;
}

/**
 * 新建/编辑作业的表单。
 *
 * 放在页面里作为一个隐藏的模板，前端 JS 把它塞进弹窗；
 * 这样即使 JS 挂了，表单也还在文档里（渐进增强）。
 */
export function renderAssignmentForm({ courses, channels, defaultOffsets }) {
  return `<template id="assignment-form-template">
  <form class="form" data-assignment-form>
    <input type="hidden" name="id" value="">

    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="af_title">作业标题<span class="field__req">*</span></label>
        <input id="af_title" class="input" name="title" required placeholder="例如：第三章课后习题" maxlength="200">
      </div>
    </div>

    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="af_course">所属课程</label>
        <select id="af_course" class="input" name="courseId">
          <option value="">不关联课程</option>
          ${courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.teacher ? `（${escapeHtml(c.teacher)}）` : ''}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="af_priority">优先级</label>
        <select id="af_priority" class="input" name="priority">
          <option value="1">中</option>
          <option value="2">高</option>
          <option value="0">低</option>
        </select>
      </div>
    </div>

    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="af_due">截止时间<span class="field__req">*</span></label>
        <input id="af_due" class="input" type="datetime-local" name="dueAt" required>
        <p class="field__help">提醒会按下面的「提前多久」自动排好。</p>
      </div>
    </div>

    <div class="field">
      <label class="field__label">提前多久提醒</label>
      <div class="chip-group" data-offset-group>
        ${[
      [10080, '提前 1 周'],
      [4320, '提前 3 天'],
      [1440, '提前 1 天'],
      [720, '提前 12 小时'],
      [360, '提前 6 小时'],
      [120, '提前 2 小时'],
      [60, '提前 1 小时'],
      [30, '提前 30 分钟'],
    ].map(([value, label]) => `
          <label class="chip">
            <input type="checkbox" name="offset" value="${value}"${String(defaultOffsets).split(',').map((s) => s.trim()).includes(String(value)) ? ' checked' : ''}>
            <span>${label}</span>
          </label>`).join('')}
      </div>
      <div class="field__inline">
        <label class="muted small" for="af_custom_offset">自定义（分钟）：</label>
        <input id="af_custom_offset" class="input input--sm input--narrow" type="number" min="1" placeholder="例如 45">
        <button type="button" class="btn btn--outline btn--sm" data-add-offset>添加</button>
      </div>
      <input type="hidden" name="remindOffsets" value="${escapeHtml(defaultOffsets || '1440,120')}">
      <p class="field__help" data-offset-preview></p>
    </div>

    <div class="field">
      <label class="field__label" for="af_desc">作业要求 / 说明</label>
      <textarea id="af_desc" class="input input--area" name="description" rows="4" placeholder="老师的要求、提交格式、注意事项…"></textarea>
    </div>

    ${channels.length > 1 ? `
    <div class="field">
      <label class="field__label">提醒发送到</label>
      <div class="chip-group">
        ${channels.map((c) => `
          <label class="chip">
            <input type="checkbox" name="channel" value="${escapeHtml(c.type)}" checked>
            <span>${escapeHtml(c.name)}</span>
          </label>`).join('')}
      </div>
      <p class="field__help">全部不勾选时，会发送到所有已启用的渠道。</p>
    </div>` : ''}

    <div class="form__row">
      <div class="field">
        <label class="field__label" for="af_status">状态</label>
        <select id="af_status" class="input" name="status">
          <option value="todo">未开始</option>
          <option value="doing">进行中</option>
          <option value="done">已完成</option>
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="af_progress">进度（%）</label>
        <input id="af_progress" class="input" type="number" name="progress" min="0" max="100" value="0">
      </div>
      <div class="field">
        <label class="field__label" for="af_score">得分（选填）</label>
        <input id="af_score" class="input" type="number" step="0.5" name="score" placeholder="出分后填">
      </div>
    </div>

    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="submit" class="btn btn--primary">保存</button>
    </div>
  </form>
</template>`;
}
