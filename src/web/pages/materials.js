/**
 * 资料库页面与在线预览页。
 *
 * 预览是「点开课件就能看」的落地环节，按类型走不同渲染路径：
 *   pdf    → <iframe> 交给浏览器自带的 PDF 阅读器（零成本，效果好）
 *   image  → <img>
 *   video  → <video>，支持进度条拖动（后端已实现 Range 请求）
 *   audio  → <audio>
 *   text   → <pre>，文本在服务端已读好，直接内嵌
 *   office → 转 PDF 成功走 pdf 路径；失败则渲染抽取出来的文本（网页版预览）
 *   other  → 提示下载
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, emptyState, badge, nl2br } from '../layout.js';
import {
  DEFAULT_MATERIAL_CATEGORY,
  MATERIAL_CATEGORIES,
  categoryLabel,
} from '../../lib/materials.js';

// ============================================================
// 资料库列表
// ============================================================

// 分类的筛选标签「全部 + 各分类」。
//
// 从 MATERIAL_CATEGORIES 生成，**不要在这里另抄一份**：以前这里手写了一份，
// 结果它和上传/编辑表单的下拉框都漏了「教材」，而 lib 里那份有 ——
// 于是出现「老数据里显示成教材，但选不了也筛不出来」的半截状态。
const CATEGORY_TABS = [
  { value: '', label: '全部' },
  ...MATERIAL_CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
];

/** 分类下拉框的选项（上传表单和编辑表单共用） */
function categoryOptions(selected) {
  return MATERIAL_CATEGORIES.map(
    (c) => `<option value="${escapeHtml(c.key)}"${c.key === selected ? ' selected' : ''}>${escapeHtml(c.label)}</option>`,
  ).join('');
}

export function materialsPage({ user, materials, courses, stats, filters, storage, uploadFormTemplate = '', editFormTemplate = '' }) {
  const body = `
${pageHeader({
    title: '资料库',
    // 一份也没有的时候不要说「0 份文件 · 共 0 B」——
    // 「0 B」是给程序员看的字节单位，对空库来说既别扭又没信息量。
    subtitle: stats.total ? `${stats.total} 份 · 共 ${stats.totalLabel}` : '',
    actions: `<button type="button" class="btn btn--primary" data-upload-material>${icon('upload', 17)}<span>上传资料</span></button>`,
  })}

<div class="toolbar">
  <form class="search" method="get" action="/materials" role="search">
    ${icon('search', 17)}
    <input class="search__input" type="search" name="q" value="${escapeHtml(filters.keyword || '')}" placeholder="搜索标题、说明、标签，甚至课件正文…">
    ${filters.category ? `<input type="hidden" name="category" value="${escapeHtml(filters.category)}">` : ''}
    ${filters.courseId ? `<input type="hidden" name="courseId" value="${escapeHtml(String(filters.courseId))}">` : ''}
  </form>
  <form class="inline-form" method="get" action="/materials">
    ${filters.keyword ? `<input type="hidden" name="q" value="${escapeHtml(filters.keyword)}">` : ''}
    <select class="input input--sm" name="courseId" onchange="this.form.submit()">
      <option value="">全部课程</option>
      ${courses.map((c) => `<option value="${c.id}"${String(filters.courseId) === String(c.id) ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
    </select>
  </form>
</div>

<div class="filter-tabs">
  ${CATEGORY_TABS.map((tab) => {
    const params = new URLSearchParams();
    if (tab.value) params.set('category', tab.value);
    if (filters.courseId) params.set('courseId', filters.courseId);
    if (filters.keyword) params.set('q', filters.keyword);
    const qs = params.toString();
    // 数字要按**分类**统计。以前这里查的是 stats.byKind（按文件类型统计的
    // ppt/pdf/…），拿它去比对分类键 courseware/assignment/… 永远匹配不上，
    // 于是标签上的数字一个都没显示出来，而且不报任何错。
    const count = tab.value === ''
      ? stats.total
      : (stats.byCategory?.find((k) => k.category === tab.value)?.count || 0);
    return `<a class="filter-tab${filters.category === tab.value ? ' is-active' : ''}" href="/materials${qs ? `?${qs}` : ''}">${escapeHtml(tab.label)}${count ? ` <span class="tab-count">${count}</span>` : ''}</a>`;
  }).join('')}
</div>

${materials.length === 0
      ? emptyState({
        // 这一处直接挂在页面 h1 下面，标题层级要接 h2（默认的 h3 会跳级）
        level: 2,
        icon: 'folder',
        title: filters.keyword ? '没有找到匹配的资料' : '资料库还是空的',
        description: filters.keyword
          ? '试试别的关键词。标题、说明、标签和资料正文都会被搜索。'
          : '把老师发的课件传上来，之后不管在哪台设备上都能直接打开看，不用再翻微信/QQ 聊天记录。',
        action: `<button type="button" class="btn btn--primary" data-upload-material>${icon('upload', 17)}<span>上传资料</span></button>`,
      })
      : `<div class="material-grid">${materials.map(materialCard).join('')}</div>`}

${storage?.lowSpace ? `
<div class="notice notice--warn mt-lg">
  <div class="notice__icon">${icon('alert', 18)}</div>
  <div class="notice__body">
    <strong>磁盘空间不多了</strong>
    <p>资料库已占用 ${escapeHtml(stats.totalLabel)}。建议清理一些不再需要的文件。</p>
  </div>
</div>` : ''}

${uploadFormTemplate}
${editFormTemplate}
`;

  return { title: '资料库', active: 'materials', body };
}

function materialCard(m) {
  return `<article class="material-card" data-material="${m.id}">
  <a class="material-card__link" href="/materials/${m.id}">
    <div class="material-card__preview">
      ${m.kind === 'image'
      ? `<img src="/materials/${m.id}/raw" alt="${escapeHtml(m.title)}" loading="lazy">`
      : `<span class="material-card__icon">${m.kindIcon}</span>`}
      ${m.hasPdf ? '<span class="material-card__flag">PDF</span>' : ''}
    </div>
    <div class="material-card__body">
      <h3 class="material-card__title" title="${escapeHtml(m.original_name)}">${escapeHtml(m.title)}</h3>
      <div class="material-card__meta">
        ${m.course_name
      ? `<span class="dot" style="--dot-color:${escapeHtml(m.course_color || '#3a63e8')}"></span>${escapeHtml(m.course_name)}`
      : '<span class="muted">未归类</span>'}
      </div>
      <div class="material-card__foot">
        <span>${escapeHtml(m.kindLabel)} · ${escapeHtml(m.sizeLabel)}</span>
        <span>${escapeHtml(m.created_at?.slice(5, 10) || '')}</span>
      </div>
    </div>
  </a>
  <div class="material-card__actions">
    <button type="button" class="btn btn--ghost btn--sm" data-edit-material="${m.id}"
            aria-label="编辑「${escapeHtml(m.title)}」的课程归属等信息">${icon('edit', 15)}<span>编辑</span></button>
    <button type="button" class="btn btn--ghost btn--sm btn--icon" data-delete-material="${m.id}"
            data-title="${escapeHtml(m.title)}" title="删除" aria-label="删除「${escapeHtml(m.title)}」">${icon('trash', 15)}</button>
  </div>
</article>`;
}

// ============================================================
// 预览页
// ============================================================

export function materialPreviewPage({ user, material, siblings, textContent, officeData, editFormTemplate = '' }) {
  // 预览有缺憾时要如实告诉用户，并且给一个「重新转换」的入口。
  //
  // 三种情况：
  //   failed          彻底失败
  //   slides + 有错误  图片只导出的一部分（PowerPoint 中途崩了）
  //   office          还是文字版（压根没转成 PDF/图片）
  //
  // 注意：文字版降级时 preview_status 仍然是 ready（文字确实抽出来了），
  // 所以以前这些情况全都不会显示重试按钮 —— 用户修好环境也无路可走，
  // 只能删掉重传。现在只要还处于降级状态就一直留着这个入口。
  const rebuildNotice = material.preview_status === 'failed'
    ? {
      title: '预览未完全生成',
      body: material.preview_error || '转换过程出了点问题。',
    }
    : material.previewMode === 'slides' && material.preview_error
      ? {
        title: '预览不完整',
        body: material.preview_error,
      }
      : material.previewMode === 'office'
        ? {
          title: '这个文件还是文字版预览',
          body: material.preview_error
            || '它还没能转换成 PDF，所以下面是抽取出来的文字和结构，没有原始排版。',
        }
        : null;
  const body = `
${pageHeader({
    title: material.title,
    subtitle: `${escapeHtml(material.original_name)} · ${escapeHtml(material.kindLabel)} · ${escapeHtml(material.sizeLabel)}`,
    breadcrumb: `<a href="/materials">资料库</a> ${icon('chevronRight', 12)} ${escapeHtml(material.title)}`,
    actions: `
      <a class="btn btn--outline btn--sm" href="/materials/${material.id}/raw?download=1">${icon('download', 16)}<span>下载原件</span></a>
      ${material.pdf_name ? `<a class="btn btn--outline btn--sm" href="/materials/${material.id}/pdf?download=1">${icon('download', 16)}<span>下载 PDF</span></a>` : ''}
      <button type="button" class="btn btn--outline btn--sm" data-edit-material="${material.id}">${icon('edit', 16)}<span>编辑</span></button>
      ${material.canPreview
        // 默认 hidden：这个按钮要 JavaScript 才管用，没有 JS 时不该摆一个按不动的按钮。
        // app.js 的 initMaterialViewer() 会把它显示出来。
        ? `<button type="button" class="btn btn--outline btn--sm" data-viewer-fullscreen hidden>${icon('expand', 16)}<span>全屏</span></button>`
        : ''}`,
  })}

<div class="preview-layout">
  <div class="preview-main" data-preview-main>
    ${renderPreview(material, textContent, officeData)}
    <button type="button" class="viewer-exit" data-viewer-exit>
      ${icon('compress', 15)}<span>退出全屏</span>
    </button>
  </div>

  <aside class="preview-side">
    ${card({
    title: '资料信息',
    body: `<dl class="kv">
      <dt>所属课程</dt><dd>${material.course_name ? `<a href="/courses/${material.course_id}">${escapeHtml(material.course_name)}</a>` : '<span class="muted">未归类</span>'}</dd>
      <dt>分类</dt><dd>${escapeHtml(categoryLabel(material.category))}</dd>
      ${material.week ? `<dt>周次</dt><dd>第 ${material.week} 周</dd>` : ''}
      ${material.slide_count ? `<dt>页数</dt><dd>${material.slide_count} 页</dd>` : ''}
      ${material.source ? `<dt>来源</dt><dd>${escapeHtml(material.source)}</dd>` : ''}
      <dt>文件类型</dt><dd>${escapeHtml(material.kindLabel)}</dd>
      <dt>大小</dt><dd>${escapeHtml(material.sizeLabel)}</dd>
      <dt>上传时间</dt><dd>${escapeHtml(material.created_at || '')}</dd>
      ${material.tags ? `<dt>标签</dt><dd>${material.tags.split(',').map((t) => `<span class="tag">${escapeHtml(t.trim())}</span>`).join('')}</dd>` : ''}
    </dl>
    ${material.description ? `<div class="prose mt-sm">${nl2br(material.description)}</div>` : ''}`,
  })}

    ${rebuildNotice ? `
      <div class="notice notice--warn notice--compact">
        <div class="notice__icon">${icon('alert', 16)}</div>
        <div class="notice__body">
          <strong>${escapeHtml(rebuildNotice.title)}</strong>
          <p class="small">${escapeHtml(rebuildNotice.body)}</p>
          <button type="button" class="btn btn--outline btn--sm" data-rebuild-preview="${material.id}">${icon('refresh', 14)}<span>重新转换</span></button>
        </div>
      </div>` : ''}

    ${siblings.length ? card({
      title: '同课程资料',
      body: `<ul class="side-list">${siblings.map((s) => `
        <li><a href="/materials/${s.id}"><span class="side-list__icon">${s.kindIcon}</span><span>${escapeHtml(s.title)}</span></a></li>`).join('')}</ul>`,
    }) : ''}
  </aside>
</div>

${editFormTemplate}
`;

  return { title: material.title, active: 'materials', body, wide: true };
}

/** 依据类型选择预览组件 */
function renderPreview(material, textContent, officeData) {
  const mode = material.previewMode;

  if (mode === 'pdf') {
    // 用 <iframe> 交给浏览器内置的 PDF 阅读器：
    // 支持缩放、翻页、全文检索、打印，而且零 JavaScript 依赖。
    //
    // 但 iPhone / iPad 上的 Safari 是例外：内嵌 PDF 它只渲染第一页，
    // 而且**不给滚动**（不是「没加载完」，就是苹果的限制）。
    // 用户看到的是一份「只有一页的课件」，很容易以为是文件坏了。
    //
    // 所以这里额外准备一块提示，由 app.js 认出 iOS 之后再显示。
    // 默认带 hidden 属性：桌面浏览器不需要这条提示，
    // 而「隐藏」这件事靠的是 app.css 基础层那条 [hidden] { display: none !important } ——
    // 单靠 hidden 属性是不够的，作者样式里任何 display 都会盖掉浏览器默认的 display: none。
    return `<div class="viewer viewer--pdf">
  <div class="viewer__notice" data-ios-pdf-notice hidden>
    <div class="viewer__notice-icon">${icon('alert', 16)}</div>
    <div class="viewer__notice-body">
      <strong>在 iPhone / iPad 上，这里只会显示第一页</strong>
      <p>这是苹果 Safari 对网页内嵌 PDF 的限制，跟文件本身没关系。想看完整内容和翻页，请用下面的按钮打开 —— 会交给系统自带的 PDF 阅读器，缩放、翻页、搜索都正常。</p>
      <a class="btn btn--primary btn--sm" href="/materials/${material.id}/pdf" target="_blank" rel="noopener">${icon('external', 14)}<span>在新标签页打开</span></a>
    </div>
  </div>
  <iframe class="viewer__frame" src="/materials/${material.id}/pdf#view=FitH" title="${escapeHtml(material.title)}"></iframe>
  <div class="viewer__fallback">
    如果你的浏览器没有显示上面的内容，<a href="/materials/${material.id}/pdf" target="_blank" rel="noopener">点此在新标签页打开</a>
    或 <a href="/materials/${material.id}/pdf?download=1">下载 PDF</a>。
  </div>
</div>`;
  }

  if (mode === 'slides') {
    const count = material.slideImageCount || material.slide_count || 0;
    const pages = Array.from({ length: count }, (_, i) => i + 1);
    return `<div class="viewer viewer--slides">
  <div class="viewer__hint">
    共 ${count} 页，每页都是原始排版。点任意一页可以放大翻看。
  </div>
  <ol class="slide-deck"
      data-slide-deck
      data-slide-base="/materials/${material.id}/slide"
      data-slide-total="${count}">
    ${pages.map((n) => `<li class="slide-deck__item">
      <a class="slide-deck__link" href="/materials/${material.id}/slide/${n}"
         data-slide-viewer="${n}" target="_blank" rel="noopener">
        <img class="slide-deck__img" src="/materials/${material.id}/slide/${n}"
             alt="第 ${n} 页" loading="${n <= 2 ? 'eager' : 'lazy'}" decoding="async">
      </a>
      <span class="slide-deck__no">${n}</span>
    </li>`).join('')}
  </ol>
  <div class="viewer__fallback">
    图片是逐页导出的，因此不支持 PDF 那样的全文检索。想要原样文件请
    <a href="/materials/${material.id}/raw?download=1">下载原件</a>。
  </div>
</div>`;
  }

  if (mode === 'image') {
    return `<div class="viewer viewer--image">
  <a href="/materials/${material.id}/raw" target="_blank" rel="noopener" title="点击查看原图">
    <img src="/materials/${material.id}/raw" alt="${escapeHtml(material.title)}">
  </a>
</div>`;
  }

  if (mode === 'video') {
    return `<div class="viewer viewer--media">
  <video src="/materials/${material.id}/raw" controls preload="metadata" playsinline></video>
</div>`;
  }

  if (mode === 'audio') {
    return `<div class="viewer viewer--media">
  <audio src="/materials/${material.id}/raw" controls preload="metadata"></audio>
</div>`;
  }

  if (mode === 'text') {
    return `<div class="viewer viewer--text">
  <pre class="text-view">${escapeHtml(textContent || '（文件是空的）')}</pre>
</div>`;
  }

  if (mode === 'office') {
    return renderOfficePreview(material, officeData, textContent);
  }

  return emptyState({
    icon: 'folder',
    title: '这个格式无法在网页里预览',
    description: `${escapeHtml(material.kindLabel)}文件需要下载后用本地软件打开。`,
    action: `<a class="btn btn--primary" href="/materials/${material.id}/raw?download=1">${icon('download', 17)}<span>下载文件</span></a>`,
  });
}

/**
 * 网页版 Office 预览：PPT 按页渲染，Word 按段落渲染。
 */
function renderOfficePreview(material, officeData, textContent) {
  const banner = `
<div class="notice notice--info notice--compact">
  <div class="notice__icon">${icon('alert', 16)}</div>
  <div class="notice__body">
    <strong>这是网页版预览</strong>
    <p class="small">
      本机没有可用的 Office 转换器，所以这里显示的是从文件里提取出来的文字内容，<strong>排版和图片不会显示</strong>。
      想要看到和原件一模一样的效果，请 <a href="/materials/${material.id}/raw?download=1">下载原件</a>，
      或在设置页检查转换器配置。
    </p>
  </div>
</div>`;

  if (officeData?.slides?.length) {
    return `${banner}
<div class="slides">
  ${officeData.slides.map((slide) => {
    // office.js 的 texts 里包含标题形状的文字，这里要去重，
    // 否则预览页会把标题显示两遍
    const title = String(slide.title || '').trim();
    const bodyTexts = (slide.texts || [])
      .map((t) => String(t || '').trim())
      .filter((t) => t && t !== title);

    return `
    <section class="slide">
      <div class="slide__num">第 ${slide.index} 页</div>
      ${title ? `<h3 class="slide__title">${escapeHtml(title)}</h3>` : ''}
      <div class="slide__body">
        ${bodyTexts.map((t) => `<p>${escapeHtml(t)}</p>`).join('') || '<p class="muted">（这一页没有文字内容）</p>'}
      </div>
      ${slide.notes ? `<div class="slide__notes"><strong>讲者备注：</strong>${escapeHtml(slide.notes)}</div>` : ''}
    </section>`;
  }).join('')}
</div>`;
  }

  if (officeData?.blocks?.length) {
    return `${banner}
<div class="doc-view">
  ${officeData.blocks.map((block) => {
    if (block.type === 'heading') {
      const level = Math.min(Number(block.level) || 1, 4);
      return `<h${level + 1} class="doc-view__heading">${escapeHtml(block.text)}</h${level + 1}>`;
    }
    if (block.type === 'table') {
      return `<table class="table table--compact">${(block.rows || []).map((row, i) => `
        <tr>${row.map((cell) => (i === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('')}</tr>`).join('')}</table>`;
    }
    if (block.type === 'listItem') {
      // office.js 给出了 ordered 字段（来自 word/numbering.xml 的编号格式判断）
      const marker = block.ordered === false ? '•' : '1.';
      return `<p class="doc-view__li">${marker} ${escapeHtml(block.text)}</p>`;
    }
    return block.text ? `<p class="doc-view__p">${escapeHtml(block.text)}</p>` : '';
  }).join('')}
</div>`;
  }

  if (officeData?.sheets?.length) {
    return `${banner}
<div class="sheet-view">
  ${officeData.sheets.map((sheet) => `
    <section class="sheet">
      <h3 class="sheet__name">${escapeHtml(sheet.name)}</h3>
      <div class="sheet__scroll">
        <table class="table table--compact table--grid">
          ${(sheet.rows || []).slice(0, 300).map((row, i) => `
            <tr>${row.map((cell) => (i === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('')}</tr>`).join('')}
        </table>
      </div>
      ${(sheet.rows || []).length > 300 ? '<p class="muted small">只显示前 300 行。</p>' : ''}
    </section>`).join('')}
</div>`;
  }

  // 完全抽不出结构，退回纯文本
  return `${banner}
<div class="viewer viewer--text">
  <pre class="text-view">${escapeHtml(textContent || '（没有提取到可显示的内容，请下载原件查看）')}</pre>
</div>`;
}

// ============================================================
// 上传表单模板
// ============================================================

export function renderUploadForm({ courses, maxUploadMB, currentCourseId }) {
  return `<template id="upload-form-template">
  <form class="form" data-upload-form enctype="multipart/form-data">
    <div class="dropzone" data-dropzone>
      <div class="dropzone__icon">${icon('upload', 28)}</div>
      <p class="dropzone__title">把文件拖到这里，或点击选择</p>
      <p class="dropzone__hint">支持 PDF、PPT、Word、Excel、图片、音视频、文本和压缩包，单个文件最大 ${maxUploadMB} MB</p>
      <input type="file" name="files" multiple class="dropzone__input" data-file-input hidden>
      <button type="button" class="btn btn--outline btn--sm" data-browse>选择文件</button>
    </div>

    <div class="file-queue" data-file-queue hidden></div>

    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="uf_course">归属课程</label>
        <select id="uf_course" class="input" name="courseId">
          <option value="">暂不归类</option>
          ${courses.map((c) => `<option value="${c.id}"${String(currentCourseId) === String(c.id) ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="uf_category">分类</label>
        <select id="uf_category" class="input" name="category">
          ${categoryOptions(DEFAULT_MATERIAL_CATEGORY)}
        </select>
      </div>
      <div class="field field--narrow">
        <label class="field__label" for="uf_week">周次</label>
        <input id="uf_week" class="input" type="number" name="week" min="1" max="30" placeholder="如 5">
      </div>
    </div>

    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="uf_source">来源</label>
        <input id="uf_source" class="input" name="source" placeholder="例如：老师课堂发布 / 学习通 / 教材配套">
      </div>
      <div class="field field--grow">
        <label class="field__label" for="uf_tags">标签</label>
        <input id="uf_tags" class="input" name="tags" placeholder="用逗号分隔，如：重点,期末复习">
      </div>
    </div>

    <p class="field__help">标题默认取文件名，上传后可以逐个修改。</p>

    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="submit" class="btn btn--primary" data-submit disabled>${icon('upload', 16)}<span>开始上传</span></button>
    </div>
  </form>
</template>`;
}

// ============================================================
// 编辑资料表单
// ============================================================

export function renderMaterialEditForm({ courses }) {
  return `<template id="material-edit-template">
  <form class="form" data-material-edit-form>
    <input type="hidden" name="id">
    <div class="field">
      <label class="field__label" for="me_title">标题<span class="field__req">*</span></label>
      <input id="me_title" class="input" name="title" required>
    </div>
    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="me_course">归属课程</label>
        <select id="me_course" class="input" name="courseId">
          <option value="">暂不归类</option>
          ${courses.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="me_category">分类</label>
        <select id="me_category" class="input" name="category">
          ${categoryOptions(DEFAULT_MATERIAL_CATEGORY)}
        </select>
      </div>
      <div class="field field--narrow">
        <label class="field__label" for="me_week">周次</label>
        <input id="me_week" class="input" type="number" name="week" min="1" max="30">
      </div>
    </div>
    <div class="field">
      <label class="field__label" for="me_tags">标签</label>
      <input id="me_tags" class="input" name="tags" placeholder="用逗号分隔">
    </div>
    <div class="field">
      <label class="field__label" for="me_desc">说明</label>
      <textarea id="me_desc" class="input input--area" name="description" rows="3"></textarea>
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="submit" class="btn btn--primary">保存</button>
    </div>
  </form>
</template>`;
}
