/**
 * 课表导入向导页。
 *
 * 三种导入方式并排呈现，用户选一种即可：
 *   1. 上传 .ics  —— 最省事，自动解析
 *   2. 粘贴/上传 CSV —— 从教务系统复制粘贴，或用模板填
 *   3. 手动添加   —— 直接跳到课程表单
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, badge } from '../layout.js';
import { describeSession } from '../../lib/import/ics-import.js';
import { WEEKDAY_CN } from '../../lib/datetime.js';
import { periodsToClock, periodLabel, DEFAULT_PERIOD_SCHEDULE } from '../../lib/periods.js';

export function importPage({
  user,
  terms,
  courses,
  preview,
  mode = 'choose',
  error = '',
  periodSchedule,
  hasCustomPeriods = false,
}) {
  // 没传就退回默认作息表，保证页面永远能渲染
  const schedule = Array.isArray(periodSchedule) && periodSchedule.length
    ? periodSchedule
    : DEFAULT_PERIOD_SCHEDULE;
  const usingDefault = !hasCustomPeriods;
  const body = `
${pageHeader({
    title: '导入课程表',
    subtitle: '把课表导进来，之后就能按周查看、并自动生成日历',
    breadcrumb: `<a href="/courses">课程</a> ${icon('chevronRight', 12)} 导入`,
    actions: `<a class="btn btn--outline btn--sm" href="/courses?new=1">${icon('plus', 15)}<span>跳过，手动添加</span></a>`,
  })}

${error ? `<div class="notice notice--error">
  <div class="notice__icon">${icon('alert', 18)}</div>
  <div class="notice__body"><strong>导入失败</strong><p>${escapeHtml(error)}</p></div>
</div>` : ''}

${preview ? renderPreview(preview, courses, terms) : renderChooser()}

<div class="grid grid--2 mt-lg">
  ${card({
    title: '当前使用的作息时间表',
    actions: `<a class="link" href="/settings#periods">修改 ${icon('chevronRight', 14)}</a>`,
    body: `<table class="table table--compact">
      <thead><tr><th>节次</th><th>时间</th></tr></thead>
      <tbody>
        ${schedule.map((p) => `<tr><td>${escapeHtml(periodLabel(p))}</td><td>${escapeHtml(p.start)} - ${escapeHtml(p.end)}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="field__help">
      导入时如果教务系统给的是「第 3-4 节」而不是具体时间，本平台会按上表换算。
      ${usingDefault
        ? '目前用的是<strong>内置默认值</strong>——和你们学校不一致的话，先去<a href="/settings#periods">设置里改一次</a>，再导入。'
        : '这是<strong>你自己设置的</strong>作息表。'} 导入之后每门课的时间也都能单独调整。
    </p>`,
  })}

  ${card({
    title: '怎么拿到 .ics 文件？',
    body: `
    <p class="small">不同学校的教务系统差别很大，按可能性从高到低试试：</p>
    <ol class="hint-list hint-list--ol">
      <li><strong>教务系统里找「导出」按钮</strong> —— 课表页面常带「导出 / 下载 / 打印」，有的能直接导 ICS 或 Excel。</li>
      <li><strong>教务 App / 小程序</strong> —— 有些学校的课表小程序支持「导出到手机日历」，导出后在手机日历里再导出一次就是 .ics。</li>
      <li><strong>用 Excel 手工整理</strong> —— 从教务系统把课表复制到 Excel，按我们给的 CSV 模板排好列，再导入。这是最通用的兜底方案。</li>
      <li><strong>第三方课表 App</strong> —— 有些 App 支持导入教务系统课表后导出 .ics。</li>
    </ol>
    <p class="field__help">
      本平台预留了「教务系统适配器」的位置。如果你愿意帮忙摸清东财教务系统的接口，
      以后可以做到一键同步。详见 README 的「贡献」一节。
    </p>`,
  })}
</div>
`;

  return { title: '导入课表', active: 'courses', body };
}

function renderChooser() {
  return `<div class="import-options">
  <article class="import-option import-option--featured">
    <div class="import-option__head">
      <span class="import-option__icon">${icon('calendar', 22)}</span>
      <div>
        <h2>上传 .ics 文件</h2>
        ${badge('最省事', 'success')}
      </div>
    </div>
    <p>如果教务系统或手机日历能导出 <code>.ics</code>，直接传上来。会自动识别课程名、教师、上课时间、周次，连「单周/双周」都能还原。</p>
    <form class="form" method="post" action="/import" enctype="multipart/form-data" data-import-ics-form>
      <div class="field">
        <label class="field__label" for="ics_file">选择 .ics 文件</label>
        <input id="ics_file" class="input input--file" type="file" name="file" accept=".ics,text/calendar" required>
      </div>
      <div class="form__row">
        <div class="field field--grow">
          <label class="field__label" for="ics_term">归入学期</label>
          <select id="ics_term" class="input" name="termId">
            <option value="">自动创建 / 使用当前学期</option>
            ${'' /* 由前端填充或服务端渲染 */}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="ics_conflict">课程重名时</label>
          <select id="ics_conflict" class="input" name="onConflict">
            <option value="skip">跳过（推荐）</option>
            <option value="merge">合并周次</option>
            <option value="rename">加后缀新建</option>
          </select>
        </div>
      </div>
      <button type="submit" class="btn btn--primary">${icon('upload', 16)}<span>解析并预览</span></button>
    </form>
  </article>

  <article class="import-option">
    <div class="import-option__head">
      <span class="import-option__icon">${icon('folder', 22)}</span>
      <div>
        <h2>粘贴或上传表格</h2>
        ${badge('最通用', 'primary')}
      </div>
    </div>
    <p>从教务系统把课表复制到 Excel，整理成模板的样子，导出 CSV 传上来。也可以直接把表格内容粘到下面的框里。</p>
    <div class="btn-row">
      <a class="btn btn--outline btn--sm" href="/import?template=csv">${icon('download', 16)}<span>下载 CSV 模板</span></a>
    </div>
    <form class="form mt-sm" method="post" action="/import" enctype="multipart/form-data" data-import-text-form>
      <div class="field">
        <label class="field__label" for="csv_text">粘贴表格内容（第一行是表头）</label>
        <textarea id="csv_text" class="input input--area input--mono" name="text" rows="6"
          placeholder="课程名称,教师,学分,星期,上课时间,周次,上课地点&#10;高等数学(上),张三,5,星期一,08:00-09:40,1-16,之远楼301"></textarea>
      </div>
      <div class="field">
        <label class="field__label" for="csv_file">或者选择 CSV / TXT 文件</label>
        <input id="csv_file" class="input input--file" type="file" name="file" accept=".csv,.txt,.tsv">
      </div>
      <button type="submit" class="btn btn--primary">${icon('upload', 16)}<span>解析并预览</span></button>
    </form>
  </article>

  <article class="import-option">
    <div class="import-option__head">
      <span class="import-option__icon">${icon('edit', 22)}</span>
      <div>
        <h2>手动添加</h2>
        ${badge('课少时最快', 'neutral')}
      </div>
    </div>
    <p>只有几门课，或者导入结果需要修修补补时，直接手填。可以设置每周上课时间、成绩构成、教师联系方式。</p>
    <a class="btn btn--outline" href="/courses?new=1">${icon('plus', 16)}<span>去添加课程</span></a>
  </article>
</div>`;
}

/**
 * 「原始文件诊断」。
 *
 * 加这个的原因：反馈「学分没导进来」时，光看导入结果没法区分
 * 「文件里本来就没有」和「解析漏了」。把文件里实际存在的字段摊开，
 * 一眼就能判断到底是哪种，不用猜。
 */
function renderDiagnostics(diag) {
  if (!diag) return '';

  const {
    rawPropertyNames = [],
    sampleEvent = null,
    found = {},
    courseCount = 0,
  } = diag;

  const chip = (label, count) => {
    const ok = count > 0;
    return `<span class="diag-chip${ok ? ' is-ok' : ' is-missing'}">`
      + `${escapeHtml(label)} <strong>${count}</strong>/${courseCount}</span>`;
  };

  const customEntries = Object.entries(sampleEvent?.custom || {});

  return `
<details class="details">
  <summary>原始文件诊断 —— 这个文件里到底有哪些字段</summary>

  <div class="diag-chips">
    ${chip('教师', found.teacher || 0)}
    ${chip('教室', found.classroom || 0)}
    ${chip('学分', found.credits || 0)}
    ${chip('学时', found.hours || 0)}
  </div>

  ${(found.credits || 0) === 0 ? `
  <div class="notice notice--warn notice--compact">
    <div class="notice__icon">${icon('alert', 16)}</div>
    <div class="notice__body">
      <strong>这个文件里没有找到学分信息</strong>
      <p class="small">
        不是解析漏了——下面是文件里实际存在的字段，可以对照看看。
        学分需要手动补：进课程详情页点右上角「编辑」即可填写学分和学时，
        或者在 CSV 里加一列「学分」，用「合并」方式再导入一次。
      </p>
    </div>
  </div>` : ''}

  ${rawPropertyNames.length
    ? `<p class="small muted">文件里出现过的自定义字段：</p>
       <p class="diag-props">${rawPropertyNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</p>`
    : '<p class="small muted">文件里没有自定义字段（只有 UID / SUMMARY / DTSTART 这些标准字段）。</p>'}

  ${sampleEvent ? `
    <p class="small muted mt-sm">第一个日程的原始内容（用来核对解析结果）：</p>
    <dl class="kv">
      <dt>标题</dt><dd>${escapeHtml(sampleEvent.summary || '（空）')}</dd>
      <dt>地点</dt><dd>${escapeHtml(sampleEvent.location || '（空）')}</dd>
      <dt>描述</dt><dd><pre class="diag-pre">${escapeHtml(sampleEvent.description || '（空）')}</pre></dd>
      ${customEntries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}
    </dl>` : ''}
</details>`;
}

/**
 * 导入预览。
 * 先让用户看清楚「要导入什么」，确认后再写库——避免解析错误把已有课表搞乱。
 */
function renderPreview(preview, courses, terms) {
  const { source, parsed, warnings, termStart, termName, conflict } = preview;

  const totalSessions = parsed.courses.reduce((sum, c) => sum + c.sessions.length, 0);

  return `
<div class="notice notice--info">
  <div class="notice__icon">${icon('check', 20)}</div>
  <div class="notice__body">
    <strong>解析成功，请核对下面的内容</strong>
    <p>
      来源：${escapeHtml(source === 'ics' ? 'ICS 日历文件' : '表格文本')} ·
      识别出 <strong>${parsed.courses.length}</strong> 门课程、
      <strong>${totalSessions}</strong> 条上课时间${termStart ? ` · 学期起始日推断为 <strong>${escapeHtml(termStart)}</strong>` : ''}
    </p>
  </div>
</div>

${warnings.length ? `
<details class="details" open>
  <summary>解析提示（${warnings.length} 条）</summary>
  <ul class="warning-list">
    ${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
  </ul>
</details>` : ''}

${renderDiagnostics(parsed.diagnostics)}

<form class="form" method="post" action="/import" data-confirm-import-form>
  <input type="hidden" name="payload" value="${escapeHtml(JSON.stringify(parsed))}">
  <input type="hidden" name="source" value="${escapeHtml(source)}">
  <input type="hidden" name="termStart" value="${escapeHtml(termStart || '')}">

  <div class="form__row">
    <div class="field field--grow">
      <label class="field__label" for="ci_term">归入学期</label>
      <select id="ci_term" class="input" name="termId">
        ${terms.map((t) => `<option value="${t.id}"${t.is_active ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        <option value="new"${terms.length ? '' : ' selected'}>新建学期：${escapeHtml(termName || '当前学期')}</option>
      </select>
    </div>
    <div class="field">
      <label class="field__label" for="ci_conflict">课程重名时</label>
      <select id="ci_conflict" class="input" name="onConflict">
        <option value="skip">跳过已存在的课程</option>
        <option value="merge">合并到已有课程</option>
        <option value="rename">加后缀新建</option>
      </select>
    </div>
  </div>

  <div class="preview-table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th style="width:32px"><input type="checkbox" data-toggle-all-courses checked></th>
          <th>课程</th><th>教师</th><th>学分</th><th>上课时间</th>
        </tr>
      </thead>
      <tbody>
        ${parsed.courses.map((c, i) => `
          <tr>
            <td><input type="checkbox" name="include" value="${i}" checked></td>
            <td>
              <strong>${escapeHtml(c.name)}</strong>
              ${conflict?.[c.name] ? badge('已存在', 'warn') : ''}
            </td>
            <td>${escapeHtml(c.teacher || '—')}</td>
            <td>${c.credits ?? '—'}</td>
            <td>
              ${c.sessions.map((s) => `
                <div class="session-line">
                  ${escapeHtml(WEEKDAY_CN[s.weekday] || '')} ${escapeHtml(s.startTime)}-${escapeHtml(s.endTime)}
                  <span class="muted">第 ${escapeHtml(s.weeks)} 周</span>
                  ${s.location ? `<span class="muted">@ ${escapeHtml(s.location)}</span>` : ''}
                </div>`).join('') || '<span class="muted">未识别到上课时间</span>'}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="form__actions">
    <a class="btn btn--ghost" href="/import">重新选择文件</a>
    <button type="submit" class="btn btn--primary">${icon('check', 16)}<span>确认导入这 ${parsed.courses.length} 门课</span></button>
  </div>
</form>`;
}

/** 导入结果页 */
export function importResultPage({ result, source }) {
  return {
    title: '导入完成',
    active: 'courses',
    body: `
${pageHeader({
      title: '导入完成',
      subtitle: `新建 ${result.created} 门 · 合并 ${result.merged} 门 · 跳过 ${result.skipped} 门`,
      breadcrumb: `<a href="/import">导入</a> ${icon('chevronRight', 12)} 完成`,
      actions: `<a class="btn btn--primary" href="/timetable">${icon('calendar', 16)}<span>查看课程表</span></a>
                <a class="btn btn--outline" href="/courses">${icon('book', 16)}<span>课程列表</span></a>`,
    })}

${card({
      title: '处理明细',
      body: result.details.length
        ? `<ul class="plain-list">${result.details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
        : '<p class="muted">没有任何变化。</p>',
    })}

<div class="notice notice--info mt-lg">
  <div class="notice__icon">${icon('alert', 18)}</div>
  <div class="notice__body">
    <strong>接下来建议做两件事</strong>
    <ol class="hint-list hint-list--ol">
      <li>去<a href="/settings#term">设置学期</a>，确认「第一周周一」的日期正确——课表的周次全靠它。</li>
      <li>去<a href="/settings#notify">配置手机提醒</a>，这样作业 DDL 才能推送到你手机。</li>
    </ol>
  </div>
</div>`,
  };
}
