/**
 * 手机上的可读性 —— 文字对比度 + 登录页的独立布局。
 *
 * 起因是外部审计指出三级文字（`--c-text-3`）太浅：浅色下对白底 3.34:1，
 * 低于普通文字要求的 4.5:1。核算之后发现比报告说的还差一点，因为它全用在
 * **最小**的字上（手机底部导航 10.5px、课表里的教室 11px），而那些位置
 * 往往不是压在白底上，而是压在浅灰面板上 —— 报告只按白底算过。
 *
 * 所以这一组测试不用「字符串等于某个色号」那种写法，
 * 而是**按 WCAG 的公式，拿样式表里真实的令牌值算一遍**。
 * 这样下次有人调色，只要算出来不达标就会红，不管他改成什么值。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'src/web/public/app.css'), 'utf8');
// 匹配前去掉注释：色值上方那些注释里也写着色号和数字，不去掉会算到注释上
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

// ============================================================
// WCAG 2.1 相对亮度与对比度
// ============================================================

const channel = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** 支持 #rgb / #rrggbb */
function luminance(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  assert.equal(h.length, 6, `认不出的颜色值：${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ============================================================
// 从样式表里取出各个「主题块」的令牌
// ============================================================

/** 取出所有定义了 --c-text-3 的块（浅色 :root + 两个深色块） */
function tokenBlocks() {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*--c-text-3:[^{}]*)\}/g;
  let m = re.exec(cssCode);
  while (m) {
    const body = m[2];
    const token = (name) => {
      const hit = new RegExp(`(^|[;\\s])${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`).exec(body);
      return hit ? hit[2] : null;
    };
    blocks.push({
      selector: m[1].trim().split('\n').pop().trim(),
      body,
      token,
      text3: token('--c-text-3'),
      text2: token('--c-text-2'),
      surfaces: {
        '--c-bg': token('--c-bg'),
        '--c-surface': token('--c-surface'),
        '--c-surface-2': token('--c-surface-2'),
        '--c-surface-3': token('--c-surface-3'),
      },
    });
    m = re.exec(cssCode);
  }
  return blocks;
}

const blocks = tokenBlocks();

describe('★ 三级文字的对比度', () => {
  test('样式表里能找到所有主题块（前提）', () => {
    assert.ok(blocks.length >= 3,
      `预期至少 3 个块（浅色 + 两个深色），实际 ${blocks.length}：${blocks.map((b) => b.selector).join(' / ')}`);
    for (const b of blocks) {
      assert.ok(b.text3, `${b.selector} 里应该有 --c-text-3`);
      assert.ok(b.text2, `${b.selector} 里应该有 --c-text-2`);
      for (const [name, value] of Object.entries(b.surfaces)) {
        assert.ok(value, `${b.selector} 里缺少 ${name}`);
      }
    }
  });

  test('★ 每一层底色上都要过 4.5:1（不是只算白底）', () => {
    // ⚠️ 关键在于「每一层」：底色和文字越接近，对比度越低。
    //    浅色模式下最深的一层是 --c-surface-3，深色模式下最亮的一层也是它 ——
    //    所以两个方向都要按「最不利的那一层」算。
    //    审计报告只按白底算过一次，得出的 3.34:1 其实比真实情况还好一点：
    //    压在浅灰面板上时是 2.99:1。
    for (const b of blocks) {
      for (const [name, surface] of Object.entries(b.surfaces)) {
        const ratio = contrast(b.text3, surface);
        assert.ok(ratio >= 4.5,
          `${b.selector}：--c-text-3(${b.text3}) 在 ${name}(${surface}) 上只有 ${ratio.toFixed(2)}:1，低于 4.5:1`);
      }
    }
  });

  test('★ 三级文字仍要比二级文字「淡」（别为了达标抹平层次）', () => {
    // 达标不能以牺牲层次为代价：三级色用在日期、提示、地点这些地方，
    // 它的作用就是「在场但不抢戏」。判据不用「谁更亮/更暗」——
    // 那个方向在浅色和深色下正好相反，很容易写反（第一版就写反了，测试自己抓出来了）。
    // 真正的不变量是：**三级色对底色的对比度必须低于二级色**。
    for (const b of blocks) {
      const bg = b.surfaces['--c-bg'];
      const c3 = contrast(b.text3, bg);
      const c2 = contrast(b.text2, bg);
      assert.ok(c3 < c2,
        `${b.selector}：三级 ${b.text3} 对底色 ${c3.toFixed(2)}:1 应该低于二级 ${b.text2} 的 ${c2.toFixed(2)}:1，否则三级就白分了`);
    }
  });
});

// ============================================================
// 登录页的独立布局
// ============================================================

describe('★ 登录页不套站内导航', () => {
  test('★ bare 模式把主体内边距去掉、高度交给 auth-shell', () => {
    // 这一条修的是「内容很短却必然出现滚动条」：
    // .main 上下有 40/96px，.auth-shell 又写 min-height:100vh，
    // 两个叠起来文档高度至少是 100vh + 136px。
    const ruleFor = (selector) => {
      const at = cssCode.indexOf(`${selector} {`);
      assert.ok(at > -1, `样式里应该有 ${selector}`);
      return cssCode.slice(at, cssCode.indexOf('}', at));
    };

    assert.match(ruleFor('.app-shell--bare .main'), /padding:\s*0/,
      '★ bare 页面的 .main 必须没有内边距，否则那条多余的滚动条还在');
    const authShell = ruleFor('.app-shell--bare .auth-shell');
    assert.match(authShell, /min-height:\s*100dvh/,
      '★ 用 dvh：手机上地址栏收起/展开时 vh 不变，会多留或少留一条');
    assert.match(authShell, /min-height:\s*100vh/, '同时留一行 vh 作为老浏览器兜底');
  });

  test('★ 浮动主题开关要够大（手指点得到）', () => {
    const at = cssCode.indexOf('.theme-toggle--float {');
    assert.ok(at > -1, '应该有浮动主题开关的样式');
    const body = cssCode.slice(at, cssCode.indexOf('}', at));
    const w = Number(/width:\s*(\d+)px/.exec(body)?.[1]);
    const h = Number(/height:\s*(\d+)px/.exec(body)?.[1]);
    assert.ok(w >= 44 && h >= 44, `触控目标应该 ≥44×44，实际 ${w}×${h}`);
    assert.match(body, /position:\s*fixed/, '要浮在右上角，不能跟着页面滚');
  });

  test('★ 登录/注册页真的走 bare 骨架（渲染出来看，不是只看标志位）', async () => {
    // 上面两条查的是样式，这条查的是**渲染结果** ——
    // 只查样式的话，哪天 bare 传丢了下边两条照样绿（A/B 时就是这么假通过的）。
    const { loginPage } = await import('../src/web/pages/settings.js');
    const { renderPage } = await import('../src/web/layout.js');

    for (const mode of ['login', 'register']) {
      const page = loginPage({ mode, registerOpen: true, inviteRequired: false });
      assert.equal(page.bare, true, `${mode} 页应该标成 bare`);

      const html = renderPage({ ...page, user: null, stats: {} });
      assert.ok(!html.includes('class="sidebar"'), `${mode} 页不该有侧边栏`);
      assert.ok(!html.includes('class="tabbar"'), `${mode} 页不该有底部导航`);
      assert.ok(html.includes('app-shell--bare'), `${mode} 页应该用 bare 骨架`);
      assert.ok(html.includes('theme-toggle--float'), `${mode} 页应该有浮动的深色模式开关`);
      assert.ok(html.includes('data-theme-toggle'), '深色模式开关要能被 initTheme 找到');
      // 功能不能被顺手删掉
      assert.ok(html.includes('id="tab-login"') && html.includes('id="tab-register"'),
        '登录/注册两个 Tab 都还得在');
    }
  });

  test('登录后的页面仍然有导航（别把 bare 传染给所有页面）', async () => {
    const { renderPage } = await import('../src/web/layout.js');
    const html = renderPage({ title: '总览', active: 'dashboard', body: 'x', user: { username: 'u' }, stats: {} });
    assert.ok(html.includes('class="sidebar"'), '正常页面必须有侧边栏');
    assert.ok(html.includes('class="tabbar"'), '正常页面必须有底部导航');
    assert.ok(!html.includes('app-shell--bare'), '正常页面不该是 bare');
    assert.ok(!html.includes('theme-toggle--float'), '正常页面不该多出一个浮动开关');
  });
});
