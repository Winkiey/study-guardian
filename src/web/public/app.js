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
  h.textContent = title || '';
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

  // Esc 关闭
  modalCloseHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', modalCloseHandler);

  // 聚焦第一个输入框
  const firstInput = modal.querySelector('input:not([type=hidden]), select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);

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

function initTheme() {
  const btn = document.querySelector('[data-theme-toggle]');
  if (!btn) return;

  const label = btn.querySelector('.theme-toggle__label');
  const root = document.documentElement;

  const current = () => {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  const sync = () => {
    if (label) label.textContent = current() === 'dark' ? '浅色模式' : '深色模式';
    syncThemeColor(current());
  };
  sync();

  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('sg-theme', next);
    } catch { /* 隐私模式下 localStorage 可能不可用 */ }
    sync();
  });
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

    const openBtn = e.target.closest('[data-open-path]');
    if (openBtn) {
      try {
        await api('/api/open-path', { method: 'POST', body: { path: openBtn.dataset.openPath } });
      } catch (err) {
        toast(err.message, 'error');
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
        closeModal();
        reloadPreservingScroll();
      } catch (err) {
        toast(err.message, 'error');
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

      const problems = [
        credits.error ? `学分${credits.error}` : '',
        hours.error ? `学时${hours.error}` : '',
      ].filter(Boolean);

      if (problems.length) {
        toast(`${problems.join('；')}。请只填数字，例如 3 或 3.5。`, 'error', 8000);
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
        toast(err.message, 'error');
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

      form.querySelector('[data-modal-close]').addEventListener('click', closeModal);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await api(`/api/materials/${material.id}`, { method: 'PATCH', body: formToObject(form) });
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

  const addRow = (prefill = {}) => {
    const row = document.createElement('div');
    row.className = 'period-row';
    row.dataset.periodRow = '';
    row.innerHTML = `
      <div class="period-row__index">
        第 <input class="input input--period-index" type="number" min="1" max="30" name="p_index"
                  aria-label="节次" value="${escapeAttr(prefill.index ?? '')}"> 节
      </div>
      <input class="input" type="time" name="p_start" aria-label="开始时间"
             value="${escapeAttr(prefill.start || '08:00')}">
      <input class="input" type="time" name="p_end" aria-label="结束时间"
             value="${escapeAttr(prefill.end || '08:45')}">
      <span class="period-row__len" data-period-len></span>
      <button type="button" class="btn btn--ghost btn--icon" data-remove-period
              title="删除这一节" aria-label="删除这一节">${'\u00d7'}</button>`;

    row.querySelector('[data-remove-period]').addEventListener('click', () => {
      row.remove();
      // 至少留一行，否则界面空了会让人以为坏了
      if (!rows.children.length) addRow({ index: 1 });
      hideError();
    });

    for (const input of row.querySelectorAll('input')) {
      input.addEventListener('input', () => {
        refreshLength(row);
        hideError();
      });
    }

    rows.appendChild(row);
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
  for (const link of document.querySelectorAll('.anchor-nav a')) {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', link.getAttribute('href'));
      }
    });
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
        toast(
          `「第一周周一」必须选星期一。你选的 ${startDate} 是星期${'日一二三四五六'[picked.getDay()]}，同一周的周一是 ${suggested}。`,
          'error',
          8000,
        );
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
        toast(err.message, 'error');
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
      if (key === 'display_name' || key === 'school') continue; // 这两项走用户资料接口
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

function initPasswordForm() {
  const form = document.querySelector('[data-password-form]');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = formToObject(form);

    if (raw.newPassword !== raw.confirmPassword) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    if (String(raw.newPassword).length < 6) {
      toast('新密码至少 6 位', 'error');
      return;
    }

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/password', {
        method: 'POST',
        body: { currentPassword: raw.currentPassword, newPassword: raw.newPassword },
      });
      toast('密码已修改', 'success');
      form.reset();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
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
  initTimetable();

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
