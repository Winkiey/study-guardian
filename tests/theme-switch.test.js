/**
 * 深浅色模式的入口。
 *
 * 这一组是补一个**用户报上来的问题**：「在哪里切换深浅色」——
 * 查下去发现手机上根本没有入口：
 *
 *   · 唯一的开关在侧栏底部，而手机上侧栏是 `display: none`（≤768px），
 *     所以手机上**没有任何地方能切**，只能跟着手机系统走。
 *   · 那个开关是「切换」不是「选择」：点过一次就把 'dark' / 'light'
 *     写进 localStorage 固定下来了，**再也回不到「跟随系统」**——
 *     想回去只能清浏览器数据，没人会想到这么干。
 *
 * 修法是设置页加一个「外观」分组，给三个明确选项。手机上进设置页是通的
 * （底部导航六项里有「设置」），所以这一个入口同时解决两件事。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const css = read('src/web/public/app.css');
const appJs = read('src/web/public/app.js');
const settingsJs = read('src/web/pages/settings.js');
const layoutJs = read('src/web/layout.js');

// ============================================================
// 入口本身
// ============================================================

describe('★ 深浅色要有两个入口（桌面 + 手机）', () => {
  test('★ 设置页有「外观」分组，里面三个选项都在', () => {
    // 「跟随系统」这一项是关键：没有它，用户一旦点过侧栏那个按钮，
    // 就被永久固定在深或浅了。
    for (const choice of ['system', 'light', 'dark']) {
      assert.match(settingsJs, new RegExp(`data-theme-choice="${choice}"`),
        `设置页缺少「${choice}」这个选项`);
    }
    assert.match(settingsJs, /id="appearance"/, '缺少外观分组的锚点 id');
  });

  test('★ 「外观」在设置页的目录里有一项（不然滚半天找不到）', () => {
    assert.match(settingsJs, /<a href="#appearance">/,
      '锚点导航里没有「外观」，用户只能一路往下滚');
  });

  test('★ 手机上够得着这个入口：底部导航里有「设置」', () => {
    // 手机上侧栏是 display:none，底部导航是唯一的入口。
    // 如果哪天有人为了"底栏只放 5 项"把设置去掉，外观就又没入口了。
    assert.match(layoutJs, /NAV_ITEMS\.map\(\(item\) => navLink\(item, active, stats, true\)\)/,
      '底部导航不是从 NAV_ITEMS 全量渲染的，得确认「设置」还在里面');
    assert.match(layoutJs, /key: 'settings'/);
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*?\.sidebar \{ display: none; \}/,
      '≤768px 时侧栏是隐藏的 —— 这正是必须另给入口的原因，这条断言是前提');
  });

  test('侧栏底部那个快捷开关保留（桌面上一步就能切）', () => {
    assert.match(layoutJs, /class="theme-toggle" data-theme-toggle/);
  });
});

// ============================================================
// 行为
// ============================================================

describe('★ 主题选择的行为', () => {
  test('★ 三个选项共用侧栏开关那一套逻辑，不是各写各的', () => {
    // 两份实现早晚会不一致（一个改深色另一个不跟着变）。
    assert.match(appJs, /querySelectorAll\('\[data-theme-choice\]'\)/,
      'initTheme 没有接管 [data-theme-choice]');
    assert.match(appJs, /for \(const btn of toggles\)[\s\S]{0,200}apply\(/,
      '侧栏按钮没有走 apply()');
    assert.match(appJs, /for \(const btn of choices\)[\s\S]{0,200}apply\(btn\.dataset\.themeChoice\)/,
      '外观选项没有走 apply()');
  });

  test('★ 选「跟随系统」要把存的键删掉，不能存成字符串 "system"', () => {
    // 页面顶部那段内联脚本是靠「值不是 dark/light」来判定跟随系统的。
    // 存一个 'system' 进去，判定恰好也成立 —— 但如果哪天内联脚本改成
    // 「必须等于 system」，两处就对不上了。删键是唯一没有歧义的写法。
    assert.match(appJs, /next === 'system'[\s\S]{0,160}localStorage\.removeItem\('sg-theme'\)/,
      '选「跟随系统」没有删掉 sg-theme');
    assert.ok(!/localStorage\.setItem\('sg-theme',\s*'system'\)/.test(appJs),
      '把 "system" 当值存进去了，内联脚本和那边会各判各的');
  });

  test('★ 内联脚本的判定逻辑和 app.js 对得上', () => {
    // 内联脚本负责"第一帧之前就定好颜色"，避免深色模式下闪一下白。
    // 它只认 dark/light 两个值 + 其余情况跟随系统 —— 这条断言把这份约定钉住。
    assert.match(layoutJs, /localStorage\.getItem\('sg-theme'\)/);
    assert.match(layoutJs, /t === 'dark' \|\| t === 'light'/);
    assert.match(layoutJs, /prefers-color-scheme: dark/);
  });

  test('★ 选了「跟随系统」时，系统换主题网页要跟着变', () => {
    // 不监听的话，用户在手机设置里切了深色，网页纹丝不动 ——
    // 看起来像"这个选项没作用"，于是又跑去点浅色/深色，反而固定住了。
    assert.match(appJs, /addEventListener\('change', onSystemChange\)/,
      '没有监听 prefers-color-scheme 的变化');
    assert.match(appJs, /if \(preference\(\) === 'system'\) sync\(\)/,
      '系统主题变化时没有先确认用户选的是「跟随系统」—— 那样会覆盖用户的手动选择');
  });

  test('★ 手机上没有「点不到的开关」：侧栏里的按钮在窄屏不该是唯一的', () => {
    // 这条是防回归：以前 document.querySelector('[data-theme-toggle]')
    // 只找一个按钮，而且 initTheme 在找不到时直接 return ——
    // 那么在没有侧栏的页面上（登录页），外观选项就完全不工作。
    assert.match(appJs, /querySelectorAll\('\[data-theme-toggle\]'\)/,
      '还在只找第一个开关，页面没有侧栏时整套逻辑会整个 return 掉');
    const initTheme = appJs.slice(appJs.indexOf('function initTheme'));
    const guard = initTheme.slice(0, initTheme.indexOf('const systemQuery'));
    assert.match(guard, /if \(!toggles\.length && !choices\.length\) return;/,
      '早退条件必须是「两种入口都没有」，不能只看开关');
  });
});

// ============================================================
// 样式
// ============================================================

describe('★ 外观选项的样式', () => {
  test('★ 分段控件用 button 时要去掉浏览器默认边框和字体', () => {
    // `.filter-tab` 原来是给 <a> 写的。button 自带边框、背景和另一套字体，
    // 不清掉的话三个选项会顶着灰边、字比旁边大一号。
    const at = css.indexOf('button.filter-tab {');
    assert.notEqual(at, -1, '没有给 button.filter-tab 收口');
    const body = css.slice(at, css.indexOf('}', at));
    assert.match(body, /border:\s*0/, 'button 的默认边框没去掉');
    assert.match(body, /background:\s*transparent/);
    assert.match(body, /font:\s*inherit/);
    // font: inherit 会把字号也重置掉，必须补回来
    assert.match(body, /font-size:\s*13px/,
      'font: inherit 之后没把字号补回来 —— 会比旁边那句大一号');
  });

  test('外观选项的点击目标在手机上够大', () => {
    // 复用 .filter-tab，它在移动端那条媒体查询里已经被放大过了。
    // 哪天有人给外观另写一套样式，这条会提醒他别忘了触控尺寸。
    assert.match(css, /@media[\s\S]*?\.filter-tab \{ padding: 9px 16px; \}/,
      '.filter-tab 在手机上应该被放大过（外观选项复用了它）');
  });
});
