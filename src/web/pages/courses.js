/**
 * 课程列表页与课程详情页。
 *
 * 详情页要承载你最关心的信息：上课时间、教师、学分、成绩构成、这门课的课件与作业。
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, emptyState, badge, nl2br, assignmentCheck } from '../layout.js';
import { WEEKDAY_CN, formatDateCn, humanizeDistance } from '../../lib/datetime.js';
import { CATEGORY_LABELS } from '../../lib/materials.js';
import { URGENCY_LABELS } from '../../lib/assignments.js';

// ============================================================
// 列表页
// ============================================================

export function coursesPage({ user, courses, term, stats, keyword }) {
  const body = `
${pageHeader({
    title: '课程',
    subtitle: term
      ? `${escapeHtml(term.name)} · 共 ${courses.length} 门课`
      : `${courses.length} 门课程 · <a href="/settings#term">设置学期</a>后可显示周次`,
    actions: `
      <button type="button" class="btn btn--outline" data-batch-credits>${icon('check', 17)}<span>批量填学分</span></button>
      <a class="btn btn--outline" href="/import">${icon('upload', 17)}<span>导入课表</span></a>
      <a class="btn btn--primary" href="/courses?new=1">${icon('plus', 17)}<span>添加课程</span></a>`,
  })}

<div class="toolbar">
  <form class="search" method="get" action="/courses" role="search">
    ${icon('search', 17)}
    <input class="search__input" type="search" name="q" value="${escapeHtml(keyword || '')}" placeholder="搜索课程名、教师、课程号…">
  </form>
  <div class="toolbar__spacer"></div>
  <span class="muted small">总计 ${stats.totalCredits} 学分 · 每周 ${stats.weeklyHours} 节课</span>
</div>

${courses.length === 0
      ? emptyState({
        icon: 'book',
        title: keyword ? '没有找到匹配的课程' : '还没有课程',
        description: keyword ? '换个关键词试试。' : '可以从教务处导出的 .ics 文件一键导入，也可以手动添加。',
        action: keyword
          ? '<a class="btn btn--outline" href="/courses">清除搜索</a>'
          : `<a class="btn btn--primary" href="/import">${icon('upload', 17)}<span>导入课表</span></a>
             <a class="btn btn--outline" href="/courses?new=1">${icon('plus', 17)}<span>手动添加</span></a>`,
      })
      : `<div class="course-grid">${courses.map(courseCard).join('')}</div>`}
`;

  return { title: '课程', active: 'courses', body };
}

function courseCard(c) {
  const schedule = c.sessions.length
    ? c.sessions.map((s) => `
      <span class="schedule-tag">
        ${escapeHtml(WEEKDAY_CN[s.weekday] || '')} ${escapeHtml(s.start_time)}-${escapeHtml(s.end_time)}
        <em>${escapeHtml(s.weeks)}周</em>
      </span>`).join('')
    : '<span class="muted small">未设置上课时间</span>';

  const grade = c.gradeSummary;

  return `<article class="course-card" style="--card-color:${escapeHtml(c.color || '#3a63e8')}">
  <a class="course-card__link" href="/courses/${c.id}">
    <header class="course-card__head">
      <h2 class="course-card__name">${escapeHtml(c.name)}</h2>
      ${c.code ? `<span class="course-card__code">${escapeHtml(c.code)}</span>` : ''}
    </header>
    <div class="course-card__meta">
      ${c.teacher ? `<span class="meta-item">${icon('user', 14)} ${escapeHtml(c.teacher)}</span>` : ''}
      ${c.credits !== null && c.credits !== undefined ? `<span class="meta-item">${escapeHtml(String(c.credits))} 学分</span>` : ''}
      ${c.category ? `<span class="meta-item">${escapeHtml(c.category)}</span>` : ''}
      ${c.exam_type ? `<span class="meta-item">${escapeHtml(c.exam_type)}</span>` : ''}
    </div>
    <div class="course-card__schedule">${schedule}</div>
    <footer class="course-card__foot">
      <span class="meta-item">${icon('folder', 14)} ${c.materialCount ?? 0} 份资料</span>
      <span class="meta-item">${icon('check', 14)} ${c.assignmentCount ?? 0} 项待办</span>
      ${grade.hasItems && grade.scoredRate !== null
        ? `<span class="course-card__score" title="已出分部分的得分率">得分率 <strong>${grade.scoredRate}</strong></span>`
        : ''}
    </footer>
  </a>
</article>`;
}

// ============================================================
// 详情页
// ============================================================

export function courseDetailPage({
  user,
  course,
  materials,
  assignments,
  assignmentScore,
  canEdit = true,
}) {
  const grade = course.gradeSummary;

  const body = `
${pageHeader({
    title: course.name,
    subtitle: [
      course.code ? `课程号 ${escapeHtml(course.code)}` : '',
      course.term?.name ? escapeHtml(course.term.name) : '',
    ].filter(Boolean).join(' · '),
    breadcrumb: `<a href="/courses">课程</a> ${icon('chevronRight', 12)} ${escapeHtml(course.name)}`,
    actions: `
      <button type="button" class="btn btn--outline btn--sm" data-edit-course="${course.id}">${icon('edit', 16)}<span>编辑</span></button>
      <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-course="${course.id}" data-course-name="${escapeHtml(course.name)}">${icon('trash', 16)}<span>删除</span></button>`,
  })}

<section class="stat-grid stat-grid--4">
  <div class="stat">
    <span class="stat__label">教师</span>
    <span class="stat__value stat__value--text">${escapeHtml(course.teacher || '未填写')}</span>
    ${course.teacher_contact ? `<span class="stat__hint">${escapeHtml(course.teacher_contact)}</span>` : ''}
  </div>
  <div class="stat">
    <span class="stat__label">学分</span>
    <span class="stat__value">${course.credits ?? '—'}</span>
    ${course.hours ? `<span class="stat__hint">${course.hours} 学时</span>` : ''}
  </div>
  <div class="stat">
    <span class="stat__label">考核方式</span>
    <span class="stat__value stat__value--text">${escapeHtml(course.exam_type || '未填写')}</span>
    ${course.category ? `<span class="stat__hint">${escapeHtml(course.category)}</span>` : ''}
  </div>
  <div class="stat ${grade.scoredRate !== null ? 'stat--primary' : ''}">
    <span class="stat__label">已出分部分得分率</span>
    <span class="stat__value">${grade.scoredRate !== null ? grade.scoredRate : '—'}</span>
    <span class="stat__hint">${grade.hasItems
      ? `已出分权重 ${grade.baseWeight}%，已得 ${grade.earnedPoints} 分`
      : '未设置成绩构成'}</span>
  </div>
</section>

<div class="grid grid--2">
  ${card({
    title: '上课时间',
    actions: `<button type="button" class="link" data-edit-sessions="${course.id}">编辑上课时间</button>`,
    body: course.sessions.length
      ? `<table class="table table--compact">
        <thead><tr><th>星期</th><th>时间</th><th>节次</th><th>周次</th><th>地点</th></tr></thead>
        <tbody>${course.sessions.map((s) => `
          <tr>
            <td>${escapeHtml(WEEKDAY_CN[s.weekday] || '')}</td>
            <td>${escapeHtml(s.start_time)} - ${escapeHtml(s.end_time)}</td>
            <td>${s.note
        ? `<span class="muted" title="导入时教务系统原文里写的节次">${escapeHtml(s.note)}</span>`
        : '<span class="muted">—</span>'}</td>
            <td><code>${escapeHtml(s.weeks)}</code></td>
            <td>${escapeHtml(s.location || course.classroom || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="field__help">
        「节次」一列是导入时教务系统原文里写的，用来交叉核对换算对不对。
        如果它和作息时间表对不上，去<a href="/settings#periods">设置 → 作息时间</a>调整。
      </p>
      ${course.exceptions.length ? `
        <div class="subsection">
          <h4 class="subsection__title">调课 / 停课</h4>
          <ul class="plain-list">${course.exceptions.map((e) => `
            <li>${escapeHtml(e.date)}：${e.action === 'cancel' ? '停课' : `调至 ${escapeHtml(e.new_date)} ${escapeHtml(e.new_start_time)}`}
              ${e.note ? `<span class="muted">（${escapeHtml(e.note)}）</span>` : ''}</li>`).join('')}</ul>
        </div>` : ''}`
      : emptyState({
        icon: 'calendar',
        title: '还没有设置上课时间',
        description: '设置后才能在课程表和总览里看到这门课。',
        action: `<button type="button" class="btn btn--outline btn--sm" data-edit-sessions="${course.id}">设置上课时间</button>`,
      }),
  })}

  ${card({
    title: '成绩构成',
    actions: `<button type="button" class="link" data-edit-grades="${course.id}">编辑</button>`,
    body: grade.hasItems
      ? `
      <table class="table table--compact">
        <thead><tr><th>项目</th><th>占比</th><th>得分</th><th></th></tr></thead>
        <tbody>
          ${course.gradeItems.map((g) => {
        const hasScore = g.score !== null && g.score !== undefined && g.score !== '';
        const ratio = hasScore && Number(g.full_score) > 0 ? Number(g.score) / Number(g.full_score) : null;
        return `<tr>
            <td>${escapeHtml(g.name)}</td>
            <td>${escapeHtml(String(g.weight))}%</td>
            <td>${hasScore ? `${escapeHtml(String(g.score))} / ${escapeHtml(String(g.full_score))}` : '<span class="muted">未出分</span>'}</td>
            <td>${ratio !== null ? `<span class="badge badge--${ratio >= 0.85 ? 'success' : ratio >= 0.6 ? 'primary' : 'danger'}">${Math.round(ratio * 100)}%</span>` : ''}</td>
          </tr>`;
      }).join('')}
        </tbody>
      </table>
      <div class="grade-summary">
        <div class="grade-summary__item">
          <span class="muted small">权重合计</span>
          <strong class="${grade.weightsValid ? '' : 'text-warn'}">${grade.totalWeight}%</strong>
          ${!grade.weightsValid ? '<span class="badge badge--warn">不是 100%</span>' : ''}
        </div>
        ${grade.earnedPoints !== null ? `
          <div class="grade-summary__item">
            <span class="muted small">已得分数</span>
            <strong class="text-primary">${grade.earnedPoints}</strong>
          </div>
          <div class="grade-summary__item">
            <span class="muted small">已出分部分得分率</span>
            <strong>${grade.scoredRate}%</strong>
          </div>
          <div class="grade-summary__item">
            <span class="muted small">最终总评区间</span>
            <strong>${grade.worstPossible} ~ ${grade.bestPossible}</strong>
          </div>` : `
          <div class="grade-summary__item">
            <span class="muted small">满分上限</span>
            <strong>${grade.totalWeight}</strong>
          </div>`}
      </div>
      ${grade.earnedPoints !== null ? `
        <p class="muted small mt-sm">
          还剩 <strong>${grade.remainingWeight}%</strong> 的权重没出分。
          剩下的全拿满分最终就是 <strong>${grade.bestPossible}</strong> 分。
        </p>` : ''}
      ${assignmentScore.total > 0 ? `
        <p class="muted small mt-sm">
          这门课登记了 ${assignmentScore.total} 项作业，
          ${assignmentScore.scored > 0 ? `已出分 ${assignmentScore.scored} 项，平均 ${assignmentScore.average} 分。` : '还没有录入作业分数。'}
        </p>` : ''}`
      : emptyState({
        icon: 'check',
        title: '还没有设置成绩构成',
        description: '比如「平时 30% + 期中 20% + 期末 50%」。填好之后能随时估算当前成绩。',
        action: `<button type="button" class="btn btn--outline btn--sm" data-edit-grades="${course.id}">设置成绩构成</button>`,
      }),
  })}
</div>

${card({
    title: `课件资料（${materials.length}）`,
    actions: `<a class="link" href="/materials?courseId=${course.id}">全部 ${icon('chevronRight', 14)}</a>
              <a class="btn btn--primary btn--sm" href="/materials?upload=1&courseId=${course.id}">${icon('upload', 15)}<span>上传</span></a>`,
    body: materials.length
      ? `<ul class="material-list">${materials.slice(0, 8).map(materialRow).join('')}</ul>`
      : `<p class="muted">这门课还没有上传资料。<a href="/materials?upload=1&courseId=${course.id}">上传课件 →</a></p>`,
  })}

${card({
    title: `作业（${assignments.length}）`,
    actions: `<a class="link" href="/assignments?courseId=${course.id}">全部 ${icon('chevronRight', 14)}</a>
              <a class="btn btn--primary btn--sm" href="/assignments?new=1&courseId=${course.id}">${icon('plus', 15)}<span>新建</span></a>`,
    body: assignments.length
      ? `<ul class="task-list">${assignments.map(assignmentRow).join('')}</ul>`
      : `<p class="muted">这门课还没有登记作业。<a href="/assignments?new=1&courseId=${course.id}">新建作业 →</a></p>`,
  })}

${course.notes ? card({ title: '备注', body: `<div class="prose">${nl2br(course.notes)}</div>` }) : ''}
`;

  return { title: course.name, active: 'courses', body };
}

function materialRow(m) {
  return `<li class="material-row">
  <a class="material-row__link" href="/materials/${m.id}">
    <span class="material-row__icon">${m.kindIcon}</span>
    <span class="material-row__body">
      <span class="material-row__title">${escapeHtml(m.title)}</span>
      <span class="material-row__meta">
        ${escapeHtml(m.categoryLabel)} · ${escapeHtml(m.sizeLabel)} · ${escapeHtml(m.created_at?.slice(0, 10) || '')}
      </span>
    </span>
    ${m.canPreview ? '<span class="badge badge--success">可预览</span>' : '<span class="badge">仅下载</span>'}
  </a>
</li>`;
}

function assignmentRow(a) {
  const tone = a.isOverdue ? 'danger' : a.urgency === 'urgent' ? 'warn' : 'neutral';
  return `<li class="task">
  ${assignmentCheck({ id: a.id, status: a.status, title: a.title })}
  <a class="task__main" href="/assignments?highlight=${a.id}">
    <span class="task__title${a.status === 'done' ? ' is-done' : ''}">${escapeHtml(a.title)}</span>
    <span class="task__meta">${escapeHtml(a.dueLabel)} · ${escapeHtml(a.dueDistance)}</span>
  </a>
  <span class="badge badge--${tone}">${escapeHtml(a.status === 'done' ? '已完成' : URGENCY_LABELS[a.urgency] || '')}</span>
</li>`;
}
