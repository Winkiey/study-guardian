/**
 * 布局与通用 UI 组件。
 *
 * 服务端渲染 HTML + 少量原生 JS 渐进增强。
 * 好处是：断网/禁用 JS 也能看课表，首屏快，不需要构建步骤。
 */

import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { escapeHtml } from '../lib/http.js';

// ============================================================
// 静态资源版本号
// ============================================================

const PUBLIC_DIR = path.join(config.root, 'src', 'web', 'public');

/**
 * 静态资源的版本号，拼在 CSS / JS 的 URL 后面。
 *
 * 为什么需要这个：本项目没有构建步骤，`app.js` / `app.css` 的文件名里
 * 没有内容哈希，浏览器很容易一直用缓存的旧版本。
 * 表现就是——页面上明明有某个按钮，点了却毫无反应，
 * 因为加载的还是上一版 JS，里面根本没有对应的点击处理。
 * （真实反复踩过这个坑，所以这里强制加版本号。）
 *
 * 用「文件大小 + 修改时间」生成，文件一变 URL 就变，
 * 浏览器必然会重新拉取，不依赖用户手动强刷。
 *
 * ⚠ 这里**故意不做缓存**，别「优化」成模块级变量。
 * 之前就是缓存成进程级变量的，结果：
 * 服务器一直开着 → 改了 app.css → 版本号还是旧的 →
 * 而 CSS 的响应头是 immutable（一年）→ 浏览器压根不重新下载。
 * 表现是「改了样式，用户刷新多少次都没变化」，而且完全不报错，极难查。
 * 代价只是每次渲染多做两次 stat（几十微秒），换这个确定性很值。
 */
export function assetVersion() {
  const parts = [];
  for (const file of ['app.js', 'app.css']) {
    try {
      const stat = fs.statSync(path.join(PUBLIC_DIR, file));
      parts.push(`${stat.size.toString(36)}${Math.floor(stat.mtimeMs).toString(36)}`);
    } catch {
      parts.push('0');
    }
  }
  return parts.join('-');
}

/** 带版本号的静态资源地址 */
export function assetUrl(file) {
  return `/static/${file}?v=${assetVersion()}`;
}

/**
 * 把图标路径表嵌进页面，供前端 JS 使用。
 *
 * 为什么要有这个：客户端渲染弹窗时也要画图标，但 `icon()` 只在服务端有。
 * 之前客户端模板里写了 `${icon(...)}` 却没定义，结果一点按钮就抛
 * ReferenceError、弹窗根本打不开——表现就是「点了没反应」。
 * 语法检查查不出来，只有真正点下去才会暴露。
 *
 * 现在改成：服务端把这份数据注入页面，客户端只读它，
 * 两边共用同一个数据源，不会画得不一样。
 *
 * 转义 `<` 是为了防止字符串里出现 `</script>` 序列把标签提前闭合。
 */
export function iconPathsJson() {
  return JSON.stringify(ICON_PATHS).replace(/</g, '\\u003c');
}

// ============================================================
// 图标（内联 SVG，避免额外请求，也不需要字体图标库）
// ============================================================

const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  compress: '<path d="M3 8h3a2 2 0 0 0 2-2V3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};

/**
 * 生成内联 SVG 图标。
 * @param {string} name 图标名
 * @param {number} size 尺寸（px）
 */
export function icon(name, size = 18) {
  const path = ICON_PATHS[name] || ICON_PATHS.alert;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${path}</svg>`;
}

// ============================================================
// 导航配置
// ============================================================

export const NAV_ITEMS = [
  { href: '/', label: '总览', icon: 'home', key: 'dashboard' },
  { href: '/timetable', label: '课程表', icon: 'calendar', key: 'timetable' },
  { href: '/courses', label: '课程', icon: 'book', key: 'courses' },
  { href: '/assignments', label: '作业', icon: 'check', key: 'assignments' },
  { href: '/materials', label: '资料', icon: 'folder', key: 'materials' },
  // 校友社区。放在「资料」后面：社区里就是同校同学公开出来的资料，
  // 两个入口挨着，用户容易理解它们的关系。
  { href: '/community', label: '社区', icon: 'users', key: 'community' },
  { href: '/settings', label: '设置', icon: 'settings', key: 'settings' },
];

// ============================================================
// 页面骨架
// ============================================================

/**
 * 渲染整页 HTML。
 *
 * @param {object} opts
 * @param {string} opts.title 页面标题
 * @param {string} opts.active 当前高亮的导航项 key
 * @param {string} opts.body 主体 HTML
 * @param {object} [opts.user] 当前用户
 * @param {string} [opts.scripts] 页面级脚本
 * @param {object} [opts.stats] 导航栏上的角标数据
 * @param {boolean} [opts.wide] 放宽主体最大宽度
 * @param {boolean} [opts.bare] 不套侧边栏和底部导航（登录/注册这类「还没进站」的页面用）
 */
export function renderPage({ title, active, body, user, scripts = '', stats = {}, wide = false, bare = false }) {
  const fullTitle = title ? `${title} · ${config.appName}` : config.appName;
  /**
   * 为什么登录页要 bare：
   * 未登录时侧边栏那 6 个入口和手机底部导航照常渲染，**点哪一个都会被弹回登录页** ——
   * 看起来像坏了，实际是自己跟自己绕圈。而且底部导航固定在屏幕底部，
   * 会挡住登录表单那一块。登录页本来也不需要站内导航。
   *
   * 另外它还顺手解决了另一个问题：`.main` 有 40/96px 的上下内边距，
   * 而 `.auth-shell` 自己又写 `min-height:100vh`，两个叠起来
   * **内容很短也必然多出一条 136px 的滚动条**。bare 模式下把 .main 的内边距去掉，
   * 高度整个交给 .auth-shell（见 app.css 的 .app-shell--bare 那一条）。
   */
  const shellClass = [
    'app-shell',
    wide ? 'app-shell--wide' : '',
    bare ? 'app-shell--bare' : '',
  ].filter(Boolean).join(' ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f7f8">
<meta name="description" content="课程表、课件在线预览与作业 DDL 提醒，自托管的学习助手">
<title>${escapeHtml(fullTitle)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/static/manifest.webmanifest">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(config.appName)}">
<link rel="stylesheet" href="${assetUrl('app.css')}">
<script>
// 在渲染前套用主题，避免刷新时闪白。
// 顺手把浏览器/状态栏的配色也定下来 —— 手机上（iPhone Safari 的标签栏、
// 从主屏打开时的状态栏）这一块很显眼，不跟着主题走就会和新主色对不上。
// 放在这里而不是 app.js 里，是因为它必须赶在第一帧之前执行完。
(function(){
  try {
    var t = localStorage.getItem('sg-theme');
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    var dark = t === 'dark' || (t !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', '#0e1014');
    }
  } catch (e) {}
})();
</script>
<script type="application/json" id="sg-icon-paths">${iconPathsJson()}</script>
</head>
<body data-asset-version="${escapeHtml(assetVersion())}">
<a class="skip-link" href="#main">跳到主要内容</a>

<div class="${shellClass}">
  ${bare ? '' : `<aside class="sidebar">
    <div class="brand">
      <span class="brand__mark">${icon('book', 20)}</span>
      <span class="brand__text">${escapeHtml(config.appName)}</span>
    </div>
    <nav class="nav" aria-label="主导航">
      ${NAV_ITEMS.map((item) => navLink(item, active, stats)).join('')}
    </nav>
    <div class="sidebar__footer">
      ${user ? `
      <div class="user-chip">
        <span class="user-chip__avatar">${user.avatar_ext
        ? `<img src="/avatar/${escapeHtml(String(user.id))}" alt="">`
        : escapeHtml((user.display_name || user.username || '?').slice(0, 1))}</span>
        <span class="user-chip__name">${escapeHtml(user.display_name || user.username)}</span>
      </div>
      <form method="post" action="/logout" class="logout-form">
        <button type="submit" class="btn btn--ghost btn--sm btn--block">${icon('logout', 16)} 退出登录</button>
      </form>` : ''}
      <button type="button" class="theme-toggle" data-theme-toggle title="切换深色模式">
        ${icon('sun', 16)}<span class="theme-toggle__label">深色模式</span>
      </button>
    </div>
  </aside>`}

  <main class="main" id="main">
    ${body}
  </main>

  ${bare ? `
  ${/* bare 页面没有侧边栏，深色模式开关得单独给一个。
       用图标 + 静态 aria-label：initTheme 找的是「第一个 [data-theme-toggle]」，
       而这个按钮的标签是**动作**（切换深浅色）而不是状态，所以不需要跟着变。 */ ''}
  <button type="button" class="theme-toggle theme-toggle--float" data-theme-toggle
          title="切换深色模式" aria-label="切换深浅色模式">${icon('moon', 18)}</button>`
    : `<nav class="tabbar" aria-label="底部导航">
    ${/*
      之前这里是 NAV_ITEMS.slice(0, 5)，只放前五项。
      但手机端侧边栏是 display:none 的，而「设置」只存在于侧边栏里 ——
      结果是手机上根本进不去设置页，而 Bark 推送、作息表、学期全在那里。
      所以六项全放，栏位也同步改成 6 列（见 app.css 的 .tabbar）。
    */ ''}
    ${NAV_ITEMS.map((item) => navLink(item, active, stats, true)).join('')}
  </nav>`}
</div>

<div class="toast-stack" id="toast-stack" aria-live="polite"></div>
<div class="modal-root" id="modal-root"></div>

<script type="module" src="${assetUrl('app.js')}"></script>
${scripts}
</body>
</html>`;
}

function navLink(item, active, stats, compact = false) {
  const isActive = item.key === active;
  const badge = navBadge(item.key, stats);
  return `<a class="nav__item${isActive ? ' is-active' : ''}" href="${item.href}"`
    + `${isActive ? ' aria-current="page"' : ''}>`
    + `<span class="nav__icon">${icon(item.icon, compact ? 20 : 18)}</span>`
    + `<span class="nav__label">${escapeHtml(item.label)}</span>`
    + (badge ? `<span class="nav__badge">${badge}</span>` : '')
    + '</a>';
}

function navBadge(key, stats) {
  if (key === 'assignments' && stats.pendingAssignments > 0) return String(stats.pendingAssignments);
  if (key === 'materials' && stats.materialCount > 0) return String(stats.materialCount);
  // 社区：同校同学**上次我看过之后**又公开/更新了几份。
  // 看过就清零（进社区页时记一次时间），所以它不是个永远挂着的数字 ——
  // 永远挂着的角标等于没有角标，用户两天就学会无视它。
  if (key === 'community' && stats.communityNew > 0) return String(stats.communityNew);
  return '';
}

/**
 * 页面头部（标题 + 描述 + 操作区）。
 */
export function pageHeader({ title, subtitle = '', actions = '', breadcrumb = null }) {
  return `<header class="page-head">
  ${breadcrumb ? `<nav class="breadcrumb">${breadcrumb}</nav>` : ''}
  <div class="page-head__row">
    <div class="page-head__text">
      <h1 class="page-title">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
    </div>
    ${actions ? `<div class="page-head__actions">${actions}</div>` : ''}
  </div>
</header>`;
}

// ============================================================
// 通用组件
// ============================================================

/**
 * 空状态。
 *
 * `level` 是标题的层级，默认 3（大多数时候它出现在卡片里，而卡片标题是 h2）。
 * ⚠️ 直接挂在页面 h1 下面的那几处要传 2：
 *    模板里写死 h3 的话，标题层级会从 h1 直接跳到 h3，
 *    读屏用户按标题跳转时会缺一级 —— 和「字号看起来对不对」无关，
 *    是给导航结构用的。
 */
export function emptyState({ icon: iconName = 'folder', title, description = '', action = '', level = 3 }) {
  const tag = `h${[2, 3, 4].includes(Number(level)) ? Number(level) : 3}`;
  return `<div class="empty">
  <div class="empty__icon">${icon(iconName, 32)}</div>
  <${tag} class="empty__title">${escapeHtml(title)}</${tag}>
  ${description ? `<p class="empty__desc">${description}</p>` : ''}
  ${action ? `<div class="empty__action">${action}</div>` : ''}
</div>`;
}

/** 徽章 */
export function badge(text, tone = 'neutral') {
  return `<span class="badge badge--${tone}">${escapeHtml(text)}</span>`;
}

/**
 * 作业的「完成」勾选框。
 *
 * 作业页和课程详情页都用它。以前这两处各写了一套标记
 * （一个是 `<button>`，一个是 `<span role="button">`），
 * 结果课程页那个能获得焦点、按回车却没有任何反应——典型的
 * 两套写法各自跑偏。统一成一个真按钮后，键盘和触摸行为自然一致。
 *
 * 交互逻辑全在 app.js 的 initAssignmentChecks() 里：
 * 点一下先问「确认」，确认后才打勾 + 放动画。
 *
 * 打勾标记用 pathLength="1" 把路径长度归一化，
 * 这样 CSS 只要推 stroke-dashoffset 就能把这一笔「画」出来，
 * 不必去算真实路径长度（换路径也不用改样式）。
 */
export function assignmentCheck({ id, status, title = '' }) {
  const isDone = status === 'done';
  const action = isDone ? '标记为未完成' : '标记为已完成';
  const label = title ? `${action}：${title}` : action;

  return `<span class="sg-check" data-check-anchor>
  <button type="button" class="sg-check__box${isDone ? ' is-done' : ''}"
          data-toggle-assignment="${escapeHtml(String(id))}"
          data-status="${escapeHtml(String(status))}"
          data-check-title="${escapeHtml(title)}"
          aria-label="${escapeHtml(label)}"
          title="${escapeHtml(action)}">
    <svg class="sg-check__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 12.8 9.8 17.6 19 7" pathLength="1"
            fill="none" stroke="currentColor" stroke-width="2.6"
            stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  </button>
</span>`;
}

/** 卡片 */
export function card({ title, actions = '', body, className = '', flush = false }) {
  return `<section class="card ${className}">
  ${title || actions ? `<header class="card__head">
    <h2 class="card__title">${escapeHtml(title || '')}</h2>
    ${actions ? `<div class="card__actions">${actions}</div>` : ''}
  </header>` : ''}
  <div class="card__body${flush ? ' card__body--flush' : ''}">${body}</div>
</section>`;
}

/** 统计小卡 */
export function statTile({ label, value, hint = '', tone = 'default', href = '' }) {
  const inner = `<span class="stat__label">${escapeHtml(label)}</span>
    <span class="stat__value">${escapeHtml(String(value))}</span>
    ${hint ? `<span class="stat__hint">${escapeHtml(hint)}</span>` : ''}`;
  return href
    ? `<a class="stat stat--${tone}" href="${href}">${inner}</a>`
    : `<div class="stat stat--${tone}">${inner}</div>`;
}

/** 表单字段 */
export function field({ label, name, type = 'text', value = '', placeholder = '', help = '', required = false, options = null, attrs = '' }) {
  const id = `f_${name}_${Math.random().toString(36).slice(2, 7)}`;
  let control;

  if (type === 'select' && options) {
    control = `<select id="${id}" name="${name}" class="input" ${attrs}>`
      + options.map((o) => `<option value="${escapeHtml(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')
      + '</select>';
  } else if (type === 'textarea') {
    control = `<textarea id="${id}" name="${name}" class="input input--area" placeholder="${escapeHtml(placeholder)}" ${attrs}>${escapeHtml(value)}</textarea>`;
  } else {
    control = `<input id="${id}" name="${name}" type="${type}" class="input" value="${escapeHtml(value)}" `
      + `placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''} ${attrs}>`;
  }

  return `<div class="field">
  <label class="field__label" for="${id}">${escapeHtml(label)}${required ? '<span class="field__req">*</span>' : ''}</label>
  ${control}
  ${help ? `<p class="field__help">${help}</p>` : ''}
</div>`;
}

/** 按钮 */
export function button(text, { variant = 'primary', size = '', type = 'button', attrs = '', iconName = '' } = {}) {
  return `<button type="${type}" class="btn btn--${variant}${size ? ` btn--${size}` : ''}" ${attrs}>`
    + (iconName ? icon(iconName, size === 'sm' ? 15 : 17) : '')
    + `<span>${escapeHtml(text)}</span></button>`;
}

/**
 * 把一段文本渲染成带换行的 HTML（自动转义）。
 */
export function nl2br(text) {
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}

/**
 * 相对时间 + 绝对时间的组合显示，鼠标悬停看详情。
 */
export function timeTag(value, label = '') {
  return `<time class="time-tag" datetime="${escapeHtml(value || '')}" title="${escapeHtml(value || '')}">${escapeHtml(label || value || '')}</time>`;
}
