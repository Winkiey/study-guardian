/**
 * 弹窗的键盘行为 + 手机上的点击目标大小。
 *
 * 两件事都属于「不报错、但用起来会难受」的那一类：
 *
 * 1. **弹窗不拦 Tab。** 弹窗只是盖在页面上，背后那些元素还在 DOM 里、也还能拿到焦点。
 *    按 Tab 会走到被遮住的侧边栏和按钮上，接着按回车触发的是**他看不见的东西**
 *    （比如某个「删除」）。这就是「我什么都没点，怎么删了」的来源。
 *    另外关掉弹窗后焦点会掉回 <body>，键盘用户得从头 Tab 一遍。
 *
 * 2. **点击目标太小。** 筛选胶囊 32px、图标按钮 31px —— 手指的落点比鼠标粗得多。
 *
 * ⚠️ 覆盖范围的实话：第 1 类里真正「按 Tab 会不会跑出去」这回事，
 *    只有浏览器能验；自测里没有浏览器（零依赖，不引 puppeteer）。
 *    所以这里守的是**代码结构**（有没有拦 Tab、有没有把焦点还回去），
 *    配合 A/B 注入确认这些断言真的会红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');
const cssRaw = fs.readFileSync(path.join(root, 'src/web/public/app.css'), 'utf8');

// 匹配前去掉注释：下面这些规则的注释里就写着「Tab」「44px」这些词，
// 不去掉的话正则会先命中注释（这个坑踩过好几次了）
const appCode = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出某个函数的源码（从 function 名起到第一个顶格右括号） */
function fnSource(name) {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(appCode);
  assert.ok(m, `app.js 里应该有 ${name}()`);
  return m[0];
}

/**
 * 把函数抠出来，在**自己造的假对象**上真跑一遍。
 *
 * 为什么非得这样：只 grep 源码的话，「按 Tab 会不会跑出去」这件事测不到 ——
 * 往回调开头插一句 `if (true) return;`，所有字符串都还在，断言照样绿。
 * A/B 校验时就是这么假通过的，所以把逻辑抽成独立函数、在这里真跑。
 */
function loadFn(name, deps = {}) {
  const names = Object.keys(deps);
  const source = fnSource(name);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${source}\nreturn ${name};`)(...names.map((n) => deps[n]));
}

/** 假的可聚焦元素 */
function fakeEl(label, { hidden = false, displayed = true } = {}) {
  return {
    label,
    offsetParent: displayed ? {} : null,
    hasAttribute: (a) => (a === 'hidden' ? hidden : false),
    focused: false,
    focus() { this.focused = true; },
  };
}

const focusableIn = loadFn('focusableIn');

describe('★ 弹窗焦点陷阱（真跑逻辑，不是 grep）', () => {
  // 陷阱逻辑要读 document.activeElement 和 modal.contains
  const makeTrap = (items, active) => {
    const modal = {
      querySelectorAll: () => items,
      contains: (el) => items.includes(el),
    };
    const trap = loadFn('trapTabKey', {
      focusableIn: () => items,
      document: { activeElement: active },
    });
    return { modal, trap };
  };

  test('★ 在最后一个元素上按 Tab → 回到第一个（焦点不许跑出去）', () => {
    const items = [fakeEl('第一个'), fakeEl('中间'), fakeEl('最后一个')];
    const { modal, trap } = makeTrap(items, items[2]);
    let prevented = false;
    trap(modal, { key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });

    assert.equal(prevented, true, '★ 必须拦下默认行为，否则浏览器会把焦点交给弹窗外面的元素');
    assert.equal(items[0].focused, true, '★ 焦点要回到第一个');
  });

  test('★ 在第一个元素上按 Shift+Tab → 跳到最后一个', () => {
    const items = [fakeEl('第一个'), fakeEl('中间'), fakeEl('最后一个')];
    const { modal, trap } = makeTrap(items, items[0]);
    let prevented = false;
    trap(modal, { key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } });

    assert.equal(prevented, true);
    assert.equal(items[2].focused, true, '★ 反向到头要跳到最后一个');
  });

  test('★ 焦点已经被挪到弹窗外面时，按 Tab 要拉回来', () => {
    // 场景：背后的按钮被脚本聚焦了（或者用户点了遮罩后面的东西）
    const items = [fakeEl('第一个'), fakeEl('最后一个')];
    const outsider = fakeEl('弹窗外面那个按钮');
    const modal = { querySelectorAll: () => items, contains: (el) => items.includes(el) };
    const trap = loadFn('trapTabKey', {
      focusableIn: () => items,
      document: { activeElement: outsider },
    });

    let prevented = false;
    trap(modal, { key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, '★ 焦点在外面也要拦下来');
    assert.equal(items[0].focused, true);
  });

  test('中间元素上按 Tab 不拦（让浏览器正常往下走）', () => {
    const items = [fakeEl('第一个'), fakeEl('中间'), fakeEl('最后一个')];
    const { modal, trap } = makeTrap(items, items[1]);
    let prevented = false;
    trap(modal, { key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, '中间不该拦，拦了反而走不动');
  });

  test('弹窗里一个可聚焦元素都没有时不能崩', () => {
    const { modal, trap } = makeTrap([], null);
    assert.doesNotThrow(() => trap(modal, { key: 'Tab', shiftKey: false, preventDefault: () => {} }));
  });

  test('★ 算「能 Tab 到的元素」时把藏起来和禁用的滤掉', () => {
    const visible = fakeEl('看得见的');
    const hiddenAttr = fakeEl('带 hidden 的', { hidden: true });
    const noDisplay = fakeEl('display:none 的', { displayed: false });
    const all = [visible, hiddenAttr, noDisplay];
    const modal = { querySelectorAll: () => all };
    const got = focusableIn(modal);
    assert.deepEqual(got.map((e) => e.label), ['看得见的'],
      '★ 藏起来的元素如果算进去，按 Tab 会「消失一下」再出现');
  });
});

describe('★ 关掉弹窗后焦点要还给打开它的元素', () => {
  test('★ 还回去了', () => {
    const trigger = fakeEl('打开弹窗的那个按钮');
    const restore = loadFn('restoreModalFocus', {
      document: { contains: (el) => el === trigger },
      modalReturnFocus: trigger,
    });
    restore();
    assert.equal(trigger.focused, true, '★ 键盘用户不该被迫从头 Tab 一遍');
  });

  test('★ 那个元素已经不在了也不能崩（列表刷新过）', () => {
    const gone = fakeEl('已经被重新渲染掉的按钮');
    const restore = loadFn('restoreModalFocus', {
      document: { contains: () => false },
      modalReturnFocus: gone,
    });
    assert.doesNotThrow(() => restore());
    assert.equal(gone.focused, false, '不在文档里就不该去聚焦它');
  });

  test('没有记录过触发元素时安全退出', () => {
    const restore = loadFn('restoreModalFocus', {
      document: { contains: () => true },
      modalReturnFocus: null,
    });
    assert.doesNotThrow(() => restore());
  });
});

/** 取出某条规则的正文 */
function ruleBody(selector, { last = false } = {}) {
  const at = last ? css.lastIndexOf(`${selector} {`) : css.indexOf(`${selector} {`);
  assert.ok(at > -1, `样式里应该有 ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

describe('★ 弹窗接线（逻辑已经单独测过，这里只查有没有接上）', () => {
  const openModal = fnSource('openModal');
  const closeModal = fnSource('closeModal');

  test('★ 打开时记下「是谁打开的」', () => {
    assert.match(openModal, /modalReturnFocus\s*=\s*document\.activeElement/,
      '★ 打开时要知道焦点原来在哪，关掉才能还回去');
  });

  test('★ keydown 里接上了陷阱，而且 Tab 走得通', () => {
    assert.match(openModal, /if \(e\.key !== 'Tab'\) return;/, '要专门处理 Tab');
    assert.match(openModal, /trapTabKey\(modal, e\)/, '★ 抽出去的逻辑要真的被调用');
  });

  test('★ closeModal 里接上了「还焦点」', () => {
    assert.match(closeModal, /restoreModalFocus\(\)/, '★ 抽出去的逻辑要真的被调用');
  });

  test('★ 焦点必须落进弹窗里面（否则一开始就不在陷阱里）', () => {
    // 以前是「有输入框才聚焦」，没有输入框的弹窗（比如注销确认）
    // 焦点会一直留在背后的按钮上，Tab 一下就跑出去了
    assert.match(openModal, /const initial = firstInput \|\| closeBtn/,
      '★ 没有输入框时要退回到关闭按钮，不能什么都不聚焦');
  });

  test('★ 弹窗要有可访问名称（role=dialog 不会自动取里面的标题）', () => {
    assert.match(openModal, /setAttribute\('aria-labelledby'/, '★ 要指向标题');
    assert.match(openModal, /h\.id\s*=\s*['"]modal-title['"]/, '标题要有 id 才能被指到');
  });

  test('Esc 仍然能关（别为了做陷阱把原来的行为弄丢）', () => {
    assert.match(openModal, /e\.key === 'Escape'[\s\S]{0,80}closeModal\(\)/);
  });
});

describe('★ 手机上点击目标要够大', () => {
  /**
   * 找出某条规则的正文。
   *
   * ⚠️ 用「前面不是单词字符或连字符」来限定，不能用 indexOf：
   *    `.btn--sm {` 是 `.btn--icon.btn--sm {` 的子串，
   *    用 indexOf 会取到图标按钮那条规则里，算出来的数字是错的。
   */
  function ruleOf(selector, { last = false } = {}) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w-])${escaped}\\s*\\{`, 'g');
    const hits = [...css.matchAll(re)];
    assert.ok(hits.length, `样式里应该有 ${selector}`);
    const hit = last ? hits[hits.length - 1] : hits[0];
    const at = hit.index;
    return css.slice(at, css.indexOf('}', at));
  }

  /**
   * 估算控件的渲染高度：内边距 + 边框 + 内容。
   *
   * 必须把**基础规则和手机覆盖规则合起来看**：覆盖规则常常只写 padding，
   * 边框还是从基础规则继承的。只看覆盖规则会漏掉那个 1px
   * （第一版就是这么少算了 2px，把 41px 算成 39px，差点去改本来没问题的样式）。
   */
  function heightOf(selector, { base = null, fontSize = null, iconSize = null } = {}) {
    const merged = [base ? ruleOf(base) : '', ruleOf(selector, { last: true })].join('\n');
    const pads = [...merged.matchAll(/padding:\s*([\d.]+)px(?:\s+[\d.]+px)?/g)];
    assert.ok(pads.length, `${selector} 应该有 padding`);
    // 后出现的覆盖先出现的
    const pad = Number(pads[pads.length - 1][1]) * 2;
    const borders = /border:\s*1px/.test(merged) ? 2 : 0;
    const content = iconSize !== null ? iconSize : fontSize * 1.7;
    return pad + borders + content;
  }

  test('★ 筛选胶囊、图标按钮、小按钮在手机上都要 ≥ 40px', () => {
    const cases = [
      ['筛选胶囊', heightOf('.filter-tab', { base: '.filter-tab', fontSize: 13 })],
      ['图标按钮', heightOf('.btn--icon.btn--sm', { base: '.btn', iconSize: 15 })],
      ['小按钮', heightOf('.btn--sm', { base: '.btn', fontSize: 13 })],
      ['chip', heightOf('.chip', { base: '.chip', fontSize: 12.5 })],
    ];
    for (const [name, h] of cases) {
      assert.ok(h >= 40, `★ ${name}在手机上只有 ${h.toFixed(1)}px，太小了`);
    }
  });

  test('★ 单独出现的 .link 给足 44px', () => {
    // 它两边没有邻居，撑大不会碰到别人
    assert.match(ruleOf('.link', { last: true }), /min-height:\s*44px/,
      '★ 卡片标题右边的「编辑 / 全部」要够大');
  });

  test('★ 成排的控件靠「间距 + 内边距」，不能用透明覆盖层硬撑', () => {
    // 这是这一节最重要的一条设计约束：相邻按钮各自套一个 44px 的透明覆盖层，
    // 两块区域会重叠，点偏一点就打到隔壁（表格里「设为当前/编辑/删除」挨着）——
    // 那比目标小更糟。所以顺序出现的控件只加大内边距和间隔。
    assert.match(ruleOf('.filter-tabs', { last: true }), /gap:\s*6px/,
      '筛选胶囊之间要留出间隔，不然挨着的两块点不准');
    assert.match(css, /\.table__actions \.btn \+ \.btn \{[^}]*margin-left/,
      '表格操作列里的按钮之间要拉开');
    // 反面：不许出现「给一排小按钮加透明遮罩」那种写法
    assert.doesNotMatch(css, /::after\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
      '不要用透明覆盖层去撑点击区（会和邻居重叠）');
  });
});

describe('★ .link 这个类必须真的有样式', () => {
  test('★ 它是给 <button> 也用的，所以必须清掉浏览器的默认按钮外观', () => {
    // 这条是修 bug 的：.link 以前**根本没有规则**，而标记里已经在用了。
    // 后果：课程详情页的「编辑上课时间」「编辑」是 <button class="link">，
    // 而按钮不会继承 a 的样式 —— 它们显示成浏览器默认的灰底凸起按钮。
    const body = ruleBody('.link');
    assert.match(body, /border:\s*0/, '★ 要去掉默认的按钮边框');
    assert.match(body, /background:\s*none/, '★ 要去掉默认的按钮底色');
    assert.match(body, /font:\s*inherit/, '★ 要用站内的字体，不是系统默认字体');
    assert.match(body, /cursor:\s*pointer/, '要看起来能点');
  });

  test('两种标签（a 和 button）都要能用到它 —— 标记里两种都有', () => {
    const files = ['src/web/pages/courses.js', 'src/web/pages/dashboard.js'];
    let buttonUses = 0;
    let anchorUses = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      buttonUses += (src.match(/<button[^>]*class="link"/g) || []).length;
      anchorUses += (src.match(/<a[^>]*class="link"/g) || []).length;
    }
    assert.ok(buttonUses > 0, '前提：确实有 <button class="link"> 在用（课程详情页那两个）');
    assert.ok(anchorUses > 0, '前提：也确实有 <a class="link"> 在用');
  });
});
