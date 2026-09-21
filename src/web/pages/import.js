/**
 * 课表导入向导页。
 *
 * 导入方式并排呈现，用户选一种即可：
 *   1. 上传 .ics  —— 最省事，自动解析
 *   2. 上传 PDF 课表 —— 图抽出来显示在左边，右边照着敲（看 ocr 的替代方案）
 *   3. 粘贴/上传 CSV —— 从教务系统复制粘贴，或用模板填
 *   4. 手动添加   —— 直接跳到课程表单
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, badge } from '../layout.js';
import { describeSession } from '../../lib/import/ics-import.js';
import { WEEKDAY_CN } from '../../lib/datetime.js';
import { periodsToClock, periodLabel, DEFAULT_PERIOD_SCHEDULE } from '../../lib/periods.js';

/** 录入手柄行的列定义：既用来渲染表头，也用来生成 CSV 的列顺序 */
const ENTRY_COLUMNS = ['name', 'teacher', 'weekday', 'periods', 'weeks', 'place'];

/** 录入表格的表头（CSV 第一行必须和它一致，服务端的列名匹配靠它） */
export const ENTRY_CSV_HEADER = '课程名称,教师,学分,星期,上课时间,周次,上课地点';

/**
 * 「看原图 + 手动录入」页。
 *
 * 为什么要有这一页：教务系统导出的课表 PDF，课表主体常常是**一张位图**
 * （我们学校那份就是 3366×1850），文字层里只有标题和学号姓名 ——
 * 文字解析拿不到任何课程内容。剩下两条路：
 *   · OCR：中文课程名错一个字，整学期课表就是错的，而且要往服务器上装
 *     poppler + tesseract + 中文语言包；
 *   · **把原图给用户自己看**：用户读自己的课表零误差，照着敲一遍。
 * 这里走第二条 —— 不装任何东西，也不存在识别准确率问题，
 * 而且换任何学校的课表都能用（不依赖版式识别）。
 *
 * ⚠️ 图是**内联成 data URL** 的，不落盘：
 *   · 服务器上不留用户的课表图片（那上面有课程、教室、教师）
 *   · 也就不需要新增「取图」路由和缓存清理
 * 代价是刷新会丢（重新上传一次即可），以及页面大几百 KB。
 * 对一次性导入来说这个取舍划算。
 *
 * 录入表格最后**生成 CSV 文本**，交给现有的 /import 走
 * 「解析 → 预览 → 确认写库」那条老路 —— 一行新的写库代码都不加。
 * 节次直接填「5-7」，服务端会用**用户自己的作息表**换算成时间。
 *
 * @param {object} p
 * @param {{dataUrl: string, width: number, height: number}} p.scan
 */
export function importManualPage({
  user,
  terms,
  courses,
  scan,
  periodSchedule,
  hasCustomPeriods = false,
  error = '',
}) {
  const schedule = Array.isArray(periodSchedule) && periodSchedule.length
    ? periodSchedule
    : DEFAULT_PERIOD_SCHEDULE;

  const ok = !error && scan.width > 0 && scan.height > 0;

  // ⚠️ 出错时**不渲染录入表格**。
  // 一开始是无条件渲染的，结果解不出图时用户看到的是一张空白占位图 +
  // 一张能填的表格 —— 他会以为"图没显示出来"而照着记忆填一遍，
  // 或者干脆对着白板发呆。没有原图，这个页面就没有意义，
  // 所以那种情况只给错误原因和"换一种方式"的出口。
  const body = `
${pageHeader({
    title: '照着课表录入',
    subtitle: '左边是你的课表原图，右边照着填。填完会先给你看一遍预览，确认后才写进去',
    breadcrumb: `<a href="/import">导入课表</a> ${icon('chevronRight', 12)} 照着录入`,
    actions: `<a class="btn btn--outline btn--sm" href="/import">${icon('chevronLeft', 15)}<span>换一种方式</span></a>`,
  })}

${error ? `<div class="notice notice--error">
  <div class="notice__icon">${icon('alert', 18)}</div>
  <div class="notice__body"><strong>没能读出课表图片</strong><p>${escapeHtml(error)}</p></div>
</div>` : ''}

${ok ? renderScanPanes(scan, schedule, hasCustomPeriods) : `
${card({
    title: '接下来可以怎么做',
    body: `<ul class="hint-list">
      <li>如果教务系统还能导出 <strong>.ics</strong> 或 <strong>Excel/CSV</strong>，回<a href="/import">导入页</a>用那两条路，能自动识别。</li>
      <li>也可以直接<a href="/courses?new=1">手动添加课程</a>，一门一门填。</li>
      <li>课表 PDF 如果是<strong>拍照或扫描</strong>出来的，这里读不出图（那类 PDF 里没有内嵌图片）。</li>
    </ul>`,
  })}`}
`;

  return { title: '照着课表录入', active: 'courses', body, bare: false };
}

/** 两栏：左边原图、右边录入表格 */
function renderScanPanes(scan, schedule, hasCustomPeriods) {
  return `<div class="scan-layout">
  <section class="scan-pane">
    <div class="scan-pane__head">
      <h2 class="scan-pane__title">你的课表原图</h2>
      <span class="muted small">${scan.width}×${scan.height}，可以放大看</span>
    </div>
    ${/* 手机上默认收起（CSS 里按屏宽控制不了 details 的 open，所以靠 JS 折，
         见 initManualImport）：不折的话要滚好几屏才够到录入表格。 */ ''}
    <details class="scan-zoom" open data-scan-zoom>
      <summary class="scan-zoom__summary">展开 / 收起原图</summary>
      <div class="scan-image-wrap">
        <img class="scan-image" src="${scan.dataUrl}"
             alt="你上传的课表，包含每门课的名称、教师、周次、节次和教室">
      </div>
    </details>
  </section>

  <section class="scan-pane">
    <div class="scan-pane__head">
      <h2 class="scan-pane__title">照着填</h2>
      <span class="muted small">不用填满，空行会自动跳过</span>
    </div>

    <form class="form" method="post" action="/import" enctype="multipart/form-data"
          data-manual-import data-entry-template="entry-row-template">
      <input type="hidden" name="text" value="">
      <input type="hidden" name="onConflict" value="skip">

      <div class="entry-scroll">
        <table class="entry-table">
          <thead>
            <tr>
              <th>课程名<span class="field__req">*</span></th>
              <th>教师</th>
              <th>星期</th>
              <th>节次</th>
              <th>周次</th>
              <th>地点</th>
              <th></th>
            </tr>
          </thead>
          <tbody data-entry-rows>
            ${Array.from({ length: 4 }, () => entryRow()).join('')}
          </tbody>
        </table>
      </div>

      <div class="btn-row mt-sm">
        <button type="button" class="btn btn--outline btn--sm" data-add-entry-row>
          ${icon('plus', 15)}<span>再加一行</span>
        </button>
      </div>

      <p class="field__help">
        <strong>节次直接写数字</strong>，比如 <code>1-2</code> 或 <code>5-7</code>；
        时间会按你<strong>自己的作息表</strong>换算
        （现在第 1 节是 ${escapeHtml(schedule[0]?.start || '')}–${escapeHtml(schedule[0]?.end || '')}
        ${hasCustomPeriods
        ? '，这套是你自己设置过的'
        : '，这是内置默认值 —— 如果和你们学校不一样，先去<a href="/settings#periods">设置 → 作息时间</a>改一遍再导入，否则换算出来的时间会是错的'}）。
        同一门课有两段时间就填两行，课程名写一样即可。
      </p>
      <p class="field__help">
        课表里没有学分和学时，这里也留空 —— 不猜比猜错好。要补的话导入完在课程页里改。
      </p>

      <div class="form__actions">
        <button type="submit" class="btn btn--primary">${icon('upload', 16)}<span>解析并预览</span></button>
      </div>
    </form>

    <details class="details mt-md">
      <summary>没有 JavaScript 怎么办？</summary>
      <p class="field__help mt-sm">
        这个表格靠 JavaScript 收集内容，所以浏览器禁用 JS 时用不了。
        那种情况下请回<a href="/import">导入页</a>用「粘贴表格内容」那个文本框 ——
        它是纯表单提交，不需要 JS。第一行表头照抄：
        <code>${escapeHtml(ENTRY_CSV_HEADER)}</code>
      </p>
    </details>
  </section>
</div>

<template id="entry-row-template">
  ${entryRow()}
</template>`;
}

/**
 * 一行录入。
 *
 * 星期用下拉、节次用文本框（不是下拉）：一节课就是 `3`，两节连上是 `3-4`，
 * 下拉表达不了这种区间。文本框加一句提示反而更好用。
 */
function entryRow() {
  const weekdayOptions = WEEKDAY_CN.slice(1).map((label, i) => (
    `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`
  )).join('');
  return `<tr class="entry-row" data-entry-row>
    <td><input class="input input--sm" name="e_name" placeholder="例如：高等数学(上)" maxlength="120"></td>
    <td><input class="input input--sm" name="e_teacher" placeholder="张三" maxlength="80"></td>
    <td><select class="input input--sm" name="e_weekday">
      <option value="">选…</option>${weekdayOptions}
    </select></td>
    <td><input class="input input--sm" name="e_periods" placeholder="1-2" maxlength="20"></td>
    <td><input class="input input--sm input--mono" name="e_weeks" placeholder="1-18" maxlength="60"></td>
    <td><input class="input input--sm" name="e_place" placeholder="之远楼301" maxlength="200"></td>
    <td><button type="button" class="btn btn--ghost btn--icon btn--sm" data-remove-entry-row
                title="删掉这一行" aria-label="删掉这一行">${icon('trash', 15)}</button></td>
  </tr>`;
}

export function importPage({
  user,
  terms,
  courses,
  preview,
  draft,
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

${preview ? renderPreview(preview, courses, terms) : renderChooser(draft)}

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
        ? '当前用的是<strong>内置默认时间</strong>。如果和你们学校的作息不一样，先点上面的「修改」按自己的课表改一遍，再导入。'
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
    </ol>`,
  })}
</div>
`;

  return { title: '导入课表', active: 'courses', body };
}

/**
 * 选择来源这一步。
 *
 * `draft` 是上一次提交失败时留下的内容 —— 解析失败会把用户退回这一屏，
 * 不回填的话**用户粘贴的东西就没了**：教务系统那种页面要重新选一遍、
 * 重新复制一遍。上传的文件是回填不了的（浏览器不允许给 file 输入框赋值），
 * 所以那种情况至少要说清楚「你刚才传的是哪个文件，需要重新选一次」。
 *
 * @param {{text?: string, filename?: string} | undefined} draft
 */
function renderChooser(draft) {
  const draftText = draft?.text || '';
  const draftName = draft?.filename || '';
  return `<div class="import-options">
  <article class="import-option">
    <div class="import-option__head">
      <span class="import-option__icon">${icon('upload', 22)}</span>
      <div>
        <h2>上传课表 PDF</h2>
        ${badge('教务系统导出的那种', 'primary')}
      </div>
    </div>
    <p>
      上传教务系统导出的课表 PDF，平台会把<strong>课表原图</strong>显示出来，
      你照着它填右边那张表就行 —— 填完照样先给你看预览，确认了才写进去。
    </p>
    <p class="field__help">
      为什么不自动识别？教务系统导出的课表，表格部分往往<strong>是一张图片</strong>
      而不是文字，自动识别（OCR）在中文课程名上很容易错一两个字，
      而错一个字整学期的课表就是错的。看着原图自己填<strong>不会错</strong>，
      也换任何学校的课表都能用。
    </p>
    <form class="form" method="post" action="/import/scan" enctype="multipart/form-data">
      <div class="field">
        <label class="field__label" for="scan_file">选择课表 PDF</label>
        <input id="scan_file" class="input input--file" type="file" name="file"
               accept=".pdf,application/pdf" required>
        <p class="field__help">只处理课表那一页；10MB 以内。图只在你这次浏览里用，不会存在服务器上。</p>
      </div>
      <button type="submit" class="btn btn--primary">${icon('upload', 16)}<span>打开课表原图</span></button>
    </form>
  </article>

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
      ${draftName ? `<div class="notice notice--warn">
        <div class="notice__icon">${icon('alert', 18)}</div>
        <div class="notice__body">
          <p>你刚才上传的是 <strong>${escapeHtml(draftName)}</strong>。
          浏览器不允许网页自动把文件放回选择框，所以<strong>需要你重新选一次这个文件</strong>。</p>
        </div>
      </div>` : ''}
      <div class="field">
        <label class="field__label" for="csv_text">粘贴表格内容（第一行是表头）</label>
        <textarea id="csv_text" class="input input--area input--mono" name="text" rows="6"
          placeholder="课程名称,教师,学分,星期,上课时间,周次,上课地点&#10;高等数学(上),张三,5,星期一,08:00-09:40,1-16,之远楼301">${escapeHtml(draftText)}</textarea>
        ${draftText ? `<p class="field__help">这里保留着你上次提交的内容，改完可以直接再点一次「解析并预览」。</p>` : ''}
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

  // ⚠️ 只有真识别出课程才能说「解析成功」。
  // 路由那边已经会把「0 门课」退回选择屏了，这里是第二道防线 ——
  // 万一哪天有人改了路由，也不该出现「解析成功：识别出 0 门课程」这种
  // 自相矛盾的横幅（它比一句明确的失败更难排查）。
  const nothingFound = parsed.courses.length === 0;

  return `
<div class="notice notice--${nothingFound ? 'error' : 'info'}">
  <div class="notice__icon">${icon(nothingFound ? 'alert' : 'check', 20)}</div>
  <div class="notice__body">
    <strong>${nothingFound ? '没能识别出任何课程' : '解析成功，请核对下面的内容'}</strong>
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
