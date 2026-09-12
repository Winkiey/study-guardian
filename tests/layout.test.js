/**
 * 服务端渲染组件的单元测试。
 *
 * 目前只覆盖作业勾选框（layout.js 的 assignmentCheck）。
 * 这个组件存在的意义是「作业页和课程详情页共用一套」——之前两处各写一遍，
 * 结果课程页那个是个 <span role="button">，能聚焦、按回车却毫无反应。
 * 所以下面的断言重点就是：它必须是一个真的按钮、数据属性齐全、
 * 标题里的特殊字符不会撑破 HTML 属性。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// layout.js 会连带加载 config.js，它会创建 data 目录和密钥
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-layout-test-'));

let assignmentCheck;

before(async () => {
  ({ assignmentCheck } = await import('../src/web/layout.js'));
});

/**
 * 取出某个属性的值。
 *
 * 前面的 (?:^|\s) 不能省：只写 `title="` 的话
 * `data-check-title="..."` 里的 `title="` 会先被匹配到，
 * 于是取 title 永远得到空串。
 */
function attr(html, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

/**
 * 把所有 attr="value" 抠掉，看剩下的东西里还有没有引号。
 *
 * 只要还剩引号，就说明某个值跑出了属性范围（比如标题里的 `"` 没转义，
 * 把后面的属性挤成了标签内容）。这比逐条比对转义结果更能兜住漏网的写法。
 */
function leftoverQuotes(html) {
  return html.replace(/[a-zA-Z][\w:-]*\s*=\s*"[^"]*"/g, '').match(/"/g)?.length || 0;
}

describe('assignmentCheck 勾选框', () => {
  test('★ 未完成时是一个真的 <button>（键盘也能用）', () => {
    const html = assignmentCheck({ id: 7, status: 'todo', title: '高数作业' });
    assert.match(html, /<button[^>]*type="button"/);
    assert.ok(!html.includes('<span class="task__check"'), '不能再用冒充按钮的 span');
    assert.ok(!html.includes('role="button"'), '是真按钮就不需要 role');
  });

  test('★ 未完成时没有 is-done（否则一进页面就是绿的）', () => {
    const html = assignmentCheck({ id: 7, status: 'todo', title: '高数作业' });
    assert.ok(!html.includes('is-done'));
  });

  test('★ 已完成时带 is-done，打勾那一笔才会显示出来', () => {
    const html = assignmentCheck({ id: 7, status: 'done', title: '高数作业' });
    assert.match(html, /class="sg-check__box is-done"/);
  });

  test('交互需要的两个数据属性都在', () => {
    const html = assignmentCheck({ id: 42, status: 'doing', title: 'x' });
    assert.equal(attr(html, 'data-toggle-assignment'), '42');
    assert.equal(attr(html, 'data-status'), 'doing');
  });

  test('★ 带上了 pathLength（画勾动画全靠它，去掉就没动画了）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo' });
    assert.match(html, /pathLength="1"/);
  });

  test('★ 勾选框外层有定位锚点（确认条和粒子都挂在它上面）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo' });
    assert.match(html, /class="sg-check" data-check-anchor/);
  });

  test('★ 数字 id 也能正常渲染', () => {
    assert.equal(attr(assignmentCheck({ id: 0, status: 'todo' }), 'data-toggle-assignment'), '0');
    assert.equal(attr(assignmentCheck({ id: '999', status: 'todo' }), 'data-toggle-assignment'), '999');
  });
});

describe('assignmentCheck 的可访问性', () => {
  test('★ 读屏标签带上了作业名（一列作业里才分得清是哪一项）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: '第三章课后习题' });
    assert.equal(attr(html, 'aria-label'), '标记为已完成：第三章课后习题');
  });

  test('★ 已完成时读屏标签变成「标记为未完成」', () => {
    const html = assignmentCheck({ id: 1, status: 'done', title: '第三章课后习题' });
    assert.equal(attr(html, 'aria-label'), '标记为未完成：第三章课后习题');
  });

  test('没有标题时读屏标签退化成通用文案，不会留个空冒号', () => {
    const html = assignmentCheck({ id: 1, status: 'todo' });
    assert.equal(attr(html, 'aria-label'), '标记为已完成');
  });

  test('鼠标悬停的 title 说的是动作，不是状态', () => {
    assert.equal(attr(assignmentCheck({ id: 1, status: 'todo' }), 'title'), '标记为已完成');
    assert.equal(attr(assignmentCheck({ id: 1, status: 'done' }), 'title'), '标记为未完成');
  });

  test('SVG 对读屏隐藏（信息已经在按钮的 aria-label 里了）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo' });
    assert.match(html, /<svg[^>]*aria-hidden="true"/);
    assert.match(html, /<svg[^>]*focusable="false"/);
  });
});

describe('assignmentCheck 的转义', () => {
  test('★ 标题里的引号不会撑破属性（真实会遇到的：数学"分析"作业）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: '数学"分析"作业' });
    assert.equal(attr(html, 'data-check-title'), '数学&quot;分析&quot;作业');
    // 抠掉所有属性后不该还剩引号——剩了就说明有值跑出了属性范围
    assert.equal(leftoverQuotes(html), 0, '有引号漏到属性外面了');
    // 而且属性后面的那个属性还在原位（没被挤成标签内容）
    assert.match(html, /data-check-title="数学&quot;分析&quot;作业"\s+aria-label=/);
  });

  test('★ 标题里的尖括号不会变成标签', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: '<script>alert(1)</script>' });
    assert.ok(!html.includes('<script>'), '不能把标题当 HTML 渲染');
    assert.match(html, /&lt;script&gt;/);
    assert.equal(leftoverQuotes(html), 0);
  });

  test('标题里的 & 会转义（否则浏览器会把它当实体开头）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: 'A & B' });
    assert.match(html, /data-check-title="A &amp; B"/);
  });

  test('读屏标签同样会被转义', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: 'a"b' });
    assert.equal(attr(html, 'aria-label'), '标记为已完成：a&quot;b');
  });

  test('★ 单引号也转义（模板用的是双引号，但别留下隐患）', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: "it's" });
    assert.match(html, /&#39;/);
    assert.equal(leftoverQuotes(html), 0);
  });

  test('★ 换行和空格组成的标题不会破坏标记结构', () => {
    const html = assignmentCheck({ id: 1, status: 'todo', title: '  第一行\n第二行  ' });
    assert.equal(leftoverQuotes(html), 0);
    assert.equal(attr(html, 'data-check-title'), '  第一行\n第二行  ');
  });

  test('常规标题渲染出来结构是完好的', () => {
    const html = assignmentCheck({ id: 7, status: 'todo', title: '第三章课后习题 1-15 题' });
    assert.equal(leftoverQuotes(html), 0);
    assert.equal(attr(html, 'data-check-title'), '第三章课后习题 1-15 题');
    assert.equal(attr(html, 'data-toggle-assignment'), '7');
  });
});
