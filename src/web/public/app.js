/**
 * 前端交互层（原生 JS，无框架、无构建）。
 *
 * 设计原则：**渐进增强**。
 * 所有页面在禁用 JS 的情况下也能看（服务端已把数据渲染成 HTML），
 * JS 只负责让「新建/编辑/删除/上传」这类操作变成弹窗 + 局部刷新，体验更顺。
 */

// ============================================================
// 基础工具
// ============================================================

/**
 * 把「断网」这一类错误翻译成人话。
 *
 * `fetch` 在连不上时抛的是 `TypeError: Failed to fetch`（Safari 是 `Load failed`，
 * Node/undici 是 `fetch failed`）—— 这些字符串对用户没有任何意义，
 * 但以前它们会被原样弹到手机上（见调用点的 catch → toast(err.message)）。
 *
 * 判断只看消息文本，不看 `instanceof TypeError`：
 * 各浏览器抛的类型和措辞都不一样，认字符串反而更稳。识别不出来就原样返回，
 * 不能把「服务器返回的业务错误」也误判成断网（那会把真正的原因盖掉）。
 *
 * @param {unknown} err
 * @returns {string} 给用户看的中文
 */
function describeFetchError(err) {
  const raw = String(err?.message || err || '').trim();
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|network error|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i.test(raw)) {
    return '网络连接失败：请检查手机的网络（或确认服务还在运行），然后重试';
  }
  return raw || '操作失败';
}

/** 统一的 fetch 封装：自动带 Cookie、处理 JSON、把服务端错误转成异常 */
async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options };

  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    // 网络层就没通：换成中文再抛出，调用点的 catch → toast 里就是人话了
    throw new Error(describeFetchError(err));
  }
  const text = await res.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** 弹出提示条 */
function toast(message, type = 'info', duration = 3600) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const iconEl = document.createElement('span');
  iconEl.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'ℹ';
  const textEl = document.createElement('span');
  textEl.textContent = message;

  el.append(iconEl, textEl);
  stack.appendChild(el);

  setTimeout(() => {
    el.style.transition = 'opacity 200ms, transform 200ms';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

/**
 * 全局兜底用的提示：**同一个错误只说一次**。
 *
 * 为什么需要去重：toast 现在没有任何抑制，同一个错误如果每次操作都抛
 * （比如某个初始化函数坏了），用户会看到一模一样的提示条叠满屏幕，
 * 反而盖住了真正要看的东西。全局兜底是「最后一道网」，
 * 它的职责是提醒一次，不是把每一次都播报出来。
 */
const reportedGlobalErrors = new Set();

function reportGlobalError(message) {
  const text = String(message || '操作失败');
  if (reportedGlobalErrors.has(text)) return;
  reportedGlobalErrors.add(text);
  toast(text, 'error', 6000);
}

/** 确认对话框（用原生 confirm，简单可靠；后续可换成自绘弹窗） */function confirmAction(message) {
  return window.confirm(message);
}

// ============================================================
// 图标
//
// 图标路径数据由服务端注入页面（见 layout.js 的 iconPathsJson），
// 两边共用同一份，不会画出不一样的图。
//
// 注意这里是**必须存在**的：客户端在弹窗模板里会用到 ${icon(...)}，
// 一旦没有定义，模板一求值就抛 ReferenceError，
// 表现就是「点了按钮完全没反应」——而且语法检查查不出来。
// ============================================================

const ICON_PATHS = (() => {
  try {
    const el = document.getElementById('sg-icon-paths');
    if (!el) return {};
    const parsed = JSON.parse(el.textContent || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();

/**
 * 生成内联 SVG 图标。
 * @param {string} name 图标名，取自 layout.js 的 ICON_PATHS
 * @param {number} size 尺寸（px）
 */
function icon(name, size = 18) {
  const path = ICON_PATHS[name] || ICON_PATHS.alert || '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"`
    + ` stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true">${path}</svg>`;
}

// ============================================================
// 弹窗系统
// ============================================================

const modalRoot = () => document.getElementById('modal-root');

let modalCloseHandler = null;
/** 打开弹窗之前焦点在哪个元素上 —— 关掉之后要还回去 */
let modalReturnFocus = null;

/**
 * 弹窗里「能按 Tab 走到」的元素，按 DOM 顺序。
 *
 * 过滤掉禁用的、以及被 display:none / hidden 藏起来的：
 * 焦点陷阱如果算上这些，按 Tab 会「消失一下」再出现，很难受。
 */
function focusableIn(el) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(el.querySelectorAll(sel))
    .filter((n) => !n.hasAttribute('hidden') && n.offsetParent !== null);
}

/**
 * 焦点陷阱的核心逻辑。
 *
 * 单独抽成函数，是为了能被测试**直接调用**：
 * 写在 openModal 的 keydown 回调里的话，测试只能去 grep 源码，
 * 而 grep 测不出「按 Tab 到底会不会跑出去」—— 把 `if (true) return;`
 * 插进去，所有字符串都还在，断言照样是绿的（A/B 校验时就是这么假通过的）。
 *
 * 规则：在最后一个元素上再按 Tab → 回到第一个；
 * 在第一个元素上按 Shift+Tab → 跳到最后一个。
 * 另外焦点要是已经跑到弹窗外面了（被脚本挪走之类），也拉回来。
 */
function trapTabKey(modal, e) {
  const items = focusableIn(modal);
  if (!items.length) return;

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = modal.contains(active);

  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * 把焦点还给「打开弹窗的那个元素」。
 *
 * 不还的话，键盘用户关掉弹窗后焦点掉回 <body>，得从头 Tab 一整遍
 * 才能回到刚才那个按钮。也抽出来单独成函数，原因同上：能测。
 */
function restoreModalFocus() {
  const target = modalReturnFocus;
  modalReturnFocus = null;
  // 目标可能已经被重新渲染掉了（列表刷新之类），所以先确认它还在文档里
  if (!target || !document.contains(target)) return;
  try {
    target.focus({ preventScroll: true });
  } catch { /* 元素可能已经不接受焦点了 */ }
}

/**
 * 打开弹窗。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {HTMLElement|string} opts.content 内容（DOM 元素或 HTML 字符串）
 * @param {boolean} [opts.wide] 是否宽弹窗
 */
function openModal({ title, content, wide = false }) {
  const root = modalRoot();
  if (!root) return;

  closeModal();

  // 记住「是谁打开的」，关掉之后焦点要还回去。
  // 不还的话，键盘用户关掉弹窗后焦点会掉回 <body>，
  // 得从头 Tab 一遍才能回到刚才那个按钮。
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = `modal${wide ? ' modal--wide' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'modal__head';
  const h = document.createElement('h2');
  h.className = 'modal__title';
  h.id = 'modal-title';
  h.textContent = title || '';
  // 让读屏能念出「这是哪个弹窗」。role=dialog 不会自动去取里面的标题，
  // 必须显式指过去，否则读屏只会念一个没有名字的「对话框」。
  modal.setAttribute('aria-labelledby', h.id);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal__close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeModal);
  head.append(h, closeBtn);

  const body = document.createElement('div');
  body.className = 'modal__body';
  if (content instanceof Node) body.appendChild(content);
  else body.innerHTML = content;

  modal.append(head, body);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  // 点遮罩关闭（点内容区域不关）
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });

  modalCloseHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      return;
    }
    if (e.key !== 'Tab') return;

    // ---- 焦点陷阱 ----
    // 不拦住的话，按 Tab 会走到**弹窗背后那些被遮住的元素**上：
    // 侧边栏导航、页面上的按钮都还在 DOM 里、也还能拿到焦点。
    // 用户接着按回车，触发的是他看不见的东西（比如某个「删除」），
    // 这就是「我什么都没点，怎么删了」的来源。
    trapTabKey(modal, e);
  };
  document.addEventListener('keydown', modalCloseHandler);

  // 聚焦第一个输入框；没有输入框就聚焦关闭按钮 ——
  // 焦点必须落到弹窗**里面**，否则一开始就不在陷阱里
  const firstInput = modal.querySelector('input:not([type=hidden]), select, textarea');
  const initial = firstInput || closeBtn;
  setTimeout(() => initial.focus({ preventScroll: true }), 50);

  // 阻止背景滚动
  document.body.style.overflow = 'hidden';

  return modal;
}

function closeModal() {
  const root = modalRoot();
  if (root) root.innerHTML = '';
  if (modalCloseHandler) {
    document.removeEventListener('keydown', modalCloseHandler);
    modalCloseHandler = null;
  }
  document.body.style.overflow = '';

  // 焦点还给打开它的那个元素
  restoreModalFocus();
}

/** 从 <template> 里取出内容并克隆 */
function fromTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`找不到模板 ${id}`);
  return tpl.content.cloneNode(true);
}

/** 表单转对象（复选框同名的收集成数组） */
function formToObject(form) {
  const data = {};
  const fd = new FormData(form);
  for (const [key, value] of fd.entries()) {
    if (data[key] === undefined) data[key] = value;
    else if (Array.isArray(data[key])) data[key].push(value);
    else data[key] = [data[key], value];
  }
  // 未勾选的复选框不会出现在 FormData 里
  for (const el of form.querySelectorAll('input[type=checkbox]')) {
    if (!el.name) continue;
    if (!(el.name in data)) data[el.name] = el.checked ? '1' : '';
    else data[el.name] = el.checked ? '1' : '';
  }
  return data;
}

/**
 * 解析用户填的「数量」（学分、学时这类）。
 *
 * 为什么不用 <input type="number">：
 * 那种输入框遇到「3学分」「3 学分」这种带单位的写法时，
 * **界面上照样显示你输入的文字，但 input.value 会变成空字符串**，
 * 提交上去就成了空值——表现就是「明明填了、也点了保存，但值没变」。
 * 这是个非常容易踩的坑（真实踩过），所以改成普通文本框 + 自己解析，
 * 容忍单位、空格、全角数字。
 *
 * @param {string} value
 * @param {{max?:number}} [opts]
 * @returns {{value:number|null, error:string}} error 非空表示填的内容无法解析
 */
function parseAmountInput(value, { max = 1000 } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return { value: null, error: '' };

  // 全角数字转半角，方便「３」这类输入
  const normalized = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // 负号不在数字正则里，不显式拦住的话「-1」会被当成「1」——
  // 静默把负数变成正数，比直接报错更糟
  if (normalized.includes('-')) return { value: null, error: `「${s}」不能是负数` };

  const m = /(\d+(?:\.\d+)?)/.exec(normalized);
  if (!m) return { value: null, error: `「${s}」不是数字` };

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    return { value: null, error: `「${s}」超出合理范围（0 ~ ${max}）` };
  }
  return { value: n, error: '' };
}

/** 比较两个数量是否一致（null / '' / 数字 都归一化后比较） */
function sameAmount(a, b) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return norm(a) === norm(b);
}

// ============================================================
// 主题切换
// ============================================================

/**
 * 切换主题时同步浏览器/状态栏配色。
 *
 * 首帧那份在 layout.js 的内联脚本里做（必须赶在绘制前），
 * 这里只管「用户手动点了切换按钮」之后的变化。
 */
function syncThemeColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1014' : '#f6f7f8');
}

/**
 * 深浅色。
 *
 * 两种入口共用这一套逻辑：
 *   [data-theme-toggle]  侧栏底部那个按钮（桌面）—— 点一下就换
 *   [data-theme-choice]  设置 → 外观 里的三个选项 —— 明确选一种
 *
 * 为什么必须有第二套入口：
 *   · 手机上侧栏是 display:none，藏在里面的开关**点不到** —— 也就是手机上
 *     根本没有切换深浅色的地方，只能跟着手机系统走。
 *   · 那个按钮是「切换」，不是「选择」：点过一次之后就固定在
 *     localStorage 里了，**再也回不到「跟随系统」**。
 *     （想回去只能清浏览器数据，没人会想到这么干。）
 * 第二套入口同时解决这两件事。
 *
 * 存法的约定和页面顶部那段内联脚本一致：只存 'dark' / 'light'，
 * 选「跟随系统」就把键**删掉** —— 内联脚本靠「值不是这两个」来判定跟随系统。
 */
function initTheme() {
  const root = document.documentElement;
  const toggles = [...document.querySelectorAll('[data-theme-toggle]')];
  const choices = [...document.querySelectorAll('[data-theme-choice]')];
  if (!toggles.length && !choices.length) return;

  const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /** 用户选的是什么（含『跟随系统』），不是"当前显示的是深还是浅" */
  const preference = () => {
    try {
      const saved = localStorage.getItem('sg-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch { /* 隐私模式下 localStorage 可能不可用 */ }
    return 'system';
  };

  /** 当前实际显示的是深还是浅 */
  const actual = () => {
    const pref = preference();
    if (pref !== 'system') return pref;
    return systemQuery.matches ? 'dark' : 'light';
  };

  const sync = () => {
    const pref = preference();
    const shown = actual();

    // 侧栏按钮的标签是**动作**（点了会变成什么），不是当前状态
    for (const btn of toggles) {
      const label = btn.querySelector('.theme-toggle__label');
      if (label) label.textContent = shown === 'dark' ? '浅色模式' : '深色模式';
    }

    // 三个选项标记当前选中的那个
    for (const btn of choices) {
      const on = btn.dataset.themeChoice === pref;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    }

    syncThemeColor(shown);
  };

  /** @param {'system'|'light'|'dark'} next */
  const apply = (next) => {
    if (next === 'system') {
      root.removeAttribute('data-theme');
      try { localStorage.removeItem('sg-theme'); } catch { /* 同上 */ }
    } else {
      root.dataset.theme = next;
      try { localStorage.setItem('sg-theme', next); } catch { /* 同上 */ }
    }
    sync();
  };

  for (const btn of toggles) {
    btn.addEventListener('click', () => apply(actual() === 'dark' ? 'light' : 'dark'));
  }
  for (const btn of choices) {
    btn.addEventListener('click', () => apply(btn.dataset.themeChoice));
  }

  // 选了「跟随系统」的时候，用户在系统里换了主题，网页要跟着变 ——
  // 不监听的话得手动刷新页面才生效，看起来像"这个选项没作用"。
  const onSystemChange = () => { if (preference() === 'system') sync(); };
  if (systemQuery.addEventListener) systemQuery.addEventListener('change', onSystemChange);
  else if (systemQuery.addListener) systemQuery.addListener(onSystemChange);

  sync();
}

// ============================================================
// 通用：复制、全选、打开目录
// ============================================================

function initMisc() {
  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const text = copyBtn.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'success');
      } catch {
        // 非 HTTPS 环境下 clipboard API 不可用，退回到选中输入框
        const input = copyBtn.parentElement?.querySelector('input');
        if (input) {
          input.select();
          toast('已选中，请按 Ctrl+C 复制', 'info');
        } else {
          toast('复制失败，请手动选择文本', 'error');
        }
      }
      return;
    }

    const toggleAll = e.target.closest('[data-toggle-all-courses]');
    if (toggleAll) {
      const table = toggleAll.closest('table');
      for (const cb of table.querySelectorAll('tbody input[type=checkbox]')) {
        cb.checked = toggleAll.checked;
      }
    }
  });
}

// ============================================================
// 幻灯片看图器
// ============================================================

/**
 * 点开课件里的某一页，放大翻看。
 *
 * 为什么不能直接让链接在新标签页打开原图：
 * 那样打开的是一张「裸图」——没有返回按钮、没法翻页，只能靠浏览器后退。
 * 而这个平台是 PWA（有 manifest），装到 iOS 主屏之后链接可能开在同一个
 * webview 里，既没有地址栏也没有后退键 —— 用户就真的**退不出来了**。
 * 真实反馈：「点进 ppt 单页图片有 bug，退不出来，然后也不能翻页」。
 *
 * 所以改成页面内的浮层：看图不离开当前页面，翻页、关闭都在浮层里，
 * Esc 和左右方向键也管用，手机上还能左右滑。
 *
 * 原来的 <a href> 保留着：禁用 JS 时它就是普通的「打开图片」，
 * 属于渐进增强的兜底。
 */
function initSlideViewer() {
  const deck = document.querySelector('[data-slide-deck]');
  if (!deck) return;

  const base = deck.dataset.slideBase;
  const total = Number(deck.dataset.slideTotal) || 0;
  if (!base || total < 1) return;

  const urlFor = (n) => `${base}/${n}`;

  let overlay = null;
  let imgEl = null;
  let countEl = null;
  let rawEl = null;
  let index = 0;
  let onKey = null;
  /** 是否往历史里压过一条记录（用于「右滑返回 = 关闭看图器」） */
  let pushed = false;

  /** 相邻页先悄悄拉下来，翻页时才不会有等待感 */
  function preload(n) {
    if (n < 1 || n > total) return;
    const pre = new Image();
    pre.src = urlFor(n);
  }

  function paint() {
    imgEl.src = urlFor(index);
    imgEl.alt = `第 ${index} 页`;
    countEl.textContent = `${index} / ${total}`;
    rawEl.href = urlFor(index);

    // 到头了就禁用，省得用户点了没反应还以为坏了
    overlay.querySelector('[data-sv-prev]').disabled = index <= 1;
    overlay.querySelector('[data-sv-next]').disabled = index >= total;

    preload(index - 1);
    preload(index + 1);
  }

  function step(delta) {
    const next = index + delta;
    if (next < 1 || next > total) return;
    index = next;
    paint();
  }

  /**
   * 关闭浮层。
   *
   * fromPop 表示这次是「浏览器后退」触发的：手机用户看到全屏浮层，
   * 本能就是右滑返回。如果那一下直接退出了整个课件页，就是「退不出来」。
   * 所以打开时压一条历史记录，后退先关浮层；关浮层时再把那条记录退掉，
   * 保证浏览器历史不会被我们搞乱。
   */
  function close({ fromPop = false } = {}) {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (onKey) {
      document.removeEventListener('keydown', onKey);
      onKey = null;
    }
    document.body.style.overflow = '';

    if (pushed) {
      pushed = false;
      if (!fromPop) history.back();
    }

    // 焦点还给刚才点的那一页，键盘用户不会「掉」到页面顶部
    deck.querySelector(`[data-slide-viewer="${index}"]`)?.focus({ preventScroll: true });
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'slide-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '幻灯片查看');
    overlay.innerHTML = `
      <div class="slide-viewer__bar">
        <span class="slide-viewer__count" data-sv-count></span>
        <div class="slide-viewer__actions">
          <a class="slide-viewer__btn slide-viewer__btn--wide" data-sv-raw
             target="_blank" rel="noopener" title="在新标签页打开原图">${icon('external', 15)}<span>原图</span></a>
          <button type="button" class="slide-viewer__btn slide-viewer__btn--close" data-sv-close
                  aria-label="关闭" title="关闭（Esc）">×</button>
        </div>
      </div>
      <button type="button" class="slide-viewer__nav slide-viewer__nav--prev" data-sv-prev
              aria-label="上一页" title="上一页（←）">${icon('chevronLeft', 26)}</button>
      <img class="slide-viewer__img" data-sv-img decoding="async" alt="">
      <button type="button" class="slide-viewer__nav slide-viewer__nav--next" data-sv-next
              aria-label="下一页" title="下一页（→）">${icon('chevronRight', 26)}</button>
      <p class="slide-viewer__hint">← → 翻页 · Esc 关闭 · 手机上左右滑动也行</p>`;

    document.body.appendChild(overlay);
    imgEl = overlay.querySelector('[data-sv-img]');
    countEl = overlay.querySelector('[data-sv-count]');
    rawEl = overlay.querySelector('[data-sv-raw]');

    overlay.querySelector('[data-sv-close]').addEventListener('click', close);
    overlay.querySelector('[data-sv-prev]').addEventListener('click', () => step(-1));
    overlay.querySelector('[data-sv-next]').addEventListener('click', () => step(1));

    // 点空白处关掉（点图片本身不关，免得想放大却退出去了）
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.classList.contains('slide-viewer__bar')) close();
    });

    onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    document.addEventListener('keydown', onKey);

    // 手机左右滑
    let startX = 0;
    let startY = 0;
    overlay.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    overlay.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      // 竖直方向动得多就当成滚动，别误判成翻页
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      step(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.body.style.overflow = 'hidden';
  }

  function open(n) {
    index = Math.min(Math.max(n, 1), total);
    if (!overlay) build();
    paint();

    // 压一条历史记录，这样手机右滑返回是关掉浮层，而不是退出整个课件页
    if (!pushed) {
      pushed = true;
      history.pushState({ sgSlideViewer: true }, '');
    }

    overlay.querySelector('[data-sv-close]').focus({ preventScroll: true });
  }

  // 后退 = 关浮层（这时不能再调用 history.back，否则会连退两层）
  window.addEventListener('popstate', () => {
    if (overlay) close({ fromPop: true });
  });

  deck.addEventListener('click', (e) => {
    const link = e.target.closest('[data-slide-viewer]');
    if (!link) return;
    // 按住 Ctrl/Cmd 点、中键点这些「就想在新标签页打开」的意图要尊重
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    open(Number(link.dataset.slideViewer));
  });
}

// ============================================================
// 作业勾选：二次确认 + 完成动画
// ============================================================

/**
 * 为什么不是「点一下就完事」。
 *
 * 那个方格只有 22px，手机上闭着眼也能点歪。而标记完成不只是改个状态——
 * 它会**顺手把这项作业的所有提醒取消掉**。误触的代价不是「难看」，
 * 而是「你以为还有提醒，其实已经没了，然后错过 DDL」。
 * 所以统一走两步：点一下原地弹出确认按钮，再点「标记完成」才真的生效。
 *
 * 同时只允许开一个确认条，避免连点几下弹出好几个。
 */
let dismissCheckConfirm = null;

/** 用户是否在系统里开了「减弱动态效果」 */
function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * 在方格旁边弹确认条。
 * 返回 Promise：确认 → true，取消/点别处/超时 → false。
 *
 * 用 Promise 是为了让调用处读起来是一条直线：
 *   const ok = await askCheckConfirm(box, toDone);
 *   if (!ok) return;
 */
function askCheckConfirm(box, toDone) {
  return new Promise((resolve) => {
    // 已经有别的确认条开着就先收掉
    dismissCheckConfirm?.();

    const anchor = box.closest('[data-check-anchor]');
    if (!anchor) {
      resolve(false);
      return;
    }

    const el = document.createElement('div');
    el.className = 'check-confirm';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', toDone ? '确认标记完成' : '确认恢复待办');
    el.innerHTML = `
      <p class="check-confirm__ask">${toDone ? '完成这项作业？' : '恢复为未完成？'}</p>
      <p class="check-confirm__hint">${toDone ? '它的提醒会被取消' : '它的提醒会重新排上'}</p>
      <div class="check-confirm__actions">
        <button type="button" class="btn btn--primary btn--sm" data-confirm>
          ${icon('check', 15)}<span>${toDone ? '标记完成' : '恢复待办'}</span>
        </button>
        <button type="button" class="btn btn--ghost btn--sm" data-dismiss>取消</button>
      </div>`;

    // 挂到 body 上而不是方格里面。
    // 课程详情页的作业列表在 .card 里，而 .card 有 overflow: hidden，
    // 挂在里面的话弹出来的确认条会被整块裁掉。挂 body 上就没有这个问题。
    document.body.appendChild(el);
    anchor.classList.add('is-armed');
    positionConfirm(el, box);
    el.classList.add('is-positioned'); // 摆好位置再显示，避免在左上角闪一下

    /** 保证只结算一次（点确认的同时按回车之类的并发情况） */
    let settled = false;

    // 定时器要在 finish 之前声明：finish 里会 clearTimeout，
    // 声明放在后面虽然运行时不会出错（finish 总是异步调用），但太脆了。
    const timer = setTimeout(() => finish(false), 8000);

    // fixed 定位是相对视口的，页面一滚就错位了，所以要跟着重新算。
    // 用 rAF 节流：滚动事件很密，每次都量一遍尺寸没必要。
    let raf = 0;
    const followBox = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 方格已经不在页面上了（列表刷新掉了）就别跟着算了
        if (!box.isConnected) {
          finish(false);
          return;
        }
        positionConfirm(el, box);
      });
    };

    function finish(answer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onOutside, true);
      window.removeEventListener('resize', followBox);
      window.removeEventListener('scroll', followBox, true);
      el.remove();
      anchor.classList.remove('is-armed');
      dismissCheckConfirm = null;
      resolve(answer);
    }
    dismissCheckConfirm = () => finish(false);

    // Esc 取消、回车确认——键盘用户不用去够鼠标
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // 别让 Esc 顺手把后面的弹窗也关了
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };

    // 点别处 = 反悔。点在同一格上不算「别处」，
    // 那种情况交给下面那个委托处理器判断（再点一下 = 取消）。
    const onOutside = (e) => {
      if (el.contains(e.target) || box.contains(e.target)) return;
      finish(false);
    };

    el.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
    el.querySelector('[data-dismiss]').addEventListener('click', () => finish(false));

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onOutside, true);
    // 滚动/改窗口大小都不收起，只是重新定位 —— 收起会把 iOS 上
    // 地址栏收缩引起的一点点滚动也当成「反悔」，那样很难用
    window.addEventListener('scroll', followBox, true);
    window.addEventListener('resize', followBox);

    el.querySelector('[data-confirm]').focus({ preventScroll: true });
  });
}

/**
 * 把确认条摆到方格旁边（fixed 坐标，相对视口算）。
 *
 * 默认贴在方格下面；下面放不下就翻到上面。
 * 左右也要夹一下，免得在窄屏上顶出屏幕外。
 * 只负责设坐标，显不显示由调用方决定。
 */
function positionConfirm(el, box) {
  const gap = 8;
  const edge = 8;
  const rect = box.getBoundingClientRect();

  const width = el.offsetWidth;
  const height = el.offsetHeight;

  // 方格靠近左边缘时别贴出屏幕；靠近右边时往左收
  const left = Math.max(edge, Math.min(rect.left - 4, window.innerWidth - width - edge));
  el.style.left = `${Math.round(left)}px`;

  const below = rect.bottom + gap;
  if (below + height > window.innerHeight - edge) {
    // 下面放不下 → 翻到上面；上面也放不下（屏幕特别矮）就贴着顶边
    el.style.top = `${Math.round(Math.max(edge, rect.top - gap - height))}px`;
    el.classList.add('is-above');
  } else {
    el.style.top = `${Math.round(below)}px`;
    el.classList.remove('is-above');
  }
}

/** 只改视觉，不动数据。（乐观更新用，失败了要能退回来） */
function paintCheckBox(box, isDone) {
  box.classList.toggle('is-done', isDone);
  box.dataset.status = isDone ? 'done' : 'todo';

  const action = isDone ? '标记为未完成' : '标记为已完成';
  const title = box.dataset.checkTitle || '';
  box.setAttribute('aria-label', title ? `${action}：${title}` : action);
  box.setAttribute('title', action);

  // 卡片本身的样式（删除线、变灰）也跟着走
  const card = box.closest('.assignment');
  if (card) card.classList.toggle('is-done', isDone);
  const taskTitle = box.closest('.task')?.querySelector('.task__title');
  if (taskTitle) taskTitle.classList.toggle('is-done', isDone);
}

/**
 * 放一小圈彩色粒子。
 *
 * 没引任何库，就是十几个小方块，各自带一组 CSS 变量
 * （--tx/--ty/--rot/--delay）飞出去。位移写在变量里，
 * 动画本身留在 CSS，JS 只负责算随机数。
 *
 * 整层挂到 <body> 上用 fixed 定位，而不是挂在方格里面：
 * 课程详情页的作业列表在 .card 里，而 .card 有 overflow: hidden，
 * 挂在原地的话往左飞的那一半粒子会被卡片边缘切掉。
 */
function burstConfetti(box) {
  const colors = ['#4f7cff', '#10a86a', '#e08b00', '#e0453c', '#a855f7', '#0ea5e9'];
  const count = 16;

  const rect = box.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'sg-confetti-layer';
  // 把坐标原点挪到方格中心，粒子的位移就都以这里为起点
  layer.style.left = `${rect.left + rect.width / 2}px`;
  layer.style.top = `${rect.top + rect.height / 2}px`;

  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('i');
    p.className = 'sg-confetti';

    // 均匀铺开一圈，再加点随机抖动，免得看起来像个规整的齿轮
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 34 + Math.random() * 44;

    p.style.setProperty('--tx', `${(Math.cos(angle) * dist).toFixed(1)}px`);
    // 整体往上偏一点，这样看起来是「蹦」出来而不是往下掉
    p.style.setProperty('--ty', `${(Math.sin(angle) * dist - 16).toFixed(1)}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 600 - 300)}deg`);
    p.style.setProperty('--delay', `${Math.round(Math.random() * 70)}ms`);
    p.style.setProperty('--color', colors[i % colors.length]);
    p.style.setProperty('--size', `${5 + Math.round(Math.random() * 4)}px`);

    layer.appendChild(p);
  }

  document.body.appendChild(layer);
  // 最长的一条是 70ms 延迟 + 900ms 动画，1.2 秒后整层一起收掉
  setTimeout(() => layer.remove(), 1200);
}

/**
 * 勾选/取消勾选一项作业。
 *
 * 顺序上刻意先改界面、再发请求：等接口回来才打勾的话，
 * 会有一个能感觉到的延迟，而勾选这个动作的爽点全在「立刻响应」上。
 * 请求失败就把界面退回原样——绝不能让界面和数据对不上。
 */
async function commitAssignmentCheck(box, id, toDone) {
  const card = box.closest('.assignment, .task');
  const reduce = prefersReducedMotion();

  paintCheckBox(box, toDone);

  if (toDone && !reduce) {
    // is-just-checked 只负责「刚勾上」那一下的波纹，动画放完就撤掉，
    // 所以它不能写死在服务端渲染的 is-done 上
    box.classList.add('is-just-checked');
    setTimeout(() => box.classList.remove('is-just-checked'), 600);
    burstConfetti(box);
  }
  if (card && !reduce) {
    card.classList.add('is-flashing');
    setTimeout(() => card.classList.remove('is-flashing'), 700);
  }

  try {
    await api(`/api/assignments/${id}`, {
      method: 'PATCH',
      body: { status: toDone ? 'done' : 'todo' },
    });
  } catch (err) {
    paintCheckBox(box, !toDone);
    box.classList.remove('is-just-checked');
    card?.classList.remove('is-flashing');
    toast(err.message, 'error');
    return;
  }

  // 成功提示要等刷新之后再显示，否则会被马上到来的 reload 一起刷掉。
  // 这条提示是有信息量的：它说明「提醒已经被取消了」，而那是个看不见的副作用。
  toastAfterReload(
    toDone ? '已完成，这项作业的提醒已取消' : '已恢复为待办，提醒重新排上了',
  );

  // 「待办」视图里完成的作业会消失，那就让它从列表里退出去，
  // 而不是原地变灰再被下一次刷新凭空抹掉。
  // 服务端在列表上标了 data-hides-done，所以这里不用猜当前是哪个筛选页。
  const leavesList = toDone && Boolean(card?.closest('[data-hides-done]'));

  if (leavesList && !reduce && card) {
    setTimeout(() => {
      card.classList.add('is-leaving');
      setTimeout(reloadPreservingScroll, 260);
    }, 420);
  } else {
    // 卡片会留下，给一点时间让打勾和删除线被看见
    setTimeout(reloadPreservingScroll, reduce ? 0 : 320);
  }
}

function initAssignmentChecks() {
  if (!document.querySelector('[data-toggle-assignment]')) return;

  document.addEventListener('click', async (e) => {
    const box = e.target.closest('[data-toggle-assignment]');
    if (!box) return;

    // 确认条开着的时候，再点同一个方格 = 反悔
    if (dismissCheckConfirm) {
      dismissCheckConfirm();
      return;
    }

    const toDone = box.dataset.status !== 'done';
    const ok = await askCheckConfirm(box, toDone);
    if (!ok) return;

    await commitAssignmentCheck(box, box.dataset.toggleAssignment, toDone);
  });
}

// ============================================================
// 作业
// ============================================================

function initAssignments() {
  const tpl = document.getElementById('assignment-form-template');
  if (!tpl) return;

  /** 打开新建/编辑弹窗 */
  async function openForm(assignment) {
    const frag = fromTemplate('assignment-form-template');
    const form = frag.querySelector('form');
    // 模板克隆后 id 会重复，但因为我们一次只插一个弹窗，实际不会冲突

    const offsetPreview = () => {
      const checked = [...form.querySelectorAll('input[name=offset]:checked')].map((c) => Number(c.value));
      const custom = String(form.querySelector('input[name=remindOffsets]').dataset.custom || '')
        .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      const all = [...new Set([...checked, ...custom])].sort((a, b) => b - a);

      form.querySelector('input[name=remindOffsets]').value = all.join(',');
      form.querySelector('[data-offset-preview]').textContent = all.length
        ? `将在截止前 ${all.map(humanOffset).join('、')}提醒你（共 ${all.length} 次）`
        : '没有设置提醒，到点不会通知你';
    };

    form.addEventListener('change', (e) => {
      if (e.target.name === 'offset') offsetPreview();
    });

    form.querySelector('[data-add-offset]')?.addEventListener('click', () => {
      const input = form.querySelector('#af_custom_offset');
      const minutes = Number(input.value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        toast('请输入一个大于 0 的分钟数', 'error');
        return;
      }
      const hidden = form.querySelector('input[name=remindOffsets]');
      const current = String(hidden.dataset.custom || '').split(',').filter(Boolean);
      current.push(String(minutes));
      hidden.dataset.custom = current.join(',');
      input.value = '';
      offsetPreview();
    });

    if (assignment) {
      form.querySelector('[name=id]').value = assignment.id;
      form.querySelector('[name=title]').value = assignment.title || '';
      form.querySelector('[name=courseId]').value = assignment.course_id ?? '';
      form.querySelector('[name=priority]').value = String(assignment.priority ?? 1);
      form.querySelector('[name=description]').value = assignment.description || '';
      form.querySelector('[name=status]').value = assignment.status || 'todo';
      form.querySelector('[name=progress]').value = assignment.progress ?? 0;
      form.querySelector('[name=score]').value = assignment.score ?? '';

      // due_at 是 'YYYY-MM-DD HH:MM'，datetime-local 需要 'YYYY-MM-DDTHH:MM'
      if (assignment.due_at) {
        form.querySelector('[name=dueAt]').value = assignment.due_at.replace(' ', 'T').slice(0, 16);
      }

      const offsets = String(assignment.remind_offsets || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const cb of form.querySelectorAll('input[name=offset]')) {
        cb.checked = offsets.includes(cb.value);
      }
      const leftover = offsets.filter((o) => !form.querySelector(`input[name=offset][value="${o}"]`));
      if (leftover.length) {
        form.querySelector('input[name=remindOffsets]').dataset.custom = leftover.join(',');
      }
    } else {
      // 新建：默认时间设为「明天 23:59」
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const pad = (n) => String(n).padStart(2, '0');
      form.querySelector('[name=dueAt]').value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:59`;
    }

    // 从 URL 参数带上 courseId（从课程详情页点「新建作业」时）
    const urlCourse = new URLSearchParams(location.search).get('courseId');
    if (!assignment && urlCourse) {
      form.querySelector('[name=courseId]').value = urlCourse;
    }

    offsetPreview();

    form.querySelector('[data-modal-close]')?.addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('button[type=submit]');
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');

      try {
        const raw = formToObject(form);
        const payload = {
          title: raw.title,
          courseId: raw.courseId || null,
          priority: Number(raw.priority),
          dueAt: raw.dueAt,
          description: raw.description,
          status: raw.status,
          progress: Number(raw.progress || 0),
          score: raw.score === '' ? null : Number(raw.score),
          remindOffsets: raw.remindOffsets,
          notifyChannels: Array.isArray(raw.channel) ? raw.channel.join(',') : (raw.channel || ''),
        };

        if (raw.id) {
          await api(`/api/assignments/${raw.id}`, { method: 'PATCH', body: payload });
          toast('作业已更新，提醒规则同步重建', 'success');
        } else {
          await api('/api/assignments', { method: 'POST', body: payload });
          toast('作业已创建，提醒已排好', 'success');
        }
        clearFieldErrors(form);
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        // ⚠️ 服务端说「这个字段不对」时，要挂到那个字段上，不能只弹 toast。
        // 这里做一层归属：能对上就把错误放在对应输入框下面，
        // 实在对不上（比如「服务器内部错误」）才退回 toast —— 那种错误
        // 本来就没有一个"该怪哪个框"的答案。
        const placed = placeServerError(form, err.message);
        if (!placed) toast(err.message, 'error');
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
      }
    });

    openModal({ title: assignment ? '编辑作业' : '新建作业', content: frag });
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new-assignment]')) {
      openForm(null);
      return;
    }

    const editBtn = e.target.closest('[data-edit-assignment]');
    if (editBtn) {
      try {
        const data = await api(`/api/assignments/${editBtn.dataset.editAssignment}`);
        openForm(data.assignment);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-assignment]');
    if (delBtn) {
      if (!confirmAction(`确定删除作业「${delBtn.dataset.title}」吗？相关的提醒也会一并删除。`)) return;
      try {
        await api(`/api/assignments/${delBtn.dataset.deleteAssignment}`, { method: 'DELETE' });
        toast('已删除', 'success');
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  // 从总览页点「新建作业」跳过来时自动打开表单
  if (new URLSearchParams(location.search).get('new') === '1') {
    openForm(null);
    const url = new URL(location.href);
    url.searchParams.delete('new');
    history.replaceState(null, '', url);
  }
}

/** 刷新页面但保持滚动位置（局部刷新太复杂，这里用最稳的做法） */
function reloadPreservingScroll() {
  const y = window.scrollY;
  sessionStorage.setItem('sg-scroll', String(y));
  location.reload();
}

/**
 * 把提示留到刷新之后再显示。
 *
 * 勾选作业成功后马上就要刷新页面，这时候直接 toast 的话，
 * 提示会随着旧页面一起被销毁——用户只看到闪一下。
 * 所以寄存在 sessionStorage 里，由 boot() 在新页面上取出来显示。
 */
function toastAfterReload(message, type = 'success') {
  try {
    sessionStorage.setItem('sg-toast', JSON.stringify({ message, type }));
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，那就干脆不提示，不影响主流程 */
  }
}

/** 显示上一次操作留下的提示（如果有） */
function flushPendingToast() {
  let raw = null;
  try {
    raw = sessionStorage.getItem('sg-toast');
    if (raw) sessionStorage.removeItem('sg-toast');
  } catch {
    return;
  }
  if (!raw) return;

  try {
    const payload = JSON.parse(raw);
    if (payload?.message) toast(payload.message, payload.type || 'success', 6000);
  } catch {
    /* 存坏了就当没有 */
  }
}

function restoreScroll() {
  const y = sessionStorage.getItem('sg-scroll');
  if (y) {
    sessionStorage.removeItem('sg-scroll');
    requestAnimationFrame(() => window.scrollTo(0, Number(y)));
  }
}

/** 把分钟数变成中文 */
function humanOffset(minutes) {
  const m = Number(minutes);
  if (m % (60 * 24) === 0) return `${m / (60 * 24)} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}

// ============================================================
// 课程
// ============================================================

function initCourses() {
  /** 课程表单 */
  async function openCourseForm(course) {
    const isEdit = Boolean(course);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <form class="form">
        <div class="form__row">
          <div class="field field--grow">
            <label class="field__label">课程名称<span class="field__req">*</span></label>
            <input class="input" name="name" required placeholder="例如：高等数学(上)">
          </div>
          <div class="field">
            <label class="field__label">课程号</label>
            <input class="input" name="code" placeholder="选填">
          </div>
        </div>
        <div class="form__row">
          <div class="field field--grow">
            <label class="field__label">任课教师</label>
            <input class="input" name="teacher" placeholder="例如：张三">
          </div>
          <div class="field field--grow">
            <label class="field__label">教师联系方式</label>
            <input class="input" name="teacherContact" placeholder="邮箱 / 办公室，选填">
          </div>
        </div>
        <div class="form__row">
          <div class="field">
            <label class="field__label" for="cf_credits">学分</label>
            <input id="cf_credits" class="input" name="credits" type="text" inputmode="decimal"
                   placeholder="例如 3 或 3.5" autocomplete="off">
          </div>
          <div class="field">
            <label class="field__label" for="cf_hours">学时</label>
            <input id="cf_hours" class="input" name="hours" type="text" inputmode="decimal"
                   placeholder="例如 48" autocomplete="off">
          </div>
          <div class="field field--grow">
            <label class="field__label" for="cf_category">课程性质</label>
            <input id="cf_category" class="input" name="category" placeholder="必修 / 选修 / 限选" list="category-list">
            <datalist id="category-list">
              <option value="必修"><option value="选修"><option value="限选"><option value="通识">
            </datalist>
          </div>
          <div class="field field--grow">
            <label class="field__label" for="cf_examType">考核方式</label>
            <input id="cf_examType" class="input" name="examType" placeholder="考试 / 考查" list="exam-list">
            <datalist id="exam-list"><option value="考试"><option value="考查"></datalist>
          </div>
        </div>
        <div class="form__row">
          <div class="field field--grow">
            <label class="field__label">常用教室</label>
            <input class="input" name="classroom" placeholder="例如：之远楼301">
          </div>
          <div class="field">
            <label class="field__label">颜色标记</label>
            <input class="input input--color" name="color" type="color" value="#3a63e8" style="height:38px;padding:4px">
          </div>
        </div>
        <div class="field">
          <label class="field__label">备注</label>
          <textarea class="input input--area" name="notes" rows="2" placeholder="考试安排、作业要求等"></textarea>
        </div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
          <button type="submit" class="btn btn--primary">保存</button>
        </div>
      </form>`;

    const form = wrapper.querySelector('form');
    if (isEdit) {
      for (const key of ['name', 'code', 'teacher', 'credits', 'hours', 'category', 'examType', 'classroom', 'color', 'notes']) {
        const el = form.querySelector(`[name=${key}]`);
        if (!el) continue;
        const value = {
          teacherContact: course.teacher_contact,
          examType: course.exam_type,
        }[key] ?? course[key];
        if (value !== null && value !== undefined) el.value = value;
      }
      form.querySelector('[name=teacherContact]').value = course.teacher_contact || '';
    }

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');

      const raw = formToObject(form);

      // 学分 / 学时是普通文本框（原因见 parseAmountInput 的注释），这里自己解析
      const credits = parseAmountInput(raw.credits, { max: 30 });
      const hours = parseAmountInput(raw.hours, { max: 2000 });

      // 两个字段各自报各自的错 —— 以前是拼成一句话弹 toast，
      // 用户看到「学分学时格式不对」还得自己找是哪一格。
      let firstBad = null;
      for (const [field, result] of [['credits', credits], ['hours', hours]]) {
        const input = form.querySelector(`[name=${field}]`);
        if (!input) continue;
        if (result.error) {
          setFieldError(input, `请只填数字，例如 3 或 3.5（当前${result.error}）`);
          if (!firstBad) firstBad = input;
        } else {
          clearFieldError(input);
        }
      }
      if (firstBad) {
        focusFirstInvalid(firstBad);
        return;
      }

      const payload = { ...raw, credits: credits.value, hours: hours.value };

      btn.disabled = true;
      try {
        if (isEdit) {
          const result = await api(`/api/courses/${course.id}`, { method: 'PATCH', body: payload });

          // 保存后核对服务端实际存下来的值。
          // 加这一步是因为出现过「填了、点了保存、值却没进去」的情况——
          // 有了自检就能当场发现，而不是过一会儿才察觉数据没变。
          const saved = result?.course || {};
          if (!sameAmount(saved.credits, payload.credits) || !sameAmount(saved.hours, payload.hours)) {
            toast(
              '保存请求已发出，但服务端存下来的值和填写的不一致'
              + `（实际存下：学分 ${saved.credits ?? '空'}、学时 ${saved.hours ?? '空'}）。请再试一次。`,
              'error',
              10000,
            );
          } else {
            toast('课程已更新', 'success');
          }
        } else {
          const created = await api('/api/courses', { method: 'POST', body: payload });
          toast('课程已创建', 'success');
          // 新建后引导用户去设置上课时间
          if (created?.course?.id) {
            sessionStorage.setItem('sg-scroll', '0');
            location.href = `/courses/${created.course.id}?editSessions=1`;
            return;
          }
        }
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        // 「课程名不能为空」「学分超出范围」这类都能对上具体字段
        if (!placeServerError(form, err.message)) toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    openModal({ title: isEdit ? '编辑课程' : '添加课程', content: wrapper.firstElementChild });
  }

  /** 成绩构成表单 */
  async function openGradeForm(courseId) {
    let items = [];
    try {
      const data = await api(`/api/courses/${courseId}`);
      items = data.course?.gradeItems || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <form class="form">
        <p class="field__help">
          按教务系统或老师给的比例填写，例如「平时成绩 30% + 期中 20% + 期末考试 50%」。
          权重合计最好是 100%。出分后把分数填进来，课程页就能估算当前成绩。
        </p>
        <div class="grade-rows"></div>
        <button type="button" class="btn btn--outline btn--sm" data-add-grade>+ 添加一项</button>
        <p class="field__help" data-weight-hint></p>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
          <button type="submit" class="btn btn--primary">保存</button>
        </div>
      </form>`;

    const form = wrapper.querySelector('form');
    const rows = form.querySelector('.grade-rows');

    const addRow = (item = {}) => {
      const row = document.createElement('div');
      row.className = 'form__row';
      row.innerHTML = `
        <div class="field field--grow">
          <input class="input" name="g_name" placeholder="项目名称，如：平时成绩" value="${escapeAttr(item.name || '')}">
        </div>
        <div class="field field--narrow">
          <input class="input" name="g_weight" type="number" step="0.5" min="0" max="100" placeholder="占比%" value="${item.weight ?? ''}">
        </div>
        <div class="field field--narrow">
          <input class="input" name="g_score" type="number" step="0.5" placeholder="得分" value="${item.score ?? ''}">
        </div>
        <div class="field field--narrow">
          <input class="input" name="g_full" type="number" step="1" placeholder="满分" value="${item.full_score ?? 100}">
        </div>
        <button type="button" class="btn btn--ghost btn--icon" data-remove-grade title="删除">×</button>`;
      row.querySelector('[data-remove-grade]').addEventListener('click', () => {
        row.remove();
        updateHint();
      });
      row.addEventListener('input', updateHint);
      rows.appendChild(row);
    };

    const updateHint = () => {
      const total = [...rows.querySelectorAll('[name=g_weight]')]
        .reduce((sum, el) => sum + (Number(el.value) || 0), 0);
      const hint = form.querySelector('[data-weight-hint]');
      if (!total) {
        hint.textContent = '';
        return;
      }
      hint.textContent = Math.abs(total - 100) < 0.01
        ? `权重合计 ${total}% ✓`
        : `权重合计 ${total}%，不是 100%，请核对（多出来的部分不会被计入）`;
      hint.className = Math.abs(total - 100) < 0.01 ? 'field__help' : 'field__help text-warn';
    };

    if (items.length) items.forEach(addRow);
    else {
      addRow({ name: '平时成绩', weight: 30 });
      addRow({ name: '期末考试', weight: 70 });
    }
    updateHint();

    form.querySelector('[data-add-grade]').addEventListener('click', () => addRow());
    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;

      const payload = [...rows.children].map((row) => ({
        name: row.querySelector('[name=g_name]').value.trim(),
        weight: row.querySelector('[name=g_weight]').value,
        score: row.querySelector('[name=g_score]').value,
        fullScore: row.querySelector('[name=g_full]').value,
      })).filter((item) => item.name);

      try {
        await api(`/api/courses/${courseId}/grades`, { method: 'PUT', body: { items: payload } });
        toast('成绩构成已保存', 'success');
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    openModal({ title: '设置成绩构成', content: wrapper.firstElementChild, wide: true });
  }

  /**
   * 上课时间编辑器。
   *
   * 这是「课程时间段不对就自己改」的入口。
   * 支持：增删时间段、直接填时钟时间、按节次快速填入（用设置里的作息表）、
   * 以及提交前的合法性校验。
   */
  async function openSessionForm(courseId) {
    let course;
    let periods = [];

    try {
      const data = await api(`/api/courses/${courseId}`);
      course = data.course;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    // 作息表拿不到也不影响手填时间，所以失败时静默降级
    try {
      const pd = await api('/api/periods');
      periods = pd.periods || [];
    } catch { /* 忽略 */ }

    const scheduleOptions = periods.map((p) => {
      const label = p.from === p.to ? `第 ${p.from} 节` : `第 ${p.from}-${p.to} 节`;
      return `<option value='${escapeAttr(JSON.stringify(p))}'>${escapeAttr(label)} ${escapeAttr(p.start)}-${escapeAttr(p.end)}</option>`;
    }).join('');

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <form class="form" novalidate>
        <p class="field__help">
          填这门课每周什么时候上。时间可以直接选钟点，也可以按下面你学校自己的作息表一键填入。
          周次写法：<code>1-16</code>（连续）、<code>1-16单</code>（单周）、<code>1-16双</code>（双周）、<code>1-8,10-16</code>（多段）。
        </p>

        <div class="session-table">
          <div class="session-table__head" aria-hidden="true">
            <span>星期</span><span>开始</span><span>结束</span><span>周次</span><span>教室</span><span></span>
          </div>
          <div class="session-rows"></div>
        </div>

        <div class="btn-row">
          <button type="button" class="btn btn--outline btn--sm" data-add-session>${icon('plus', 15)}<span>添加时间段</span></button>
          ${periods.length ? `
            <select class="input input--sm" data-period-preset aria-label="按节次填入">
              <option value="">按节次快速填入…</option>
              ${scheduleOptions}
            </select>` : ''}
        </div>

        <div class="notice notice--error notice--compact" data-session-error hidden>
          <div class="notice__icon">${icon('alert', 16)}</div>
          <div class="notice__body" data-session-error-text></div>
        </div>

        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
          <button type="submit" class="btn btn--primary">保存</button>
        </div>
      </form>`;

    const form = wrapper.querySelector('form');
    const rows = form.querySelector('.session-rows');
    const errorBox = form.querySelector('[data-session-error]');
    const errorText = form.querySelector('[data-session-error-text]');

    const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

    /** 新增一行。prefill 可以带 weekday/startTime/endTime/weeks/location */
    const addRow = (prefill = {}) => {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.dataset.sessionRow = '';
      row.innerHTML = `
        <select class="input" name="s_weekday" aria-label="星期">
          ${WEEKDAYS.map((label, i) => `<option value="${i + 1}"${Number(prefill.weekday) === i + 1 ? ' selected' : ''}>周${label}</option>`).join('')}
        </select>
        <input class="input" name="s_start" type="time" aria-label="开始时间" value="${escapeAttr(prefill.startTime || '08:00')}">
        <input class="input" name="s_end" type="time" aria-label="结束时间" value="${escapeAttr(prefill.endTime || '09:40')}">
        <input class="input" name="s_weeks" aria-label="周次" placeholder="1-16" value="${escapeAttr(prefill.weeks || '1-16')}">
        <input class="input" name="s_location" aria-label="教室" placeholder="教室" value="${escapeAttr(prefill.location || course.classroom || '')}">
        <button type="button" class="btn btn--ghost btn--icon" data-remove-session title="删除这个时间段" aria-label="删除这个时间段">${icon('trash', 15)}</button>`;

      row.querySelector('[data-remove-session]').addEventListener('click', () => {
        row.remove();
        // 至少留一行，否则界面会空掉让人不知所措
        if (!rows.children.length) addRow();
      });

      rows.appendChild(row);
      return row;
    };

    (course.sessions || []).forEach((s) => addRow({
      weekday: s.weekday,
      startTime: s.start_time,
      endTime: s.end_time,
      weeks: s.weeks,
      location: s.location,
    }));
    if (!course.sessions?.length) addRow();

    form.querySelector('[data-add-session]').addEventListener('click', () => addRow());

    // 按节次快速填入：新增一行并填好时间
    const preset = form.querySelector('[data-period-preset]');
    if (preset) {
      preset.addEventListener('change', () => {
        if (!preset.value) return;
        let p;
        try {
          p = JSON.parse(preset.value);
        } catch {
          preset.value = '';
          return;
        }
        const row = addRow({ startTime: p.start, endTime: p.end });
        row.querySelector('[name=s_weeks]').focus();
        preset.value = '';
        hideError();
      });
    }

    const showError = (message) => {
      errorText.textContent = message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const hideError = () => {
      errorBox.hidden = true;
    };

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();

      const sessions = [...rows.children].map((row) => ({
        weekday: Number(row.querySelector('[name=s_weekday]').value),
        startTime: row.querySelector('[name=s_start]').value,
        endTime: row.querySelector('[name=s_end]').value,
        weeks: row.querySelector('[name=s_weeks]').value.trim() || '1-16',
        location: row.querySelector('[name=s_location]').value.trim(),
      }));

      // 提交前先自己校验一遍，错误信息比服务端返回的更具体
      for (let i = 0; i < sessions.length; i += 1) {
        const s = sessions[i];
        const where = `第 ${i + 1} 个时间段`;
        if (!s.startTime || !s.endTime) {
          showError(`${where}：请填写开始和结束时间。`);
          return;
        }
        if (s.startTime >= s.endTime) {
          showError(`${where}：结束时间（${s.endTime}）必须晚于开始时间（${s.startTime}）。`);
          return;
        }
        if (!/^\d/.test(s.weeks)) {
          showError(`${where}：周次格式不对，应该像 1-16 或 1-16单 这样。`);
          return;
        }
      }

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.classList.add('is-loading');

      try {
        await api(`/api/courses/${courseId}/sessions`, { method: 'PUT', body: { sessions } });
        toast(sessions.length ? `已保存 ${sessions.length} 个时间段` : '已清空上课时间', 'success');
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.classList.remove('is-loading');
      }
    });

    openModal({ title: `上课时间 · ${course.name}`, content: wrapper.firstElementChild, wide: true });
  }

  /**
   * 批量填学分。
   *
   * 一次可以给多门课设同一个学分（勾选 + 「统一学分」+「应用到已选」），
   * 也可以逐行填不同的值。
   *
   * 几条刻意的保守设计（批量操作最容易出问题的地方）：
   *   1. **只提交「勾选了、而且填了新学分」的行**。没勾选、或者新学分留空的行
   *      一律不动——这样手滑也不会把已有的学分清掉。
   *   2. **提交前把每一行都校验完**，有一行不合法就整体不发请求。
   *   3. **保存后逐条核对服务端返回的值**，有一条对不上就明确报错，
   *      而不是显示「已保存」然后你过一会儿才发现没变。
   */
  async function openBatchCreditsForm() {
    let list = [];
    try {
      const data = await api('/api/courses');
      list = data.courses || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    if (!list.length) {
      toast('还没有课程，先导入或手动添加课程', 'info');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <form class="form">
        <p class="field__help">
          勾选要修改的课程，填上新学分，然后保存。
          <strong>没勾选的行、以及新学分留空的行都不会被改动。</strong>
        </p>

        <div class="batch-bulk">
          <div class="field">
            <label class="field__label" for="bc_credits">统一学分</label>
            <input id="bc_credits" class="input" name="bulkCredits" type="text"
                   inputmode="decimal" placeholder="例如 3" autocomplete="off">
          </div>
          <div class="field">
            <label class="field__label" for="bc_hours">统一学时（选填）</label>
            <input id="bc_hours" class="input" name="bulkHours" type="text"
                   inputmode="decimal" placeholder="例如 48" autocomplete="off">
          </div>
          <button type="button" class="btn btn--outline" data-apply-bulk>应用到已选</button>
        </div>

        <div class="batch-toolbar">
          <button type="button" class="btn btn--ghost btn--sm" data-select-all>全选</button>
          <button type="button" class="btn btn--ghost btn--sm" data-select-none>全不选</button>
          <button type="button" class="btn btn--ghost btn--sm" data-select-empty>只选还没填学分的</button>
          <div class="toolbar__spacer"></div>
          <span class="muted small" data-batch-count></span>
        </div>

        <div class="batch-table">
          <div class="batch-head" aria-hidden="true">
            <span></span><span>课程</span><span>当前学分</span><span>新学分</span><span>新学时</span>
          </div>
          <div class="batch-rows">
            ${list.map((c) => `
              <div class="batch-row" data-course-row
                   data-course-id="${c.id}"
                   data-course-name="${escapeAttr(c.name)}"
                   data-current-credits="${c.credits === null || c.credits === undefined ? '' : c.credits}">
                <input type="checkbox" name="pick" aria-label="选择 ${escapeAttr(c.name)}">
                <span class="batch-row__name" title="${escapeAttr(c.name)}">
                  <span class="dot" style="--dot-color:${escapeAttr(c.color || '#3a63e8')}"></span>${escapeAttr(c.name)}
                </span>
                <span class="batch-row__current">${c.credits === null || c.credits === undefined ? '—' : escapeAttr(String(c.credits))}</span>
                <input class="input" name="credits" type="text" inputmode="decimal"
                       placeholder="不改" aria-label="新学分" autocomplete="off">
                <input class="input" name="hours" type="text" inputmode="decimal"
                       placeholder="不改" aria-label="新学时" autocomplete="off">
              </div>`).join('')}
          </div>
        </div>

        <div class="notice notice--error notice--compact" data-batch-error hidden>
          <div class="notice__icon">${icon('alert', 16)}</div>
          <div class="notice__body" data-batch-error-text></div>
        </div>

        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
          <button type="submit" class="btn btn--primary">保存</button>
        </div>
      </form>`;

    const form = wrapper.querySelector('form');
    const rows = [...form.querySelectorAll('[data-course-row]')];
    const countEl = form.querySelector('[data-batch-count]');
    const errorBox = form.querySelector('[data-batch-error]');
    const errorText = form.querySelector('[data-batch-error-text]');

    const showError = (message) => {
      errorText.textContent = message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const hideError = () => { errorBox.hidden = true; };

    const pickedRows = () => rows.filter((r) => r.querySelector('[name=pick]').checked);

    const refreshCount = () => {
      const picked = pickedRows();
      const filled = picked.filter((r) => r.querySelector('[name=credits]').value.trim());
      countEl.textContent = picked.length
        ? `已选 ${picked.length} 门，其中 ${filled.length} 门填了新学分`
        : '还没有选择课程';
    };
    refreshCount();

    form.addEventListener('input', refreshCount);
    form.addEventListener('change', refreshCount);

    form.querySelector('[data-select-all]').addEventListener('click', () => {
      rows.forEach((r) => { r.querySelector('[name=pick]').checked = true; });
      hideError();
      refreshCount();
    });

    form.querySelector('[data-select-none]').addEventListener('click', () => {
      rows.forEach((r) => { r.querySelector('[name=pick]').checked = false; });
      hideError();
      refreshCount();
    });

    // 只勾选当前没有学分的课程——这是最常见的用法
    form.querySelector('[data-select-empty]').addEventListener('click', () => {
      rows.forEach((r) => {
        r.querySelector('[name=pick]').checked = r.dataset.currentCredits === '';
      });
      hideError();
      refreshCount();
    });

    form.querySelector('[data-apply-bulk]').addEventListener('click', () => {
      const bulkCredits = form.querySelector('[name=bulkCredits]').value.trim();
      const bulkHours = form.querySelector('[name=bulkHours]').value.trim();
      const picked = pickedRows();

      if (!picked.length) {
        showError('先勾选要应用的课程，再点「应用到已选」。');
        return;
      }
      if (!bulkCredits && !bulkHours) {
        showError('先在上面填「统一学分」或「统一学时」，再点「应用到已选」。');
        return;
      }

      for (const r of picked) {
        if (bulkCredits) r.querySelector('[name=credits]').value = bulkCredits;
        if (bulkHours) r.querySelector('[name=hours]').value = bulkHours;
      }

      hideError();
      refreshCount();

      const parts = [];
      if (bulkCredits) parts.push(`学分 ${bulkCredits}`);
      if (bulkHours) parts.push(`学时 ${bulkHours}`);
      toast(`已把${parts.join('、')}填到 ${picked.length} 门课上，确认无误后点「保存」`, 'info', 5000);
    });

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();

      const items = [];

      // 先把所有行校验完，有一行不合法就整体不发请求
      for (const r of rows) {
        if (!r.querySelector('[name=pick]').checked) continue;

        const name = r.dataset.courseName || `课程 ${r.dataset.courseId}`;
        const creditsRaw = r.querySelector('[name=credits]').value.trim();
        const hoursRaw = r.querySelector('[name=hours]').value.trim();

        // 勾选了但没填新学分 → 跳过，不动它（防止手滑清空已有数据）
        if (!creditsRaw) continue;

        const credits = parseAmountInput(creditsRaw, { max: 30 });
        if (credits.error) {
          showError(`「${name}」的学分${credits.error}。请只填数字，例如 3 或 3.5。`);
          return;
        }

        const item = { id: Number(r.dataset.courseId), credits: credits.value };

        if (hoursRaw) {
          const hours = parseAmountInput(hoursRaw, { max: 2000 });
          if (hours.error) {
            showError(`「${name}」的学时${hours.error}。请只填数字。`);
            return;
          }
          item.hours = hours.value;
        }

        items.push(item);
      }

      if (!items.length) {
        showError('没有要保存的内容：请先勾选课程，并给它们填上新学分（留空表示这一行不改动）。');
        return;
      }

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.classList.add('is-loading');

      try {
        const result = await api('/api/courses/batch-credits', {
          method: 'POST',
          body: { items },
        });

        // 保存后逐条核对服务端实际存下来的值，有一条对不上就报错
        const savedList = result?.courses || [];
        const mismatched = items.filter((it) => {
          const saved = savedList.find((c) => c.id === it.id);
          if (!saved) return true;
          if (!sameAmount(saved.credits, it.credits)) return true;
          if ('hours' in it && !sameAmount(saved.hours, it.hours)) return true;
          return false;
        });

        if (mismatched.length) {
          const names = mismatched
            .map((it) => rows.find((r) => Number(r.dataset.courseId) === it.id)?.dataset.courseName || it.id)
            .slice(0, 3)
            .join('、');
          showError(
            `有 ${mismatched.length} 门课没有按预期写入（${names}${mismatched.length > 3 ? ' 等' : ''}）。`
            + '请再试一次；如果反复失败，请把这条信息反馈给我。',
          );
          btn.disabled = false;
          btn.classList.remove('is-loading');
          return;
        }

        toast(`已更新 ${result.changed} 门课程的学分`, 'success');
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
        btn.classList.remove('is-loading');
      }
    });

    openModal({ title: `批量填学分（共 ${list.length} 门课）`, content: wrapper.firstElementChild, wide: true });
  }

  document.addEventListener('click', async (e) => {
    // 批量填学分
    if (e.target.closest('[data-batch-credits]')) {
      openBatchCreditsForm();
      return;
    }

    const newBtn = e.target.closest('[data-new-course]');
    if (newBtn) {
      openCourseForm(null);
      return;
    }

    const editBtn = e.target.closest('[data-edit-course]');
    if (editBtn) {
      try {
        const data = await api(`/api/courses/${editBtn.dataset.editCourse}`);
        openCourseForm(data.course);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-course]');
    if (delBtn) {
      const msg = `确定删除课程「${delBtn.dataset.courseName}」吗？\n\n`
        + '该课程的上课时间、成绩构成会一并删除。\n'
        + '已上传的课件会保留，但会变成「未归类」。';
      if (!confirmAction(msg)) return;
      try {
        await api(`/api/courses/${delBtn.dataset.deleteCourse}`, { method: 'DELETE' });
        toast('课程已删除', 'success');
        if (location.pathname.startsWith('/courses/')) location.href = '/courses';
        else reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const gradeBtn = e.target.closest('[data-edit-grades]');
    if (gradeBtn) {
      openGradeForm(gradeBtn.dataset.editGrades);
      return;
    }

    // 上课时间编辑器。这个入口以前是缺的——
    // 课程详情页那个「管理」按钮错绑到了课程信息表单上，导致时间根本改不了。
    const sessionBtn = e.target.closest('[data-edit-sessions]');
    if (sessionBtn) {
      openSessionForm(sessionBtn.dataset.editSessions);
    }
  });

  // 从新建课程跳过来时自动打开「上课时间」
  if (new URLSearchParams(location.search).get('editSessions') === '1') {
    const m = /^\/courses\/(\d+)/.exec(location.pathname);
    if (m) {
      openSessionForm(m[1]);
      const url = new URL(location.href);
      url.searchParams.delete('editSessions');
      history.replaceState(null, '', url);
    }
  }
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
// 资料上传
// ============================================================

/**
 * 资料相关的交互（编辑信息、删除、重新转换、上传）。
 *
 * ⚠️ 这个函数**不能**在开头判断「页面上有没有某个模板」然后提前返回。
 *
 * 踩过两次同一个坑了：
 *   - 第 1 次：作业勾选框。绑事件的函数开头写着「没有作业表单模板就 return」，
 *     而那个模板只有作业页有 —— 课程详情页的勾选框于是点了完全没反应。
 *   - 第 2 次（就是这里）：上传弹窗的模板只有资料库列表页才有，
 *     函数开头拿它做判断，结果**预览页**上的「编辑」和「重新转换」两个按钮
 *     全都没绑上事件。用户点「编辑」毫无反应，
 *     反馈是「已加入的课件资料无法重新选择属性」。
 *
 * 所以：能无条件绑的就无条件绑；确实依赖模板的（上传弹窗），
 * 把判断推迟到**点击那一刻**再做。
 */
/**
 * 课件的「全屏观看」。
 *
 * 做的其实只有一件事：给 .preview-main 加一个 is-immersive 类，让它铺满整个视口。
 * 铺满的样式全在 app.css 里，这里只管状态切换。
 *
 * 为什么主力是 CSS 而不是浏览器的 Fullscreen API：
 * **iPhone 上的 Safari 不允许对普通元素调用 requestFullscreen**（只有 <video> 行），
 * 只靠它的话手机上点了完全没反应 —— 而手机恰恰是最需要全屏的地方。
 * 所以能用原生全屏的地方（桌面浏览器、安卓 Chrome）再叠加一层原生全屏，
 * 那样连浏览器地址栏也一起收掉；用不了的地方光靠 CSS 也已经铺满了。
 */
function initMaterialViewer() {
  const main = document.querySelector('[data-preview-main]');
  if (!main) return;

  const enterBtn = document.querySelector('[data-viewer-fullscreen]');
  const exitBtn = main.querySelector('[data-viewer-exit]');
  if (!enterBtn || !exitBtn) return;

  // 按钮默认是 hidden 的：没有 JavaScript 时它按不动，
  // 那就不该摆一个按了没反应的按钮出来
  enterBtn.hidden = false;

  const isImmersive = () => main.classList.contains('is-immersive');
  const fullscreenEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  /** 调用可能不存在的 API，并且不管它抛什么 —— 失败不该影响 CSS 那一层 */
  const tryCall = (fn, thisArg) => {
    if (typeof fn !== 'function') return;
    try {
      const r = fn.call(thisArg);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* 忽略 */
    }
  };

  function enter() {
    main.classList.add('is-immersive');
    tryCall(main.requestFullscreen || main.webkitRequestFullscreen, main);
    // 焦点跟过去：键盘用户要能直接按 Esc 或 Tab 到退出按钮
    exitBtn.focus({ preventScroll: true });
  }

  function exit() {
    main.classList.remove('is-immersive');
    // 原生全屏是自己退出的（也可能压根没进），两种情况都调一次 exitFullscreen，
    // 不在全屏时它什么也不做
    if (fullscreenEl()) tryCall(document.exitFullscreen || document.webkitExitFullscreen, document);
    enterBtn.focus({ preventScroll: true });
  }

  enterBtn.addEventListener('click', () => (isImmersive() ? exit() : enter()));
  exitBtn.addEventListener('click', exit);

  // 用户按 Esc / F11 自己退出原生全屏时，把 CSS 那一层一起收掉 ——
  // 否则会留下一个「铺满整屏、但已经不是全屏」的怪状态，按钮也对不上
  const onFullscreenChange = () => {
    if (!fullscreenEl() && isImmersive()) main.classList.remove('is-immersive');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 没有原生全屏时（iPhone），Esc 得自己处理
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isImmersive() || fullscreenEl()) return;
    // 幻灯片看图器开着的时候，Esc 应该先关它 —— 那是更靠前的一层
    if (document.querySelector('.slide-viewer')) return;
    exit();
  });
}

/**
 * 这是不是一台 iOS 设备（iPhone / iPad）。
 *
 * 单独抽出来是为了能被测试直接调用，也为了把「为什么这么判断」写在一处。
 */
function isIosDevice() {
  const ua = navigator.userAgent || '';
  // iPhone / iPad / iPod 会老老实实报自己，直接认出来
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13 起 Safari 的 UA 直接写成「Macintosh」，跟真 Mac 一模一样，
  // 光看 UA 认不出来。差别在于真 Mac 没有触摸屏：多点触控数 > 1 就是 iPad。
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/**
 * PDF 预览在 iPhone / iPad 上只显示第一页 —— 显示一条「换个方式打开」的提示。
 *
 * iOS Safari 在 <iframe> 里渲染 PDF 时只画第一页，而且不给滚动。
 * 用户看到的是一份「只有一页的课件」，很容易以为文件传坏了或者上传没成功。
 * 这条提示告诉他改用新标签页打开（交给系统自带的阅读器），那才是能翻页的。
 *
 * 判断为什么放在前端而不是服务端：
 * 服务端只能看 User-Agent，而 iPadOS 13 起的 UA 和 Mac 完全一样，认不出来。
 * 前端能再多问一句 navigator.maxTouchPoints，才分得清 iPad 和 Mac。
 *
 * 提示块默认带 hidden 属性躺在 HTML 里，这里只负责在认出来之后把 hidden 去掉。
 * 认不出来就什么都不做 —— 桌面浏览器不该看到这条。
 */
function initIosPdfNotice() {
  const notice = document.querySelector('[data-ios-pdf-notice]');
  if (!notice) return;
  if (!isIosDevice()) return;
  notice.hidden = false;
}

function initMaterials() {
  /** 上传弹窗要页面上的模板才能弹，所以等到真要弹的时候再检查 */
  function openUploadModal() {
    const tpl = document.getElementById('upload-form-template');
    if (!tpl) {
      toast('当前页面没有上传入口，请到「资料库」页面上传', 'error');
      return;
    }

    const frag = fromTemplate('upload-form-template');
    const form = frag.querySelector('form');
    const dropzone = form.querySelector('[data-dropzone]');
    const fileInput = form.querySelector('[data-file-input]');
    const queue = form.querySelector('[data-file-queue]');
    const submitBtn = form.querySelector('[data-submit]');

    /** @type {File[]} */
    let files = [];

    const renderQueue = () => {
      queue.innerHTML = '';
      queue.hidden = files.length === 0;
      submitBtn.disabled = files.length === 0;

      files.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const tooBig = file.size > MAX_UPLOAD_BYTES;
        if (tooBig) item.classList.add('is-error');

        item.innerHTML = `
          <span class="file-item__name">${escapeAttr(file.name)}</span>
          <span class="file-item__size">${humanSize(file.size)}</span>
          <span class="file-item__status">${tooBig ? '超过大小限制' : ''}</span>`;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn--ghost btn--sm btn--icon';
        removeBtn.textContent = '×';
        removeBtn.title = '移除';
        removeBtn.addEventListener('click', () => {
          files.splice(index, 1);
          renderQueue();
        });
        item.appendChild(removeBtn);
        queue.appendChild(item);
      });
    };

    const addFiles = (incoming) => {
      for (const file of incoming) {
        if (!files.some((f) => f.name === file.name && f.size === file.size)) files.push(file);
      }
      renderQueue();
    };

    dropzone.addEventListener('click', () => fileInput.click());
    form.querySelector('[data-browse]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      addFiles(fileInput.files);
      fileInput.value = '';
    });

    // 拖放
    ['dragenter', 'dragover'].forEach((type) => {
      dropzone.addEventListener(type, (ev) => {
        ev.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      dropzone.addEventListener(type, (ev) => {
        ev.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });
    dropzone.addEventListener('drop', (ev) => {
      if (ev.dataTransfer?.files?.length) addFiles(ev.dataTransfer.files);
    });

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!files.length) return;

      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');

      const meta = formToObject(form);
      let success = 0;
      const failures = [];

      for (const file of files) {
        const statusEl = queue.querySelectorAll('.file-item__status')[files.indexOf(file)];
        if (statusEl) statusEl.textContent = '上传中…';

        const fd = new FormData();
        fd.append('file', file);
        fd.append('courseId', meta.courseId || '');
        fd.append('category', meta.category || 'courseware');
        fd.append('week', meta.week || '');
        fd.append('tags', meta.tags || '');
        fd.append('source', meta.source || '');

        try {
          await api('/api/materials', { method: 'POST', body: fd });
          success += 1;
          if (statusEl) statusEl.textContent = '✓ 已上传';
        } catch (err) {
          failures.push(`${file.name}：${err.message}`);
          if (statusEl) statusEl.textContent = `失败：${err.message}`;
        }
      }

      if (success) {
        toast(`成功上传 ${success} 个文件${failures.length ? `，${failures.length} 个失败` : ''}`,
          failures.length ? 'info' : 'success');
      }
      if (failures.length) {
        for (const f of failures) toast(f, 'error', 6000);
      }

      if (success) {
        closeModal();
        reloadPreservingScroll();
      } else {
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
      }
    });

    openModal({ title: '上传资料', content: frag, wide: true });
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-upload-material]')) {
      openUploadModal();
      return;
    }

    const editBtn = e.target.closest('[data-edit-material]');
    if (editBtn) {
      // 编辑表单模板两个页面都有；真缺了也给个明确提示，
      // 别像以前那样静默 return，用户只会觉得「点了没反应」
      if (!document.getElementById('material-edit-template')) {
        toast('这个页面不支持编辑资料信息', 'error');
        return;
      }

      let material;
      try {
        const data = await api(`/api/materials/${editBtn.dataset.editMaterial}`);
        material = data.material;
      } catch (err) {
        toast(err.message, 'error');
        return;
      }

      const frag = fromTemplate('material-edit-template');
      const form = frag.querySelector('form');
      form.querySelector('[name=id]').value = material.id;
      form.querySelector('[name=title]').value = material.title || '';
      form.querySelector('[name=courseId]').value = material.course_id ?? '';
      form.querySelector('[name=category]').value = material.category || 'courseware';
      form.querySelector('[name=week]').value = material.week ?? '';
      form.querySelector('[name=tags]').value = material.tags || '';
      form.querySelector('[name=description]').value = material.description || '';
      // 公开开关：checkbox 不能用 .value 赋值，要设 .checked。
      // 漏了这一句的表现是**每次打开编辑框它都是没勾的** ——
      // 用户以为资料没公开，其实是公开的；或者反过来"勾一下保存"，
      // 结果把本来公开的关掉了。两种都是静默的。
      //
      // ⚠️ 这里给的是 **1/0**，和库里的存法一致（不是 true/false）。
      //    表单提交时 formToObject 会把 checkbox 变成 '1' 或缺失，
      //    服务端的 toBool01 认得这两种。
      const pubBox = form.querySelector('[name=published]');
      if (pubBox) pubBox.checked = Number(material.published) === 1;

      form.querySelector('[data-modal-close]').addEventListener('click', closeModal);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const body = formToObject(form);
          // checkbox 没勾时 formToObject 里根本没有这个键（表单不会提交未勾选的
          // checkbox），那样 PATCH 会"不改这一项"，于是**取消公开点不动**。
          // 所以这里显式补一个 0。
          if (pubBox) body.published = pubBox.checked ? '1' : '0';
          await api(`/api/materials/${material.id}`, { method: 'PATCH', body });
          toast('资料信息已更新', 'success');
          closeModal();
          reloadPreservingScroll();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });

      openModal({ title: '编辑资料信息', content: frag });
      return;
    }

    const delBtn = e.target.closest('[data-delete-material]');
    if (delBtn) {
      if (!confirmAction(`确定删除「${delBtn.dataset.title}」吗？文件会从磁盘上一并删除，无法恢复。`)) return;
      try {
        await api(`/api/materials/${delBtn.dataset.deleteMaterial}`, { method: 'DELETE' });
        toast('已删除', 'success');
        if (/^\/materials\/\d+/.test(location.pathname)) location.href = '/materials';
        else reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const rebuildBtn = e.target.closest('[data-rebuild-preview]');
    if (rebuildBtn) {
      rebuildBtn.disabled = true;
      rebuildBtn.textContent = '转换中…';
      try {
        await api(`/api/materials/${rebuildBtn.dataset.rebuildPreview}/rebuild`, { method: 'POST' });
        toast('已重新转换，页面即将刷新', 'success');
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        toast(err.message, 'error');
        rebuildBtn.disabled = false;
      }
    }
  });

  // URL 带 upload=1 时自动打开上传弹窗
  if (new URLSearchParams(location.search).get('upload') === '1') {
    openUploadModal();
    const url = new URL(location.href);
    url.searchParams.delete('upload');
    history.replaceState(null, '', url);
  }
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MAX_UPLOAD_BYTES = Number(document.body.dataset.maxUpload || 200 * 1024 * 1024);

// ============================================================
// 设置页
// ============================================================

function initSettings() {
  initTermForms();
  initPeriodsForm();
  initChannelForms();
  initSettingsForm();
  initPasswordForm();
  initFieldErrors();
  initSchoolPickers();
  initProfileForm();
  initAvatarForm();
  initRevokeButtons();
  initDeleteAccount();
  initSchedulerButton();
  initSettingsTabs();
}

/**
 * 作息时间表编辑器（设置页）。
 *
 * 这张表决定「第 3-4 节」是几点到几点——每个学校不一样，
 * 所以必须让用户能改，而不是在代码里写死。
 */
function initPeriodsForm() {
  const form = document.querySelector('[data-periods-form]');
  if (!form) return;

  const rows = form.querySelector('[data-period-rows]');
  const errorBox = form.querySelector('[data-periods-error]');
  const errorText = form.querySelector('[data-periods-error-text]');

  const hideError = () => { errorBox.hidden = true; };
  const showError = (message) => {
    errorText.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  /** 把 'HH:MM' 转成分钟数，用于算时长和推算下一节 */
  const toMin = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const toTime = (min) => {
    const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  };

  /** 刷新某一行的时长显示 */
  const refreshLength = (row) => {
    const label = row.querySelector('[data-period-len]');
    if (!label) return;
    const s = toMin(row.querySelector('[name=p_start]').value);
    const e = toMin(row.querySelector('[name=p_end]').value);
    if (s === null || e === null) {
      label.textContent = '';
      label.classList.remove('text-danger');
      return;
    }
    const minutes = e - s;
    if (minutes <= 0) {
      label.textContent = '时间有误';
      label.classList.add('text-danger');
      return;
    }
    label.classList.remove('text-danger');
    label.textContent = minutes < 60
      ? `${minutes} 分钟`
      : (minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`);
  };

  /**
   * 给一行里的输入框补上「第几节」的读屏标签。
   *
   * 不加的话，页面上十几行的 aria-label 全是「开始时间」「结束时间」——
   * 读屏用户在表单元素列表里听到一串一模一样的名字，根本分不清在改哪一节。
   * 行首那个「第 X 节」是**文本节点**，读屏不会把它算进输入框的名字里。
   *
   * 定义在 addRow **前面**：两者都是 const，而 const 不会提升，
   * 定义在后面的话，只要哪天有人在初始化阶段就调 addRow，就会撞上暂时性死区报错。
   */
  const labelPeriodRow = (row) => {
    const indexInput = row.querySelector('[name=p_index]');
    const typed = String(indexInput?.value || '').trim();
    // 用户还没填节次时，用它在列表里的位置当兜底（至少不是全部一样）
    const n = typed || String([...rows.children].indexOf(row) + 1);
    const label = (name) => `第 ${n} 节${name}`;
    indexInput?.setAttribute('aria-label', label('的节次'));
    row.querySelector('[name=p_start]')?.setAttribute('aria-label', label('开始时间'));
    row.querySelector('[name=p_end]')?.setAttribute('aria-label', label('结束时间'));
    const removeBtn = row.querySelector('[data-remove-period]');
    if (removeBtn) {
      removeBtn.setAttribute('aria-label', `删除第 ${n} 节`);
      removeBtn.title = `删除第 ${n} 节`;
    }
  };

  const addRow = (prefill = {}) => {
    const row = document.createElement('div');
    row.className = 'period-row';
    row.dataset.periodRow = '';
    row.innerHTML = `
      <div class="period-row__index">
        第 <input class="input input--period-index" type="number" min="1" max="30" name="p_index"
                  value="${escapeAttr(prefill.index ?? '')}"> 节
      </div>
      <input class="input" type="time" name="p_start"
             value="${escapeAttr(prefill.start || '08:00')}">
      <input class="input" type="time" name="p_end"
             value="${escapeAttr(prefill.end || '08:45')}">
      <span class="period-row__len" data-period-len></span>
      <button type="button" class="btn btn--ghost btn--icon" data-remove-period>${'\u00d7'}</button>`;

    row.querySelector('[data-remove-period]').addEventListener('click', () => {
      row.remove();
      // 至少留一行，否则界面空了会让人以为坏了
      if (!rows.children.length) addRow({ index: 1 });
      hideError();
    });

    for (const input of row.querySelectorAll('input')) {
      input.addEventListener('input', () => {
        refreshLength(row);
        // 节次改了，读屏标签也要跟着改 —— 否则念出来的还是「第 3 节」
        if (input.name === 'p_index') labelPeriodRow(row);
        hideError();
      });
    }

    rows.appendChild(row);
    // 放在插进 DOM 之后：这时才知道它是第几行，标签能拿到一个合理的兜底值
    labelPeriodRow(row);
    refreshLength(row);
    return row;
  };

  /** 用一份作息表重建所有行 */
  const renderRows = (list) => {
    rows.innerHTML = '';
    for (const p of list) addRow(p);
    if (!rows.children.length) addRow({ index: 1 });
  };

  /** 收集表单里的作息表 */
  const collect = () => [...rows.children].map((row) => ({
    index: row.querySelector('[name=p_index]').value,
    start: row.querySelector('[name=p_start]').value,
    end: row.querySelector('[name=p_end]').value,
  }));

  /** 当前最大节次 */
  const maxIndex = () => [...rows.children].reduce(
    (max, row) => Math.max(max, Number(row.querySelector('[name=p_index]').value) || 0),
    0,
  );

  form.querySelector('[data-add-period]').addEventListener('click', () => {
    // 接着最后一节往下编号，开始时间默认接在上一节结束后 5 分钟
    const last = rows.lastElementChild;
    const lastEnd = last ? toMin(last.querySelector('[name=p_end]').value) : null;
    const start = lastEnd === null ? '08:00' : toTime(lastEnd + 5);

    const row = addRow({
      index: maxIndex() + 1,
      start,
      end: toTime(toMin(start) + 45),
    });
    row.querySelector('[name=p_index]').focus();
    hideError();
  });

  /**
   * 按上一节自动推算下一节。
   * 填到一半懒得分段填的时候很有用：保持「一节课时长 + 课间」的节奏往后铺。
   */
  form.querySelector('[data-auto-fill-periods]').addEventListener('click', () => {
    const list = [...rows.children];
    if (!list.length) {
      showError('先填至少一节，才能推算下一节。');
      return;
    }

    const last = list[list.length - 1];
    const start = toMin(last.querySelector('[name=p_start]').value);
    const end = toMin(last.querySelector('[name=p_end]').value);
    if (start === null || end === null || end <= start) {
      showError('最后一节的开始/结束时间不对，先把它改正确再推算。');
      return;
    }

    // 沿用最后一节的时长，课间默认 5 分钟
    const duration = end - start;
    const nextStart = end + 5;

    if (nextStart + duration > 24 * 60) {
      showError('已经排到当天最后一刻了，没法再往后推。');
      return;
    }

    addRow({
      index: maxIndex() + 1,
      start: toTime(nextStart),
      end: toTime(nextStart + duration),
    });
    hideError();
  });

  form.querySelector('[data-reset-periods]').addEventListener('click', async () => {
    if (!confirmAction('恢复成内置默认作息表？当前的自定义设置会被覆盖。')) return;
    try {
      const result = await api('/api/periods', { method: 'POST', body: { periods: null } });
      renderRows(result.periods || []);
      toast('已恢复成内置默认作息表', 'success');
    } catch (err) {
      showError(err.message);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const periods = collect();

    // 提交前自查，错误提示比服务端返回的更具体
    for (let i = 0; i < periods.length; i += 1) {
      const p = periods[i];
      const where = `第 ${i + 1} 行`;
      const index = Number(p.index);
      if (!Number.isFinite(index) || index < 1) {
        showError(`${where}：请填写节次（正整数）。`);
        return;
      }
      const s = toMin(p.start);
      const en = toMin(p.end);
      if (s === null || en === null) {
        showError(`${where}：请填写开始和结束时间。`);
        return;
      }
      if (en <= s) {
        showError(`${where}（第 ${index} 节）：结束时间 ${p.end} 必须晚于开始时间 ${p.start}。`);
        return;
      }
    }

    const indexes = periods.map((p) => Number(p.index));
    const dupes = indexes.filter((n, i) => indexes.indexOf(n) !== i);
    if (dupes.length) {
      showError(`节次重复了：第 ${[...new Set(dupes)].join('、')} 节出现了不止一次。`);
      return;
    }

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.classList.add('is-loading');

    try {
      const result = await api('/api/periods', { method: 'POST', body: { periods } });
      renderRows(result.periods || []);
      toast(`作息时间表已保存（共 ${result.periods.length} 节）`, 'success');
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  });
}

function initSettingsTabs() {
  // 锚点导航：点击后平滑滚动（CSS 的 scroll-margin-top 已处理偏移）
  const links = [...document.querySelectorAll('.anchor-nav a')];

  /**
   * 标记「当前在哪一节」。
   *
   * 用 aria-current="location" 而不是 "page"：这是一页之内的目录，
   * 不是在多个页面之间切换 —— 读屏对两者的播报不一样。
   *
   * ⚠️ 这里必须真的跟着滚动走。写死一个 aria-current 比不写更糟：
   * 读屏会一本正经地念「当前位置：学期」，而用户其实滚到了「系统」。
   */
  const markCurrent = (hash) => {
    for (const link of links) {
      if (link.getAttribute('href') === hash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };

  for (const link of links) {
    link.addEventListener('click', (e) => {
      const hash = link.getAttribute('href');
      const target = document.querySelector(hash);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', hash);
        markCurrent(hash);
      }
    });
  }

  // 滚到哪一节就标到哪一节：取「最后一个已经越过页面顶部的分区」
  const sections = links
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  if (sections.length) {
    const syncFromScroll = () => {
      const line = window.scrollY + 140; // 140 ≈ 页头 + 锚点导航自身的高度
      let current = sections[0];
      for (const s of sections) if (s.offsetTop <= line) current = s;
      markCurrent(`#${current.id}`);
    };
    markCurrent(window.location.hash || `#${sections[0].id}`);
    window.addEventListener('scroll', syncFromScroll, { passive: true });
    syncFromScroll();
  }
}

function initTermForms() {
  const pad = (n) => String(n).padStart(2, '0');
  const toDateInputValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** 找出某个日期所在周的周一 */
  const mondayOf = (d) => {
    const copy = new Date(d);
    const dow = copy.getDay();
    copy.setDate(copy.getDate() - (dow === 0 ? 6 : dow - 1));
    return copy;
  };

  /**
   * 学期表单，新增和编辑共用一个。
   * @param {object|null} term 传 null 表示新增
   */
  async function openTermForm(term) {
    const isEdit = Boolean(term);
    const frag = fromTemplate('term-form-template');
    const form = frag.querySelector('form');

    if (isEdit) {
      form.querySelector('[name=name]').value = term.name || '';
      form.querySelector('[name=startDate]').value = term.start_date || '';
      form.querySelector('[name=weekCount]').value = term.week_count ?? 18;
      form.querySelector('[name=isActive]').checked = Number(term.is_active) === 1;
    } else {
      const monday = mondayOf(new Date());
      form.querySelector('[name=startDate]').value = toDateInputValue(monday);

      // 自动填一个学期名
      const month = monday.getMonth() + 1;
      const year = monday.getFullYear();
      form.querySelector('[name=name]').value = month >= 9
        ? `${year}-${year + 1}学年第一学期`
        : `${year - 1}-${year}学年第二学期`;
    }

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();

      const startDate = form.querySelector('[name=startDate]').value;
      // 起始日必须是周一，否则整张课表的周次都会偏
      const picked = new Date(`${startDate}T00:00:00`);
      if (Number.isNaN(picked.getTime())) {
        toast('请选择「第一周周一」的日期', 'error');
        return;
      }
      if (picked.getDay() !== 1) {
        const suggested = toDateInputValue(mondayOf(picked));
        // 这条错误完全针对「开始日期」那一个框，挂在框下面比飘在右上角好得多：
        // 用户看到提示的同时就看得见要改的那个日期，不用来回找。
        const dateInput = form.querySelector('[name=startDate]');
        setFieldError(dateInput,
          `「第一周周一」要选星期一。你选的 ${startDate} 是星期${'日一二三四五六'[picked.getDay()]}，`
          + `同一周的周一是 ${suggested}。`);
        focusFirstInvalid(dateInput);
        return;
      }

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;

      const raw = formToObject(form);
      const payload = {
        name: raw.name,
        startDate: raw.startDate,
        weekCount: Number(raw.weekCount || 18),
        isActive: form.querySelector('[name=isActive]').checked,
      };

      try {
        if (isEdit) {
          const result = await api(`/api/terms/${term.id}`, { method: 'PATCH', body: payload });
          const progress = result.progress;
          toast(
            progress
              ? `学期已更新，现在按新起始日算是第 ${progress.week} 周`
              : '学期已更新',
            'success',
            6000,
          );
        } else {
          await api('/api/terms', { method: 'POST', body: payload });
          toast('学期已创建', 'success');
        }
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        // 学期名的重名、周数超范围这类错误都能对上具体字段
        if (!placeServerError(form, err.message)) toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    openModal({ title: isEdit ? '编辑学期' : '新增学期', content: frag });
  }

  document.addEventListener('click', async (e) => {
    const newBtn = e.target.closest('[data-new-term]');
    if (newBtn) {
      openTermForm(null);
      return;
    }

    // 编辑学期。这个入口以前是缺的——接口和表单都有，但列表里只有「设为当前」和「删除」，
    // 导致起始日填错了根本改不了（只能删了重建，而删除会让课程丢失学期关联）。
    const editBtn = e.target.closest('[data-edit-term]');
    if (editBtn) {
      try {
        const data = await api('/api/terms');
        const term = (data.terms || []).find((t) => String(t.id) === String(editBtn.dataset.editTerm));
        if (!term) throw new Error('学期不存在');
        openTermForm(term);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const activateBtn = e.target.closest('[data-activate-term]');
    if (activateBtn) {
      try {
        await api(`/api/terms/${activateBtn.dataset.activateTerm}`, {
          method: 'PATCH',
          body: { isActive: true },
        });
        toast('已切换当前学期', 'success');
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-term]');
    if (delBtn) {
      if (!confirmAction('删除学期？课程不会被删除，但会失去周次信息。')) return;
      try {
        await api(`/api/terms/${delBtn.dataset.deleteTerm}`, { method: 'DELETE' });
        toast('学期已删除', 'success');
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
}

function initChannelForms() {
  const tpl = document.getElementById('channel-form-template');
  if (!tpl) return;

  let catalog = [];

  async function loadCatalog() {
    if (catalog.length) return catalog;
    const data = await api('/api/channels/catalog');
    catalog = data.channels || [];
    return catalog;
  }

  /** 按渠道类型渲染配置字段 */
  function renderFields(form, type, values = {}) {
    const def = catalog.find((c) => c.type === type);
    const container = form.querySelector('[data-channel-fields]');
    const guideBox = form.querySelector('[data-channel-guide]');
    const tagline = form.querySelector('[data-channel-tagline]');

    if (!def) {
      container.innerHTML = '';
      if (guideBox) guideBox.innerHTML = '';
      tagline.textContent = '';
      return;
    }

    tagline.innerHTML = `${escapeAttr(def.tagline)}`
      + (def.docs ? ` <a href="${escapeAttr(def.docs)}" target="_blank" rel="noopener">官方说明 →</a>` : '');

    // guide 是渠道自己写死的引导文案（不含任何用户输入），按 HTML 渲染
    if (guideBox) {
      guideBox.innerHTML = def.guide
        ? `<details class="guide" open>
             <summary>${icon('bell', 15)}<span>怎么配置？点这里看详细步骤</span></summary>
             <div class="guide__body">${def.guide}</div>
           </details>`
        : '';
    }

    container.innerHTML = def.fields.map((f) => {
      const value = values[f.key] ?? f.default ?? '';
      // help 同样是我们自己写的静态文案，允许用 <strong>/<br> 等标签做强调
      const help = f.help ? `<p class="field__help">${f.help}</p>` : '';

      if (f.type === 'select') {
        return `<div class="field">
          <label class="field__label">${escapeAttr(f.label)}${f.required ? '<span class="field__req">*</span>' : ''}</label>
          <select class="input" name="cfg_${f.key}">
            ${f.options.map((o) => `<option value="${escapeAttr(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${escapeAttr(o.label)}</option>`).join('')}
          </select>${help}</div>`;
      }

      const inputType = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
      return `<div class="field">
        <label class="field__label">${escapeAttr(f.label)}${f.required ? '<span class="field__req">*</span>' : ''}</label>
        <input class="input" type="${inputType}" name="cfg_${f.key}" value="${escapeAttr(value)}"
               placeholder="${escapeAttr(f.placeholder || '')}" ${f.required ? 'required' : ''}>
        ${help}</div>`;
    }).join('');
  }

  /** 收集配置字段的值 */
  function collectConfig(form, type) {
    const def = catalog.find((c) => c.type === type);
    const config = {};
    for (const f of def?.fields || []) {
      const el = form.querySelector(`[name=cfg_${f.key}]`);
      if (el) config[f.key] = el.value;
    }
    return config;
  }

  /**
   * 把服务器返回的（已修正的）配置回填到表单。
   *
   * 返回一句人话描述改了哪些字段；没改动就返回空字符串。
   * 目的是让「你粘了一整段网址，结果我们只取出了 Key」这件事被用户看见，
   * 而不是默默发生。这里直接显示新值——它马上就会出现在输入框里，
   * 不存在额外泄露。
   */
  function applyNormalizedConfig(form, type, returned) {
    if (!returned || typeof returned !== 'object') return '';
    const def = catalog.find((c) => c.type === type);
    const changes = [];

    for (const f of def?.fields || []) {
      const el = form.querySelector(`[name=cfg_${f.key}]`);
      if (!el) continue;

      const before = el.value;
      const after = String(returned[f.key] ?? '');
      if (after === before) continue;
      if (!after && before) continue; // 不要把用户填的内容清空

      el.value = after;
      changes.push(after ? `${f.label} 改成「${after}」` : `${f.label} 已留空`);
    }

    return changes.join('，');
  }

  async function openChannelForm(channel, preselectType) {
    try {
      await loadCatalog();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const frag = fromTemplate('channel-form-template');
    const form = frag.querySelector('form');
    const typeSelect = form.querySelector('[data-channel-type]');

    const initialType = channel?.type || preselectType || 'bark';
    typeSelect.value = initialType;
    renderFields(form, initialType, channel?.config || {});

    typeSelect.addEventListener('change', () => {
      renderFields(form, typeSelect.value, {});
    });

    if (channel) {
      form.querySelector('[name=id]').value = channel.id;
      form.querySelector('[name=name]').value = channel.name || '';
      form.querySelector('[name=enabled]').checked = channel.enabled;
      form.querySelector('[name=isDefault]').checked = channel.is_default;
    }

    form.querySelector('[data-modal-close]').addEventListener('click', closeModal);

    // 测试发送
    form.querySelector('[data-test-channel]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.classList.add('is-loading');
      const type = typeSelect.value;

      /**
       * 服务器可能修正了我们填的内容（典型情况：把 Bark 首页的整段网址
       * 拆成了「服务器地址 + Key」）。不管测试成功还是失败都要回填，
       * 否则用户改完 Key 再测一次，还得重新面对同一段网址。
       */
      const applyFix = (returned) => {
        const fixed = applyNormalizedConfig(form, type, returned);
        if (fixed) toast(`已自动修正填写内容：${fixed}`, 'info', 9000);
      };

      try {
        const result = await api('/api/channels/test', {
          method: 'POST',
          body: { type, config: collectConfig(form, type) },
        });
        applyFix(result.config);
        toast(result.detail || '测试消息已发送，检查一下手机', 'success', 6000);
      } catch (err) {
        // 失败时服务器同样会回传修正后的配置（见 err.data）
        applyFix(err.data?.config);
        toast(`测试失败：${err.message}`, 'error', 12000);
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-loading');
      }
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;

      const payload = {
        type: typeSelect.value,
        name: form.querySelector('[name=name]').value,
        config: collectConfig(form, typeSelect.value),
        enabled: form.querySelector('[name=enabled]').checked,
        isDefault: form.querySelector('[name=isDefault]').checked,
      };

      try {
        if (channel) {
          await api(`/api/channels/${channel.id}`, { method: 'PATCH', body: payload });
          toast('渠道已更新', 'success');
        } else {
          await api('/api/channels', { method: 'POST', body: payload });
          toast('渠道已添加。建议点「测试」确认能收到消息。', 'success', 6000);
        }
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    openModal({ title: channel ? '编辑提醒渠道' : '添加提醒渠道', content: frag, wide: true });
  }

  document.addEventListener('click', async (e) => {
    const newBtn = e.target.closest('[data-new-channel]');
    if (newBtn) {
      openChannelForm(null, newBtn.dataset.preselect);
      return;
    }

    const editBtn = e.target.closest('[data-edit-channel]');
    if (editBtn) {
      try {
        const data = await api('/api/channels');
        const channel = (data.channels || []).find((c) => String(c.id) === String(editBtn.dataset.editChannel));
        if (!channel) throw new Error('渠道不存在');
        openChannelForm(channel);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-channel]');
    if (delBtn) {
      if (!confirmAction(`删除提醒渠道「${delBtn.dataset.name}」？之后该渠道不会再收到提醒。`)) return;
      try {
        await api(`/api/channels/${delBtn.dataset.deleteChannel}`, { method: 'DELETE' });
        toast('渠道已删除', 'success');
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    const testBtn = e.target.closest('[data-test-channel-id]');
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.classList.add('is-loading');
      try {
        const result = await api(`/api/channels/${testBtn.dataset.testChannelId}/test`, { method: 'POST' });
        toast(result.detail || '测试消息已发送', 'success', 6000);
      } catch (err) {
        toast(`测试失败：${err.message}`, 'error', 8000);
      } finally {
        testBtn.disabled = false;
        testBtn.classList.remove('is-loading');
      }
      return;
    }

    const testAllBtn = e.target.closest('[data-test-all-channels]');
    if (testAllBtn) {
      testAllBtn.disabled = true;
      testAllBtn.classList.add('is-loading');
      try {
        const result = await api('/api/channels/test-all', { method: 'POST' });
        const ok = result.results.filter((r) => r.ok).length;
        const failed = result.results.filter((r) => !r.ok);
        toast(`测试完成：${ok} 个成功${failed.length ? `，${failed.length} 个失败` : ''}`,
          failed.length ? 'info' : 'success', 6000);
        for (const f of failed) toast(`${f.channelName || f.type}：${f.detail}`, 'error', 8000);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        testAllBtn.disabled = false;
        testAllBtn.classList.remove('is-loading');
      }
      return;
    }

    const runBtn = e.target.closest('[data-run-scheduler]');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.classList.add('is-loading');
      try {
        const result = await api('/api/scheduler/run', { method: 'POST' });
        const r = result.result?.reminders;
        toast(
          r
            ? `检查完成：处理了 ${r.picked} 条提醒，成功 ${r.sent} 条，失败 ${r.failed} 条`
            : '检查完成',
          'success',
        );
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('is-loading');
      }
    }
  });
}

function initSettingsForm() {
  const form = document.querySelector('[data-settings-form]');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;

    const raw = formToObject(form);
    const payload = {};
    for (const [key, value] of Object.entries(raw)) {
      const el = form.querySelector(`[name="${CSS.escape(key)}"]`);
      if (el?.type === 'checkbox') payload[key] = el.checked ? '1' : '0';
      else payload[key] = value;
    }

    try {
      await api('/api/settings', { method: 'POST', body: payload });
      toast('设置已保存', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ============================================================
// 字段级错误
//
// 以前表单填错了只有两条路：浏览器自带的气泡（样式不可控、点到别处就没了），
// 或者页面右上角一个 toast。toast 的问题是**不说是哪个框** ——
// 一个表单七八个字段，用户得自己一个个猜是哪里不对。
//
// 这里的做法：错误挂在出错的那个字段正下方，同时给 input 打上
// aria-invalid（读屏会念「无效」）和 aria-describedby（读屏会念出错误内容）。
// ============================================================

/**
 * 判断一个输入框为什么不合法，返回中文原因；没问题就返回空串。
 *
 * 刻意写成**纯函数**（只读传进来的对象，不碰 DOM、不写任何东西）：
 * 这样测试能拿一个假对象直接跑，而不是只 grep 源码里有没有某个字符串。
 * grep 那种写法挡不住「往函数开头插一句 return ''」—— 字符串都还在，断言照样绿。
 *
 * @param {object} input 形如 HTMLInputElement（只用 getAttribute / value / minLength）
 * @param {string} label 这个字段叫什么（用于组装人话）
 */
function invalidReason(input, label = '这一项') {
  const raw = String(input.value ?? '');
  const value = raw.trim();
  const attr = (n) => input.getAttribute(n);

  // 必填：空着才报。不能因为「只有一个空格」就放过，所以先 trim。
  if (attr('required') !== null && value === '') return `请填写${label}`;

  // 没填又非必填的，后面都不该报错（不能对着一个空框喊「格式不对」）
  if (value === '') return '';

  const type = String(input.type || attr('type') || '').toLowerCase();

  if (type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return `${label}要填数字`;
    const min = attr('min');
    const max = attr('max');
    if (min !== null && num < Number(min)) return `${label}不能小于 ${min}`;
    if (max !== null && num > Number(max)) return `${label}不能大于 ${max}`;
  }

  // minlength：值和属性都按「字符数」算，中文一个字算一个 ——
  // 和 HTML 的 minlength 语义一致（它数的就是 UTF-16 码元，中文一字一个）
  const minLen = attr('minlength');
  if (minLen !== null && value.length < Number(minLen)) {
    return `${label}至少 ${minLen} 位`;
  }

  const pattern = attr('pattern');
  if (pattern) {
    try {
      if (!new RegExp(`^(?:${pattern})$`).test(value)) return `${label}格式不对`;
    } catch {
      /* 属性里的正则写错了不该让整个表单报错 */
    }
  }

  return '';
}

/** 找到字段的显示名：优先 aria-label，其次这个 .field 里的 label 文字 */
function labelOf(input) {
  const aria = input.getAttribute('aria-label');
  if (aria) return aria;
  const field = input.closest('.field') || input.parentElement;
  const label = field?.querySelector('label');
  return label ? label.textContent.replace(/\*/g, '').trim() : '这一项';
}

/**
 * 把一条错误挂到某个字段下方。
 *
 * 元素懒创建、可以重复调用（第二次只换文字），所以调用方不用管顺序。
 * 错误文字用 createTextNode 塞进去、不用 innerHTML ——
 * 里面可能夹着用户输入（比如课程名），拼字符串早晚会漏一个转义。
 */
function setFieldError(input, message) {
  if (!input || !message) return;
  const field = input.closest('.field') || input.parentElement;
  if (!field) return;

  let box = field.querySelector('.field__error');
  if (!box) {
    box = document.createElement('p');
    box.className = 'field__error';
    box.id = `fe_${Math.random().toString(36).slice(2, 9)}`;
    // 图标来自服务端注入的可信路径表；文案走 textContent，两者分开更安全
    box.innerHTML = icon('alert', 13);
    field.appendChild(box);
  }
  // 只留图标那一个子节点，其余重建（重复调用时不会越堆越多）
  while (box.childNodes.length > 1) box.removeChild(box.lastChild);
  box.appendChild(document.createTextNode(message));

  input.setAttribute('aria-invalid', 'true');
  // 合并而不是覆盖：字段本身可能已经有一个 aria-describedby（比如密码规则说明）
  const described = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  described.add(box.id);
  input.setAttribute('aria-describedby', [...described].join(' '));
}

/** 清掉一个字段的错误 */
function clearFieldError(input) {
  if (!input) return;
  const field = input.closest('.field') || input.parentElement;
  const box = field?.querySelector('.field__error');
  if (box) box.remove();
  input.removeAttribute('aria-invalid');
  // 只摘掉自己加的那个 id，别把字段原有的说明一起摘了
  const rest = (input.getAttribute('aria-describedby') || '')
    .split(/\s+/).filter((id) => id && !id.startsWith('fe_'));
  if (rest.length) input.setAttribute('aria-describedby', rest.join(' '));
  else input.removeAttribute('aria-describedby');
}

/** 清掉一个容器里的所有字段错误（提交成功后调用） */
function clearFieldErrors(scope = document) {
  for (const box of scope.querySelectorAll('.field__error')) box.remove();
  for (const input of scope.querySelectorAll('[aria-invalid]')) {
    input.removeAttribute('aria-invalid');
    const rest = (input.getAttribute('aria-describedby') || '')
      .split(/\s+/).filter((id) => id && !id.startsWith('fe_'));
    if (rest.length) input.setAttribute('aria-describedby', rest.join(' '));
    else input.removeAttribute('aria-describedby');
  }
}

/**
 * 校验一个容器里所有该校验的字段，把错误挂上去。
 * @returns {HTMLElement|null} 第一个出错的输入框（方便聚焦滚动过去）
 */
function validateFields(scope) {
  const inputs = scope.querySelectorAll('input[required], input[minlength], input[min], input[max], input[pattern], select[required], textarea[required]');
  let first = null;
  for (const input of inputs) {
    const reason = invalidReason(input, labelOf(input));
    if (reason) {
      setFieldError(input, reason);
      if (!first) first = input;
    } else {
      clearFieldError(input);
    }
  }
  return first;
}

/** 聚焦到第一个出错的字段（顺手把它滚进视野，手机上调出键盘后不至于看不见） */
function focusFirstInvalid(input) {
  if (!input) return false;
  input.focus({ preventScroll: true });
  if (typeof input.scrollIntoView === 'function') {
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return true;
}

/** 用户一开始改某个字段，就把它的错误去掉 —— 不用等再次提交 */
function initFieldErrors() {
  const clearOne = (e) => {
    const input = e.target.closest?.('input, select, textarea');
    if (input && input.getAttribute('aria-invalid') === 'true') clearFieldError(input);
  };
  // 用捕获阶段：有些组件的 input 事件会在冒泡路上被 stopPropagation 吃掉
  document.addEventListener('input', clearOne, true);
  document.addEventListener('change', clearOne, true);
}

// ============================================================
// 学校选择 + 个人资料
// ============================================================

/**
 * 学校输入框的候选下拉。
 *
 * 为什么不把 3013 个校名一次性写进页面：注册页是**首屏**，
 * 那样要多传约 120KB 的 HTML。按输入内容去 `/api/schools` 取，
 * 每次只有几百字节。
 *
 * 细节：
 *   · 输入停顿 180ms 才发请求 —— 每敲一个字就发一次，打字快的人会打出一串请求；
 *   · 用 AbortController 取消上一次请求：不然「东」的响应可能比「东北」晚回来，
 *     把已经过时的候选盖上去（这个现象叫乱序响应，很难复现也很难查）；
 *   · 键盘要能用：上下键选、回车确认、Esc 关掉 —— 只用鼠标的下拉等于没做；
 *   · 但它只是一个**提示**：真正说了算的是服务端按名单校验，
 *     所以即使 JS 挂了、用户手打了校名，也不会因此写进一个假学校。
 */
function initSchoolPickers() {
  const combos = [...document.querySelectorAll('[data-school-combo]')];
  if (!combos.length) return;

  for (const combo of combos) {
    const input = combo.querySelector('input');
    const list = combo.querySelector('.combo__list');
    if (!input || !list) continue;

    let timer = null;
    let controller = null;
    let items = [];
    let active = -1;

    const close = () => {
      list.hidden = true;
      list.textContent = '';
      items = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
    };

    const highlight = (i) => {
      active = i;
      [...list.children].forEach((el, n) => {
        el.classList.toggle('is-active', n === i);
        el.setAttribute('aria-selected', n === i ? 'true' : 'false');
        if (n === i) el.scrollIntoView({ block: 'nearest' });
      });
    };

    const show = (schools) => {
      items = schools;
      list.textContent = '';
      if (!schools.length) return close();
      for (const [i, s] of schools.entries()) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'combo__item';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        // 校名 + 所在地：校名相似的学校靠所在地区分
        const nameEl = document.createElement('span');
        nameEl.className = 'combo__name';
        nameEl.textContent = s.name;
        row.appendChild(nameEl);
        if (s.place) {
          const placeEl = document.createElement('span');
          placeEl.className = 'combo__place';
          placeEl.textContent = s.place;
          row.appendChild(placeEl);
        }
        row.addEventListener('mousedown', (e) => {
          // mousedown 而不是 click：click 之前 input 会先 blur，下拉已经关了
          e.preventDefault();
          input.value = s.name;
          close();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        list.appendChild(row);
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(0);
    };

    const search = async () => {
      const q = input.value.trim();
      if (q.length < 2) return close();
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`/api/schools?q=${encodeURIComponent(q)}`, {
          signal: controller.signal, headers: { Accept: 'application/json' },
        });
        if (!res.ok) return close();
        const data = await res.json();
        show(data.schools || []);
      } catch {
        // 断网或被 abort 都只是"没有候选"，不该弹错误打断用户填表
        close();
      }
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(active + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        input.value = items[active].name;
        close();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (e.key === 'Escape') close();
    });
  }
}

/**
 * 个人资料表单。
 *
 * 学校不在名单里时，服务端会回 400 并说明原因 —— 那个错误要挂在
 * 「学校」这个字段下面，而不是弹一个飘走的提示（用户得知道改哪一格）。
 */
function initProfileForm() {
  const form = document.querySelector('[data-profile-form]');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const raw = formToObject(form);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      const result = await api('/api/profile', {
        method: 'POST',
        body: {
          displayName: raw.displayName || '',
          school: raw.school || '',
          college: raw.college || '',
          major: raw.major || '',
        },
      });
      if (result?.schoolVerified) {
        toast('资料已保存。校友社区里能看到你学校的人了', 'success');
      } else if (String(raw.school || '').trim()) {
        toast('资料已保存', 'success');
      } else {
        toast('资料已保存。填上学校才能进校友社区', 'success', 6000);
      }
      // 页面上的昵称、侧栏头像首字母都是从服务端渲染的，重载才能刷新
      setTimeout(reloadPreservingScroll, 700);
    } catch (err) {
      if (!placeServerError(form, err.message)) toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  });
}

/**
 * 头像上传 / 删除。
 *
 * ⚠️ 上传走**单独的接口**，不跟着「保存资料」一起提交。
 * 合成一个表单的话，每次改昵称都会把头像文件重传一遍（几 MB），
 * 而且没选文件时还得小心别把已有头像冲掉。
 *
 * 也不在这里做格式校验：说了算的是服务端（看文件头）。
 * 前端只挡一下「体积明显超了」，省一次白跑 —— 但这只是体验，不是安全边界。
 */
function initAvatarForm() {
  const box = document.querySelector('[data-avatar-edit]');
  if (!box) return;
  const input = box.querySelector('[data-avatar-input]');
  const preview = box.querySelector('[data-avatar-preview]');

  const upload = box.querySelector('[data-avatar-upload]');
  upload?.addEventListener('click', async () => {
    const file = input?.files?.[0];
    if (!file) {
      // 挂到 file 输入框上，比一个会飘走的提示好定位
      setFieldError(input, '先选一张图片');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setFieldError(input, `这张 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 2MB 了`);
      return;
    }
    clearFieldError(input);

    const fd = new FormData();
    fd.append('file', file, file.name);
    upload.disabled = true;
    upload.classList.add('is-loading');
    try {
      await api('/api/avatar', { method: 'POST', body: fd, raw: true });
      toast('头像已更新', 'success');
      // 头像地址带 ETag，但页面上的 <img> 还是旧的 —— 重载最省事
      setTimeout(reloadPreservingScroll, 600);
    } catch (err) {
      if (!placeServerError(document.querySelector('[data-profile-form]') || document, err.message)) {
        toast(err.message, 'error', 8000);
      }
    } finally {
      upload.disabled = false;
      upload.classList.remove('is-loading');
    }
  });

  box.querySelector('[data-avatar-remove]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('/api/avatar', { method: 'DELETE' });
      toast('头像已删掉，改回昵称首字母', 'success');
      setTimeout(reloadPreservingScroll, 600);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  // 选完文件就能看到缩略图，不用先上传再等
  input?.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file || !preview) return;
    clearFieldError(input);
    const url = URL.createObjectURL(file);
    preview.textContent = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '待上传的头像预览';
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    preview.appendChild(img);
  });
}

// ============================================================
// 「照着课表录入」
// ============================================================

/**
 * 录入表格生成的 CSV 表头。
 *
 * ⚠️ 这一行必须和服务端 `src/web/pages/import.js` 里的 `ENTRY_CSV_HEADER`
 * 一模一样 —— 服务端靠表头文字认列名，对不上时它认不出任何一列，
 * 于是**不报错**，只是"导入 0 门课程"。有一条测试专门盯着这两边相等。
 */
const ENTRY_CSV_HEADER = '课程名称,教师,学分,星期,上课时间,周次,上课地点';

/**
 * 把一个字段值转成 CSV 单元格。
 *
 * ⚠️ 这几条都不能省：课程名里出现逗号、地点里出现引号（`之远楼"东"301`）
 * 都很常见。不转义的话整行列数就错位，而错位之后**不报错** ——
 * 只是字段被塞到别的列里去，导入结果看着"有点怪"，很难查。
 * 规则就是 RFC 4180 那套：含逗号/引号/换行就整体加引号，内部引号写两个。
 */
function csvCell(value) {
  const s = String(value ?? '').trim();
  if (s === '') return '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 把录入的每一行拼成 CSV 文本。**纯函数**，好测。
 *
 * 列的顺序和表头必须和服务端期望的一致（服务端靠表头认列名）：
 *   课程名称,教师,学分,星期,上课时间,周次,上课地点
 *
 * 学分一律留空：PDF 里没有这个信息，**不猜**比猜错好 —— 猜了会静默写进库里，
 * 之后按学分算绩点就全错了。
 * 节次（`5-7`）直接填进「上课时间」列：服务端会用**用户自己的作息表**换算，
 * 所以这里一行时间计算都不做，也就不可能和服务端口径不一致。
 *
 * @param {Array<object>} rows
 * @param {string} header
 * @returns {string}
 */
function entryRowsToCsv(rows, header) {
  const lines = [header];
  for (const r of rows) {
    // 课程名空着的行整行跳过 —— 表格默认给 4 行空行，
    // 不跳过的话会往库里写一堆空课程
    if (!String(r?.name || '').trim()) continue;
    lines.push([
      csvCell(r.name),
      csvCell(r.teacher),
      '',                    // 学分：留空，不猜
      csvCell(r.weekday),
      csvCell(r.periods),    // 节次，交给服务端换算
      csvCell(r.weeks),
      csvCell(r.place),
    ].join(','));
  }
  return lines.join('\n');
}

/**
 * 录入表格的交互：加行、删行、提交前把表格拼成 CSV 塞进隐藏字段。
 *
 * 为什么要「拼成 CSV 再交给老路」：这样一行新的写库代码都不用加 ——
 * 解析、预览、冲突处理、写库全是现成的，表格只是更好用的输入方式。
 */
function initManualImport() {
  const form = document.querySelector('[data-manual-import]');
  if (!form) return;

  const tbody = form.querySelector('[data-entry-rows]');
  const tpl = document.getElementById(form.dataset.entryTemplate || 'entry-row-template');
  if (!tbody) return;

  const collect = () => [...tbody.querySelectorAll('[data-entry-row]')].map((row) => ({
    name: row.querySelector('[name=e_name]')?.value || '',
    teacher: row.querySelector('[name=e_teacher]')?.value || '',
    weekday: row.querySelector('[name=e_weekday]')?.value || '',
    periods: row.querySelector('[name=e_periods]')?.value || '',
    weeks: row.querySelector('[name=e_weeks]')?.value || '',
    place: row.querySelector('[name=e_place]')?.value || '',
  }));

  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-entry-row]')) {
      if (!tpl) return;
      const row = tpl.content.firstElementChild.cloneNode(true);
      tbody.appendChild(row);
      // 加完把光标送过去，省得再点一下
      row.querySelector('input')?.focus();
      return;
    }
    const del = e.target.closest('[data-remove-entry-row]');
    if (!del) return;
    const rows = tbody.querySelectorAll('[data-entry-row]');
    // 至少留一行：全删光之后表格看着像坏了，也没有能输入的地方
    if (rows.length <= 1) {
      for (const input of rows[0].querySelectorAll('input')) input.value = '';
      const sel = rows[0].querySelector('select');
      if (sel) sel.value = '';
      return;
    }
    del.closest('[data-entry-row]')?.remove();
  });

  form.addEventListener('submit', (e) => {
    const rows = collect();
    if (rows.every((r) => !r.name.trim())) {
      e.preventDefault();
      // 挂到第一行的「课程名」上，而不是弹一个会飘走的 toast
      const first = tbody.querySelector('[name=e_name]');
      setFieldError(first, '至少填一门课再提交');
      focusFirstInvalid(first);
      return;
    }
    form.querySelector('[name=text]').value = entryRowsToCsv(rows, ENTRY_CSV_HEADER);
  });
}

// ============================================================
// 课表的「当前时间线」
// ============================================================

/** 'HH:MM' → 分钟数；格式不对返回 null */
function hmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 算「当前时间线」在这一行里的纵向位置（像素）。**纯函数**，好测。
 *
 * 为什么不给个百分比就完事：行高是 minmax(42px, auto)，由内容决定 ——
 * 一节 45 分钟的课和一段两小时的课格子一样高。所以「现在过了这一节的
 * 百分之多少」在**视觉上**就是「这一行高度的百分之多少」，
 * 这里要的就是这个比例，而不是真实时长比例。
 *
 * @param {{rowHeight:number, startHm:string, endHm:string, nowHm:string}} p
 * @returns {{offset:number, fraction:number}|null} null = 现在不在这一行里，别画
 */
function nowLineOffset({ rowHeight, startHm, endHm, nowHm }) {
  const start = hmToMinutes(startHm);
  const end = hmToMinutes(endHm);
  const now = hmToMinutes(nowHm);
  if (start === null || end === null || now === null) return null;
  // 起止时间一样（或者反了）是坏数据，画出来会是除以 0 或者一条位置随机线
  if (end <= start) return null;
  // 现在不在这一行的时间范围内 —— 说明页面开太久了，行已经过期，
  // 这时候应该把线藏起来，而不是把它钉在边上装作还准
  if (now < start || now > end) return null;

  const fraction = (now - start) / (end - start);
  const height = Number(rowHeight) > 0 ? Number(rowHeight) : 0;
  // 这里**不需要**再夹一次边界：上面那两条 return 已经保证了
  // start <= now <= end，所以 fraction 必落在 [0,1]、offset 必落在 [0,height]。
  // 一开始写的是 Math.max(0, Math.min(height, …))，反向验证时发现它
  // **永远不可能生效** —— 删掉它所有测试照样绿。一条永远不执行的"保险"
  // 比没有更糟：它会让人以为这里挡着什么。真正在挡的是上面那两条判断，
  // 测试里也有一条「逐分钟扫过去」的断言守着。
  return { offset: Math.round(fraction * height), fraction };
}

/**
 * 把课表上那条「当前时间线」摆到位，并且每分钟跟着走。
 *
 * 位置只能在浏览器里量：那一行到底多少像素，服务端不知道。
 */
function initNowLine() {
  const el = document.querySelector('[data-now-line]');
  if (!el) return;

  const place = () => {
    const now = new Date();
    const nowHm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const box = el.getBoundingClientRect();
    const pos = nowLineOffset({
      rowHeight: box.height,
      startHm: el.dataset.start,
      endHm: el.dataset.end,
      nowHm,
    });
    if (!pos) {
      // 时间已经走出这一行了：藏起来。宁可不显示，也不要给一个错的位置。
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.setProperty('--now-offset', `${pos.offset}px`);
  };

  place();
  // 每分钟挪一次。60 秒对一条 1.5px 的线足够了 ——
  // 一秒一次只会白白唤醒主线程，而人眼也看不出差别。
  setInterval(place, 60_000);
  // 转到别的窗口再回来时补一次：定时器在后台标签页里会被浏览器降频
  document.addEventListener('visibilitychange', () => { if (!document.hidden) place(); });
  window.addEventListener('resize', place);
}

/**
 * 「服务端这句话是在说哪个字段」的对照表。
 *
 * ⚠️ 关键词要写得**具体**。写宽了会指错字段，而指错比不指更糟 ——
 * 用户会盯着一个没问题的框改半天。比如「课程」就不能单独作为关键词：
 * 「截止时间不能早于课程开始」这句话里也有「课程」。
 */
const SERVER_ERROR_FIELDS = [
  ['title', [/标题/]],
  ['dueAt', [/截止时间/, /截止/]],
  ['courseId', [/所属课程/, /课程不存在/, /课程不是你/]],
  ['name', [/课程名/, /学期名/, /名称/]],
  ['credits', [/学分/]],
  ['hours', [/学时/]],
  ['key', [/Key/i, /推送令牌/, /设备令牌/]],
  ['server', [/服务器地址/]],
  ['currentPassword', [/当前密码/]],
  ['newPassword', [/新密码/]],
  ['startDate', [/开始日期/]],
  ['weekCount', [/周数/, /周次/]],
  ['text', [/表格内容/, /粘贴/]],
];

/**
 * 判断一条服务端错误该挂到哪个字段上。**纯函数**（好测）。
 *
 * 只在**恰好一个**规则命中、而且那个字段确实在这个表单里时才认。
 * 命中多个说明这句话同时提到了好几个字段（比如「学分的格式和学时一样」），
 * 那就没有唯一答案 —— 交给调用方退回 toast，别硬指一个。
 *
 * @param {string} message 服务端返回的错误文案
 * @param {string[]} availableNames 这个表单里实际存在的字段名
 * @returns {string|null}
 */
function pickErrorField(message, availableNames) {
  const text = String(message || '');
  if (!text) return null;

  const hits = new Set();
  for (const [field, patterns] of SERVER_ERROR_FIELDS) {
    if (!availableNames.includes(field)) continue;
    if (patterns.some((re) => re.test(text))) hits.add(field);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * 把服务端错误挂到具体字段上。
 * @returns {boolean} 挂上了没有；false 表示调用方该退回 toast
 */
function placeServerError(form, message) {
  const names = [...form.querySelectorAll('[name]')].map((el) => el.name);
  const field = pickErrorField(message, names);
  if (!field) return false;
  const input = form.querySelector(`[name="${field}"]`);
  if (!input) return false;
  setFieldError(input, message);
  focusFirstInvalid(input);
  return true;
}

function initPasswordForm() {
  const form = document.querySelector('[data-password-form]');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = formToObject(form);
    clearFieldErrors(form);

    // 这两条以前是 toast。改成挂在字段下面：
    // 「两次不一致」这种错，用户需要**同时看到那两个框**才好改，
    // 一个 3.6 秒就消失的浮动提示帮不上忙。
    if (raw.newPassword !== raw.confirmPassword) {
      const confirm = form.querySelector('[name=confirmPassword]');
      setFieldError(confirm, '两次输入的新密码不一样');
      confirm.select?.();
      focusFirstInvalid(confirm);
      return;
    }
    // 长度下限**从输入框自己身上读**（服务端渲染的 minlength），不要在客户端再写一个数字：
    // 写死的话，服务端把规则改成 8 位之后这里还是 6，用户会在前端被放过去、
    // 然后吃一个服务端的报错 —— 或者反过来，前端拦下服务端允许的密码。
    // input.minLength 在没写这个属性时是 0，所以退回到服务端同款 8。
    const pwInput = form.querySelector('[name=newPassword]');
    const minLen = Number(pwInput?.minLength) || 8;
    if (String(raw.newPassword).length < minLen) {
      setFieldError(pwInput, `新密码至少 ${minLen} 位`);
      focusFirstInvalid(pwInput);
      return;
    }

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/password', {
        method: 'POST',
        body: { currentPassword: raw.currentPassword, newPassword: raw.newPassword },
      });
      // 提示要说清副作用：改密码会踢掉其他设备、并且把日历订阅链接作废。
      // 不说明的话，用户过几天发现手机日历不更新了，会以为是自己弄坏的。
      toast('密码已修改。其他设备已退出登录，日历订阅链接也已作废（需要在设置里重新复制一条）',
        'success', 8000);
      clearFieldErrors(form);
      form.reset();
    } catch (err) {
      // 「当前密码不正确」这类错误就该显示在「当前密码」那个框下面
      if (!placeServerError(form, err.message)) toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * 「退出其他所有设备」和「重新生成订阅链接」。
 *
 * 两个都是「把已经发出去的钥匙作废」，点了立刻生效、没有回收站，
 * 所以都先弹一句确认 —— 但**不用弹窗**：影响的只是登录状态和一条链接，
 * 重新弄一次成本很低，不像注销账号那样不可逆。
 */
function initRevokeButtons() {
  const confirmThen = async (btn, message, url, done) => {
    if (!window.confirm(message)) return;
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      await api(url, { method: 'POST' });
      done();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  };

  document.addEventListener('click', (e) => {
    const sessionBtn = e.target.closest('[data-revoke-sessions]');
    if (sessionBtn) {
      confirmThen(sessionBtn,
        '把其他所有设备上的登录都退出？\n（这台设备不受影响）',
        '/api/sessions/revoke-others',
        () => toast('其他设备已全部退出登录', 'success'));
      return;
    }

    const calBtn = e.target.closest('[data-regenerate-calendar]');
    if (calBtn) {
      confirmThen(calBtn,
        '重新生成订阅链接？\n以前发出去的链接会立刻失效，手机日历里需要重新添加一次订阅。',
        '/api/calendar/regenerate',
        () => {
          toast('订阅链接已重新生成，正在刷新页面…', 'success');
          // 页面上显示的链接是服务端渲染出来的，必须重载才能拿到新的。
          setTimeout(() => window.location.reload(), 700);
        });
    }
  });
}

function initSchedulerButton() {
  // 已合并进 initChannelForms 的事件委托
}

/**
 * 注销账号（设置页 → 账号）。
 *
 * 刻意不进弹窗就什么都不做：这是一个没有回收站的操作，
 * 表单藏在弹窗里、弹窗里还有一段红字说明，就是为了让「点错」多绕两步。
 *
 * 服务端才是真正把关的地方（要密码 + 用户名原样确认），
 * 这里只负责把表单送过去、成功之后把人送回登录页。
 */
function initDeleteAccount() {
  const trigger = document.querySelector('[data-open-delete-account]');
  const tpl = document.getElementById('delete-account-form-template');
  if (!trigger || !tpl) return;

  trigger.addEventListener('click', () => {
    const form = tpl.content.firstElementChild.cloneNode(true);

    form.querySelector('[data-modal-close]')?.addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const btn = form.querySelector('button[type=submit]');
      const raw = formToObject(form);

      const sure = confirmAction(
        '真的要注销账号吗？\n\n课表、作业、课件、提醒和推送记录都会被永久删除，无法恢复。',
      );
      // 原生 confirm 被禁用（某些嵌入式环境）时不阻断：服务端的两道确认仍在
      if (sure === false) return;

      btn.disabled = true;
      try {
        const result = await api('/api/account/delete', {
          method: 'POST',
          body: {
            password: raw.password,
            confirmUsername: raw.confirmUsername,
          },
        });
        closeModal();
        // 会话已经在服务端清掉了，所以只能去登录页；
        // 用整页跳转而不是前端路由，顺便把内存里的旧数据一起丢掉
        window.location.href = `/login?deleted=${encodeURIComponent(result?.username || '')}`;
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    openModal({ title: '注销账号', content: form });
  });
}

// ============================================================
// 导入页
// ============================================================

function initImport() {
  const icsForm = document.querySelector('[data-import-ics-form]');
  if (icsForm) {
    icsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = icsForm.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.classList.add('is-loading');
      icsForm.submit(); // 走传统表单提交，服务端渲染预览结果
    });
  }

  const textForm = document.querySelector('[data-import-text-form]');
  if (textForm) {
    textForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = textForm.querySelector('[name=text]').value.trim();
      const file = textForm.querySelector('[name=file]').files[0];

      if (!text && !file) {
        toast('请粘贴表格内容或选择一个文件', 'error');
        return;
      }

      const btn = textForm.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.classList.add('is-loading');
      textForm.submit();
    });
  }

  // 确认导入
  const confirmForm = document.querySelector('[data-confirm-import-form]');
  if (confirmForm) {
    confirmForm.addEventListener('submit', (e) => {
      // 把勾选的课程过滤出来再提交
      const included = [...confirmForm.querySelectorAll('input[name=include]:checked')].map((c) => Number(c.value));
      if (!included.length) {
        e.preventDefault();
        toast('请至少选择一门课程', 'error');
        return;
      }

      const payload = JSON.parse(confirmForm.querySelector('[name=payload]').value);
      payload.courses = payload.courses.filter((_, i) => included.includes(i));
      confirmForm.querySelector('[name=payload]').value = JSON.stringify(payload);

      const btn = confirmForm.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.classList.add('is-loading');
    });
  }
}

// ============================================================
// 课表页
// ============================================================

function initTimetable() {
  const grid = document.querySelector('[data-week-grid]');
  if (grid) {
    // 窄屏时自动滚动到「今天」那一列
    const todayHead = grid.querySelector('.week-grid__head.is-today');
    if (todayHead && grid.parentElement.scrollWidth > grid.parentElement.clientWidth) {
      const offset = todayHead.offsetLeft - 60;
      grid.parentElement.scrollLeft = Math.max(0, offset);
    }
  }
}

// ============================================================
// 启动
// ============================================================

function boot() {
  restoreScroll();
  flushPendingToast();
  initTheme();
  initMisc();
  initSlideViewer();
  initMaterialViewer();
  initIosPdfNotice();
  initAssignmentChecks();
  initAssignments();
  initCourses();
  initMaterials();
  initSettings();
  initImport();
  initManualImport();
  initTimetable();
  initNowLine();

  // 全局错误兜底：漏网的失败（没被任何地方 catch 的）也要说出来，不能静默。
  //
  // 这里以前是 `if (!/Failed to fetch|NetworkError/i.test(msg))` —— 也就是
  // **恰好把断网这一类挡掉了**，和上面那句注释写的正好相反。
  // 当时的用意应该是「别把英文原文甩给用户」，但正确的做法是翻译，不是闭嘴。
  window.addEventListener('unhandledrejection', (e) => {
    reportGlobalError(describeFetchError(e.reason));
  });

  // 同步异常同样要兜住。
  // 以前只监听 unhandledrejection，于是事件处理函数里抛的 TypeError
  // 会让按钮「点了完全没反应」，而且除了控制台不留任何痕迹 ——
  // 这正是最容易让人以为是「网站坏了」的那一类。
  window.addEventListener('error', (e) => {
    // 资源加载失败（<img>/<script>）走的是元素上的 error 事件，
    // 正常不会冒到这里；真冒上来了也没有 error 对象，跳过，免得盖住真正的问题
    if (!e.error && !e.message) return;
    reportGlobalError(`页面出错了：${describeFetchError(e.error || e.message)}`);
  });

  document.body.dataset.maxUpload = String(MAX_UPLOAD_BYTES);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { api, toast, closeModal, openModal };
