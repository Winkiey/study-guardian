/**
 * 课表上的「当前时间线」。
 *
 * 需求是设计方案里的一句话：「当前时间使用细线 + 小圆点，不使用大面积红色」。
 * 做的时候撞上一个具体问题：网格行高是 `minmax(42px, auto)` ——
 * **由内容决定，和这一节有多长无关**。一节 45 分钟的课和一段两小时的课，
 * 格子一样高。所以「现在上到这一节的百分之多少」在服务端算不出像素位置，
 * 只能在浏览器里量出那一行的实际高度再放。
 *
 * 于是拆成两半：
 *   · nowLineOffset()  —— 纯函数，算「线该在这一行的哪个位置」。这里能真测。
 *   · initNowLine()    —— 量高度、设 --now-offset、每分钟跟一次。这半需要浏览器，
 *                         所以只断言结构（有没有被调用、有没有定时器）。
 *
 * 位置对不对最终还得人看一眼 —— 我在测试里把这条实话标出来了，
 * 免得以后有人以为「测试全绿 = 位置肯定准」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appRaw = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');
const cssRaw = fs.readFileSync(path.join(root, 'src/web/public/app.css'), 'utf8');
const timetableRaw = fs.readFileSync(path.join(root, 'src/web/pages/timetable.js'), 'utf8');
// 匹配前先去注释（这个坑踩过好几次）
const app = appRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const timetable = timetableRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fnSource(name) {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(app);
  assert.ok(m, `app.js 里应该有 ${name}()`);
  return m[0];
}
function loadFn(name, deps = {}) {
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${fnSource(name)}\nreturn ${name};`)(...names.map((n) => deps[n]));
}

// nowLineOffset 内部要用 hmToMinutes 解析 'HH:MM'，所以两个都得抽出来 ——
// 只注入外层那个的话，一调用就 ReferenceError（这就是第一版九个用例全红的原因）。
const nowLineOffset = loadFn('nowLineOffset', { hmToMinutes: loadFn('hmToMinutes') });

// ============================================================
// 位置算法
// ============================================================

describe('★ 当前时间线该画在哪里', () => {
  const row = (startHm, endHm, nowHm, rowHeight = 100) =>
    nowLineOffset({ rowHeight, startHm, endHm, nowHm });

  test('★ 课刚开始时在最上面（偏移 0）', () => {
    assert.deepEqual(row('08:00', '08:45', '08:00'), { offset: 0, fraction: 0 });
  });

  test('★ 课过了一半时在中间', () => {
    const r = row('08:00', '08:45', '08:22');
    assert.ok(Math.abs(r.fraction - 0.489) < 0.02, `fraction=${r.fraction}`);
    assert.equal(r.offset, 49);
  });

  test('★ 按**行高的比例**算，不是按时长算', () => {
    // 一行 200px，过了四分之一 → 50px。
    // 这里正是「服务端算不了」的原因：行高由内容决定，跟时长无关。
    assert.equal(row('08:00', '10:00', '08:30', 200).offset, 50);
  });

  test('★ 刚好到下课时贴在最下面（不越界）', () => {
    const r = row('08:00', '08:45', '08:45');
    assert.equal(r.offset, 100, '越界的话线会画到下一行里去');
    assert.equal(r.fraction, 1);
  });

  test('★ 现在不在这一行里 → 不画（返回 null）', () => {
    // 页面开了很久，时间已经走过这一行了：宁可不显示，
    // 也不要把它钉在边上装作还准
    assert.equal(row('08:00', '08:45', '07:59'), null);
    assert.equal(row('08:00', '08:45', '08:46'), null);
  });

  test('坏数据不画，也别抛异常', () => {
    assert.equal(row('', '08:45', '08:30'), null);
    assert.equal(row('08:00', '', '08:30'), null);
    assert.equal(row('08:00', '08:45', ''), null);
    assert.equal(row('abc', '08:45', '08:30'), null);
    assert.equal(row('25:00', '26:00', '25:30'), null, '25 点不是合法时间');
    // 起止一样 → 会除零
    assert.equal(row('08:00', '08:00', '08:00'), null);
    // 起止反了
    assert.equal(row('09:00', '08:00', '08:30'), null);
  });

  test('★ 一分钟一分钟扫过去，线的位置始终落在这一行里面', () => {
    // 这条是**不变量**断言，不是某一组输入。
    // 之前这里写的是「行高 0 或负数时不会算出负偏移」，反向验证时发现
    // 它**测不出任何东西**：0 乘任何比例都是 0，加不加夹边界断言都绿 ——
    // 而那个夹边界其实是永远执行不到的死代码，已经删掉了。
    // 真正保证"线不会跑到行外面"的是 nowLineOffset 里那两条 return，
    // 所以这里逐分钟扫一整行，任何一分钟越界都会红。
    const MS = (hm) => {
      const [h, m] = hm.split(':').map(Number);
      return h * 60 + m;
    };
    const label = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    for (const height of [0, 1, 42, 137]) {
      for (let m = MS('08:00'); m <= MS('09:30'); m += 1) {
        const nowHm = label(m);
        const r = nowLineOffset({ rowHeight: height, startHm: '08:00', endHm: '09:30', nowHm });
        assert.ok(r, `第 ${nowHm} 分钟应该取到一个位置`);
        assert.ok(r.offset >= 0 && r.offset <= height,
          `行高 ${height}、现在 ${nowHm} → 偏移 ${r.offset}，跑到行外面去了`);
        assert.ok(r.fraction >= 0 && r.fraction <= 1,
          `行高 ${height}、现在 ${nowHm} → 比例 ${r.fraction} 越界`);
      }
    }
  });

  test('★ 白天任何一分钟都至少落在某一行里（线不会凭空消失）', () => {
    // 上一版这里断言的是「恰好命中 1 行」，在 08:45 那条边界上红了 ——
    // 查下去发现是两个函数的口径不同，而且**这是对的**：
    //   · 服务端挑行用的是半开区间 `start <= now < end`，所以页面上只画一条线；
    //   · 客户端这个函数问的是「现在算不算在这一行里」，两端都算
    //     （[start, end] 闭区间）。
    // 闭区间在这里更合适：08:40 打开页面、08:45 正好下课，线应该停在
    // 这一行的最下面，而不是掐着秒消失。
    // 所以真正该守的性质是「一天里没有空档」，不是「恰好一行」。
    const rows = [['08:00', '08:45'], ['08:45', '09:30'], ['09:30', '10:15']];
    for (let m = 8 * 60; m <= 10 * 60 + 15; m += 1) {
      const nowHm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const hits = rows.filter(([s, e]) => nowLineOffset({
        rowHeight: 100, startHm: s, endHm: e, nowHm,
      }));
      assert.ok(hits.length >= 1, `${nowHm} 一行都没命中 —— 线会在这里凭空消失`);
    }
  });

  test('★ 边界那一刻算在下一行的开头（和服务端的半开区间对得上）', () => {
    // 服务端挑行用 `start <= now < end`：08:45 属于 08:45-09:30 那一行。
    // 前端拿到那一行之后算出来的比例必须是 0（贴在这一行最上面），
    // 这样两条线的位置才是连续的，不会在边界上跳一下。
    const r = nowLineOffset({ rowHeight: 100, startHm: '08:45', endHm: '09:30', nowHm: '08:45' });
    assert.equal(r.offset, 0, '边界那一刻应该贴在下一行最上面');
  });

  test('跨零点附近的时间（23:xx）能正常算', () => {
    const r = row('23:00', '23:59', '23:30');
    assert.ok(r && r.offset > 40, `offset=${r && r.offset}`);
  });

  test('一位数的小时也认（8:00 这种写法）', () => {
    assert.deepEqual(row('8:00', '8:45', '8:00'), { offset: 0, fraction: 0 });
  });
});

// ============================================================
// 渲染与服务端的选择
// ============================================================

describe('★ 只在「有意义」的时候才画那条线', () => {
  test('★ 只画在今天那一列', () => {
    assert.match(timetable, /days\.findIndex\(\(d\) => d\.date === today\)/,
      '没有先确认今天在不在这一周里 —— 今天不在这一周时不该画');
    assert.match(timetable, /if \(todayColumn === -1\) return ''/);
  });

  test('★ 只画在"现在确实落在里面"的那一行', () => {
    assert.match(timetable, /r\.start <= currentHm && currentHm < r\.end/,
      '没找到当前所在的行时不该画 —— 深夜打开课表会画在莫名其妙的行上');
    assert.match(timetable, /if \(rowIndex === -1\) return ''/);
  });

  test('★ 把起止时间通过 data 属性带给前端（前端要用它算位置）', () => {
    assert.match(timetable, /data-start="\$\{escapeHtml\(row\.start\)\}"/);
    assert.match(timetable, /data-end="\$\{escapeHtml\(row\.end\)\}"/);
  });

  test('★ 时间线不挡点击（它盖在课程块上面）', () => {
    const at = css.indexOf('.now-line {');
    assert.notEqual(at, -1, '样式表里没有 .now-line');
    const body = css.slice(at, css.indexOf('}', at));
    assert.match(body, /pointer-events:\s*none/,
      '★ 不设 none 的话，压在线下面的课程就点不开了');
  });

  test('★ 是细线 + 小圆点，不是大面积高亮', () => {
    // 设计方案原话：「当前时间使用细线 + 小圆点，不使用大面积红色」
    const before = css.slice(css.indexOf('.now-line {'), css.indexOf('.now-line::after'));
    assert.match(before, /border-top:\s*1\.5px solid var\(--c-danger\)/,
      '应该是 1.5px 的细线');
    assert.match(css, /\.now-line::after\s*\{[^}]*border-radius:\s*50%/,
      '左端要有个小圆点');
    assert.ok(!/\.now-line\s*\{[^}]*background:\s*var\(--c-danger\)/.test(css),
      '整块填红就违反「不使用大面积红色」了');
  });

  test('★ 那条线本身不撑高表格行', () => {
    // 它是网格子元素、占满整行；里面没有内容，所以不该把行撑大
    const body = css.slice(css.indexOf('.now-line {'), css.indexOf('}', css.indexOf('.now-line {')));
    assert.match(body, /align-self:\s*stretch/);
    assert.ok(!/min-height/.test(body), '写了 min-height 就会把行撑高');
  });
});

describe('★ 前端那一半（需要浏览器，只能守结构）', () => {
  test('★ 被 boot() 调用了（不然这条线永远停在服务端算的初始位置）', () => {
    const bootBody = /function boot\(\)\s*\{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
    assert.match(bootBody, /initNowLine\(\)/, 'boot() 里没有调用 initNowLine');
  });

  test('★ 每分钟跟一次，而且切回标签页时会补一次', () => {
    const src = fnSource('initNowLine');
    assert.match(src, /setInterval\(place,\s*60_000\)/, '不跟时间走的话，线会一直停在打开页面那一刻');
    assert.match(src, /visibilitychange/,
      '后台标签页里定时器会被浏览器降频，切回来要补一次');
  });

  test('★ 时间走出这一行时把线藏起来，而不是钉在边上', () => {
    const src = fnSource('initNowLine');
    assert.match(src, /el\.hidden = true/);
    assert.match(src, /el\.hidden = false/);
  });

  test('★ 位置写成 CSS 变量 --now-offset（样式里就是这么读的）', () => {
    assert.match(fnSource('initNowLine'), /setProperty\('--now-offset'/);
    assert.match(css, /top:\s*var\(--now-offset/);
  });

  test('行高是现量的，不是写死的常量', () => {
    assert.match(fnSource('initNowLine'), /getBoundingClientRect/,
      '★ 行高必须实测 —— 写死一个数字的话，换个字号/换个屏幕就全错了');
  });
});
