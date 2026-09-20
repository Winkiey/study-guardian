/**
 * 设计令牌的守卫测试。
 *
 * 为什么需要它：颜色是**唯一一种改错了不会报错**的东西。
 * 把 --c-text-3 从 #5d6577 改成 #8f96a3，页面照样渲染、测试照样全绿，
 * 只是小字变得看不清了 —— 而且是在某些底色上才看不清，肉眼抽查很容易漏。
 * 所以这里把两件事钉成断言：
 *
 *   1. 对比度必须达标（按「它能落到的最差底色」算，不是按白底算）。
 *   2. 全站只有一个品牌色（不许再引入第二个色相做渐变）。
 *
 * 这个文件里的色值是从 app.css 里**解析出来的真实值**，不是抄一遍常量 ——
 * 抄常量的话，改了 CSS 而忘了改测试，两边就永远对不上了。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CSS = fs.readFileSync(path.join(root, 'src/web/public/app.css'), 'utf8');

// ============================================================
// 从 CSS 里把令牌抠出来
// ============================================================

/** 从 start 处的 `{` 开始，返回配对的花括号内部内容 */
function blockAt(src, braceIndex) {
  let depth = 0;
  for (let i = braceIndex; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(braceIndex + 1, i);
    }
  }
  throw new Error('花括号没配平');
}

function tokensIn(selector) {
  const at = CSS.indexOf(selector);
  assert.notEqual(at, -1, `app.css 里找不到选择器 ${selector}`);
  const brace = CSS.indexOf('{', at);
  const body = blockAt(CSS, brace);
  const out = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokensIn('\n:root {');
const darkByAttr = tokensIn(":root[data-theme='dark'] {");
const darkByMedia = tokensIn(":root:not([data-theme='light']) {");

// ============================================================
// 色值工具（真实 WCAG 公式）
// ============================================================

function parseColor(input) {
  const s = String(input).trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hexMatch) {
    const h = hexMatch[1].length === 3
      ? hexMatch[1].split('').map((c) => c + c).join('')
      : hexMatch[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`看不懂的颜色写法：${s}`);
}

/** 字符串或已解析对象都收，统一成 { r, g, b, a } */
function toRgba(x) {
  return typeof x === 'string' ? parseColor(x) : x;
}

/** 把半透明色叠到某个底色上，得到实际渲染出来的颜色 */
function over(color, base) {
  const c = toRgba(color);
  const b = toRgba(base);
  const mix = (x, y) => x * c.a + y * (1 - c.a);
  return { r: mix(c.r, b.r), g: mix(c.g, b.g), b: mix(c.b, b.b), a: 1 };
}

function luminance({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function ratio(fg, bg) {
  const [x, y] = [luminance(fg), luminance(bg)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** 文字色压在（可能半透明的）底色上时的对比度 */
function textOn(T, textToken, bgToken) {
  const base = parseColor(T[bgToken]).a < 1 ? over(T[bgToken], '#ffffff') : parseColor(T[bgToken]);
  const fg = over(T[textToken], base);
  return ratio(fg, base);
}

/** 半透明底色叠在另一个底色上，再压文字 */
function textOnSoft(T, textToken, softToken, underToken) {
  const under = parseColor(T[underToken]);
  const bg = over(T[softToken], under);
  return ratio(over(T[textToken], bg), bg);
}

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
const TEXTISH = ['text', 'text-2', 'text-3', 'primary', 'success', 'warn', 'danger'];
const normalize = (n) => `c-${n}`;

// ============================================================
// 1. 两套深色必须一致
// ============================================================

describe('深色模式的两份定义不许各写各的', () => {
  test('★ 跟随系统 与 手动切深色 用的是同一套色值', () => {
    // 这两块是分开维护的（一块在 @media 里，一块在 [data-theme='dark'] 里）。
    // 不一致的后果很隐蔽：从系统跟随切到手动深色，页面颜色会**变一下**，
    // 而两边单独看都正常。
    const keys = new Set([...Object.keys(darkByAttr), ...Object.keys(darkByMedia)]);
    const diff = [];
    for (const k of keys) {
      if (darkByAttr[k] !== darkByMedia[k]) {
        diff.push(`${k}：手动=${darkByAttr[k]} / 跟随系统=${darkByMedia[k]}`);
      }
    }
    assert.deepEqual(diff, [], `这两块深色定义不一致：\n${diff.join('\n')}`);
  });
});

// ============================================================
// 2. 每个用到的令牌都得有定义
// ============================================================

describe('令牌引用不许写错名字', () => {
  test('★ var(--c-xxx) 引用的令牌都定义过', () => {
    // 写错一个名字（--c-text3 少个横杠）不会报错，那一行只是**静默失效**：
    // 颜色回退成继承值，通常表现为「某处文字突然变黑/变透明」。
    //
    // 定义要从**整份文件**里收集，不能只看 :root ——
    // 像 --stat-accent 这种是组件自己就近定义的局部变量，只看 :root 会误报。
    const defined = new Set();
    for (const m of CSS.matchAll(/(^|[\s{;])(--[\w-]+)\s*:/g)) defined.add(m[2].slice(2));

    // 这些不在 CSS 里定义，而是由模板/JS 用内联 style 传进来的
    // （课程自定义色就是这条路：style="--dot-color:#3a63e8"）。
    // 白名单是显式列出来的，不是"凡是没有定义的就放过" ——
    // 那样这个断言就废了。加了新的内联变量，这里也要加一行。
    const FROM_TEMPLATE = new Set([
      'dot-color',    // app.js / dashboard.js / assignments.js / materials.js 的课程小圆点
      'chip-color',   // timetable.js 的课程胶囊
      'block-color',  // timetable.js 的课程方块（整块的底色由它算出来）
      'card-color',   // courses.js 的课程卡顶部色条
      'color',        // 各处通用的"这个元素的颜色"占位
      'size', 'delay', 'tx', 'ty', 'rot', // 动画参数（入场位移、旋转、错峰延迟）
    ]);

    const missing = new Set();
    for (const m of CSS.matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1].slice(2);
      if (defined.has(name) || FROM_TEMPLATE.has(name)) continue;
      missing.add(m[1]);
    }
    assert.deepEqual([...missing], [], `这些令牌被引用但没有定义：${[...missing].join('、')}`);
  });
});

// ============================================================
// 3. 对比度
// ============================================================

for (const [themeName, T] of [['浅色', light], ['深色', darkByAttr]]) {
  describe(`${themeName}模式的对比度`, () => {
    test('★ 正文/说明/三级文字/主色/状态色，压在任何一层底色上都 ≥4.5:1', () => {
      // 关键在「任何一层」：以前只对着白底算，结果三级文字在白底达标，
      // 落在灰面板上就不够了 —— 而它恰恰全用在最小的字上。
      const bad = [];
      for (const t of TEXTISH) {
        for (const s of SURFACES) {
          const r = textOn(T, normalize(t), normalize(s));
          if (r < 4.5) bad.push(`${t} on ${s} = ${r.toFixed(2)}`);
        }
      }
      assert.deepEqual(bad, [], `对比度不足：\n${bad.join('\n')}`);
    });

    test('★ 状态色压在自己的浅色底上（那层底又叠在最深面板上）也 ≥4.5:1', () => {
      // 徽标就是这个结构：文字色 + 自己 10% 透明的底。
      // 那层底再叠在灰面板上会变暗一点，是最差的一种组合。
      const bad = [];
      for (const name of ['success', 'warn', 'danger']) {
        const r = textOnSoft(T, normalize(name), normalize(`${name}-soft`), 'c-surface-3');
        if (r < 4.5) bad.push(`${name} on ${name}-soft/surface-3 = ${r.toFixed(2)}`);
      }
      assert.deepEqual(bad, [], `状态色压自己浅底时对比度不足：\n${bad.join('\n')}`);
    });

    test('★ 白字压在实心色底上 ≥4.5:1（按钮和徽标都这样用）', () => {
      const white = { r: 255, g: 255, b: 255, a: 1 };
      const bad = [];
      for (const name of ['primary-solid', 'primary-solid-dark', 'success-solid', 'warn-solid', 'danger-solid']) {
        const key = `c-${name}`;
        if (!T[key]) continue;
        const r = ratio(white, parseColor(T[key]));
        if (r < 4.5) bad.push(`${name} ${T[key]} + 白字 = ${r.toFixed(2)}`);
      }
      assert.deepEqual(bad, [], `白字压不住这些实心底：\n${bad.join('\n')}`);
    });

    test('主色当文字色够清楚（顺带说明它和实心底为什么必须分开）', () => {
      const worst = SURFACES
        .map((s) => textOn(T, 'c-primary', normalize(s)))
        .reduce((a, b) => Math.min(a, b));
      assert.ok(worst >= 4.5, `主色当文字时最差只有 ${worst.toFixed(2)}:1`);
    });
  });
}

describe('主色 / 实心底的拆分不能被合并', () => {
  test('★ --c-primary 和 --c-primary-solid 是两个不同的令牌', () => {
    // 合并成一个的后果：深色模式下主色是**亮**的（要能当文字看），
    // 拿它当按钮底压白字只有 2.71:1 —— 按钮上的字直接看不清。
    for (const [name, T] of [['浅色', light], ['深色', darkByAttr]]) {
      assert.ok(T['c-primary'] && T['c-primary-solid'],
        `${name}模式缺少 primary 或 primary-solid`);
    }
    assert.notEqual(darkByAttr['c-primary'], darkByAttr['c-primary-solid'],
      '深色模式下这两个值必须不同：主色要亮（当文字），实心底要深（压白字）');
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const r = ratio(white, parseColor(darkByAttr['c-primary']));
    assert.ok(r < 4.5, '如果深色主色本身就能压白字，这条注释和测试都该重写了');
  });
});

// ============================================================
// 4. 只有一个品牌色
// ============================================================

describe('全站只有一个品牌色', () => {
  test('★ 不存在第二个品牌色令牌（比如以前的 --c-accent）', () => {
    const banned = Object.keys(light).filter((k) => /accent|brand-2|secondary-color/.test(k));
    assert.deepEqual(banned, [], `又冒出来一个品牌色令牌：${banned.join('、')}`);
  });

  test('★ 没有「主色 → 另一个色相」的渐变', () => {
    // 以前有 9 处 linear-gradient(主色, 紫色)。两色相的渐变会让整站看起来
    // 像通用后台模板，而且按钮/头像/进度条各有一份，改都改不齐。
    // 这里允许渐变（同色相明度差是可以的），但**一次渐变里只能出现一个语义色**。
    const HUES = ['c-primary', 'c-primary-solid', 'c-success', 'c-warn', 'c-danger'];
    const bad = [];
    for (const m of CSS.matchAll(/(linear|radial|conic)-gradient\(([^;]*?)\)\s*[;,]/g)) {
      const body = m[2];
      const used = new Set();
      for (const v of body.matchAll(/var\((--[\w-]+)\)/g)) if (HUES.includes(v[1].slice(2))) used.add(v[1].slice(2));
      // color-mix 里也可能带语义色
      for (const v of body.matchAll(/color-mix\([^)]*?var\((--[\w-]+)\)/g)) {
        if (HUES.includes(v[1].slice(2))) used.add(v[1].slice(2));
      }
      if (used.size > 1) bad.push(`${m[1]}-gradient 里混了 ${[...used].join(' + ')}`);
    }
    assert.deepEqual(bad, [], `又出现了多色相渐变：\n${bad.join('\n')}`);
  });
});

// ============================================================
// 5. 动效与焦点
// ============================================================

describe('减少动态效果与焦点可见性', () => {
  test('★ 有一条全局的 prefers-reduced-motion 兜底（不是只管滚动）', () => {
    const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.notEqual(at, -1, '整份样式表里没有 prefers-reduced-motion');
    // 找到第一条全局兜底：必须同时约束 animation 和 transition
    const global = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .find((body) => /animation-duration/.test(body) && /transition-duration/.test(body)
        && /\*,\s*\*::before/.test(body));
    assert.ok(global, 'prefers-reduced-motion 只覆盖了个别组件，缺一条全局兜底');
    assert.match(global, /animation-iteration-count:\s*1/, '动画要限制成只播一次');
    assert.match(global, /scroll-behavior:\s*auto/, '平滑滚动也要关掉');
  });

  test('★ 去掉 outline 的地方都补了一个不透明的主色环', () => {
    // outline: none 之后如果只剩半透明柔光，键盘焦点就等于看不见了
    // （那层柔光对底色只有 1.4:1 左右，而要求是 3:1）。
    const stripped = [...CSS.matchAll(/outline:\s*none;([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(stripped.length > 0, '没有任何地方去掉 outline？那这条断言已经失效了');
    for (const body of stripped) {
      if (!/border-color:\s*var\(--c-primary\)/.test(body) && !/--c-primary\)/.test(body)) continue;
      assert.match(body, /0 0 0 1px var\(--c-primary\)/,
        '这里 outline: none 之后只给了半透明柔光，没有不透明的 1px 主色环');
    }
  });

  test('大括号配平（一段没闭合会静默吞掉后面所有规则）', () => {
    let depth = 0;
    for (const ch of CSS) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      assert.ok(depth >= 0, '出现了多余的 }');
    }
    assert.equal(depth, 0, '花括号没配平');
  });
});
