/**
 * 表单错误要指出**具体是哪个字段**。
 *
 * 以前填错了只有两条路：浏览器自带的气泡（样式不可控、点到别处就没了），
 * 或者页面右上角一个 toast。toast 的问题是**不说是哪个框** ——
 * 一个表单七八个字段，用户得自己一个个猜。
 *
 * 现在的做法：错误挂在出错的那个字段正下方，input 上打 aria-invalid
 * 和 aria-describedby（读屏会念出错误内容）。
 *
 * ⚠️ 这里测的是抽出来的**纯函数**，不是 grep 源码。
 *    grep 挡不住「往函数开头插一句 return null」—— 字符串都还在，断言照样绿。
 *    这个坑在 modal-and-touch.test.js 里踩过一次，所以那边也是这么办的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appRaw = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');
const cssRaw = fs.readFileSync(path.join(root, 'src/web/public/app.css'), 'utf8');
// 匹配前先去注释：下面这些函数上方的注释里就有同样的词，
// 不去掉的话正则会命中注释（这个坑踩过好几次）
const app = appRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

function fnSource(name) {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(app);
  assert.ok(m, `app.js 里应该有 ${name}()`);
  return m[0];
}

/** 把纯函数抠出来，在假对象上真跑一遍 */
function loadFn(name, deps = {}) {
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${fnSource(name)}\nreturn ${name};`)(...names.map((n) => deps[n]));
}

/** 假的输入框：只实现 invalidReason 真正读的那几个东西 */
function fakeInput({ value = '', attrs = {}, type = 'text' } = {}) {
  return {
    value,
    type,
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
  };
}

const invalidReason = loadFn('invalidReason');

// ============================================================
// invalidReason：这个框到底哪里不对
// ============================================================

describe('★ 判断一个字段为什么不合法', () => {
  test('★ 必填为空时说「请填写 X」', () => {
    const r = invalidReason(fakeInput({ value: '', attrs: { required: '' } }), '作业标题');
    assert.equal(r, '请填写作业标题');
  });

  test('★ 只有空格也算没填（不能因为打了个空格就放过去）', () => {
    assert.equal(invalidReason(fakeInput({ value: '   ', attrs: { required: '' } }), '课程名'),
      '请填写课程名');
  });

  test('★ 非必填的空框不报错（不能对着空框喊「格式不对」）', () => {
    assert.equal(invalidReason(fakeInput({ value: '' }), '教师'), '');
    assert.equal(invalidReason(fakeInput({ value: '  ' }), '教师'), '');
  });

  test('★ 数字框填了非数字', () => {
    assert.equal(
      invalidReason(fakeInput({ value: 'abc', type: 'number', attrs: { type: 'number' } }), '学分'),
      '学分要填数字',
    );
  });

  test('★ 数字超出 min / max 范围', () => {
    const tooBig = fakeInput({ value: '99', type: 'number', attrs: { type: 'number', max: 30 } });
    assert.equal(invalidReason(tooBig, '学分'), '学分不能大于 30');
    const tooSmall = fakeInput({ value: '0', type: 'number', attrs: { type: 'number', min: 1 } });
    assert.equal(invalidReason(tooSmall, '节次'), '节次不能小于 1');
  });

  test('★ 数字在范围内就没事', () => {
    const ok = fakeInput({ value: '3.5', type: 'number', attrs: { type: 'number', min: 0, max: 30 } });
    assert.equal(invalidReason(ok, '学分'), '');
  });

  test('★ 太短时说清要几位', () => {
    const short = fakeInput({ value: 'abc', attrs: { minlength: 8, required: '' } });
    assert.equal(invalidReason(short, '密码'), '密码至少 8 位');
  });

  test('★ 中文按「一个字算一位」（和 HTML minlength 的口径一致）', () => {
    // 6 个汉字 = 6 位，不该被当成 18 位（按字节算就会这样）
    const pwd = fakeInput({ value: '一二三四五六', attrs: { minlength: 8 } });
    assert.equal(invalidReason(pwd, '密码'), '密码至少 8 位');
    const ok = fakeInput({ value: '一二三四五六七八', attrs: { minlength: 8 } });
    assert.equal(invalidReason(ok, '密码'), '');
  });

  test('★ pattern 不匹配时说格式不对', () => {
    const bad = fakeInput({ value: '1-16-abc', attrs: { pattern: '[0-9,\\-]+' } });
    assert.equal(invalidReason(bad, '周次'), '周次格式不对');
    const good = fakeInput({ value: '1-16', attrs: { pattern: '[0-9,\\-]+' } });
    assert.equal(invalidReason(good, '周次'), '');
  });

  test('pattern 里写了非法正则时不能把整个表单带崩', () => {
    const weird = fakeInput({ value: 'x', attrs: { pattern: '[unclosed' } });
    assert.equal(invalidReason(weird, '某字段'), '',
      '属性里的正则写错了不该抛异常 —— 那会让提交按钮彻底没反应');
  });

  test('必填的优先级高于其他规则（空框先说「请填写」）', () => {
    // 空框同时违反 required 和 minlength 时，说「请填写」比说「至少 8 位」更有用
    const empty = fakeInput({ value: '', attrs: { required: '', minlength: 8 } });
    assert.equal(invalidReason(empty, '密码'), '请填写密码');
  });

  test('没给 label 时兜底成「这一项」', () => {
    assert.equal(invalidReason(fakeInput({ value: '', attrs: { required: '' } })), '请填写这一项');
  });
});

// ============================================================
// pickErrorField：服务端那句话是在说哪个字段
// ============================================================

const pickErrorField = loadFn('pickErrorField', { SERVER_ERROR_FIELDS: loadServerRules() });

function loadServerRules() {
  // 规则表是个数组常量，不是函数，单独抠出来
  const m = /const SERVER_ERROR_FIELDS = \[([\s\S]*?)\n\];/.exec(app);
  assert.ok(m, 'app.js 里应该有 SERVER_ERROR_FIELDS');
  // eslint-disable-next-line no-new-func
  return new Function(`return [${m[1]}];`)();
}

describe('★ 把服务端错误挂到对应字段', () => {
  const names = ['title', 'dueAt', 'courseId', 'name', 'credits', 'hours', 'key', 'currentPassword', 'newPassword', 'startDate', 'weekCount'];

  test('★ 「作业标题不能为空」→ title', () => {
    assert.equal(pickErrorField('作业标题不能为空', names), 'title');
  });

  test('★ 「当前密码不正确」→ currentPassword', () => {
    assert.equal(pickErrorField('当前密码不正确', names), 'currentPassword');
  });

  test('★ 「推送 Key 不对」→ key', () => {
    assert.equal(pickErrorField('推送 Key 不对。请打开 Bark App…', names), 'key');
  });

  test('★ 「学分必须是数字」→ credits', () => {
    assert.equal(pickErrorField('学分必须是数字', names), 'credits');
  });

  test('★ 一句话同时提到两个字段时不硬指（命中多个 → null）', () => {
    // 指错比不指更糟：用户会盯着一个没问题的框改半天
    assert.equal(pickErrorField('学分和学时都要填数字', names), null);
  });

  test('★ 字段不在这个表单里就不认', () => {
    // 消息说的是学分，但这个表单没有 credits 这一格
    assert.equal(pickErrorField('学分必须是数字', ['title', 'dueAt']), null);
  });

  test('★ 认不出来的一律返回 null（调用方退回 toast）', () => {
    assert.equal(pickErrorField('服务器内部错误', names), null);
    assert.equal(pickErrorField('', names), null);
    assert.equal(pickErrorField(null, names), null);
  });

  test('★ 关键词要够具体：「课程」单独出现不能指到 courseId', () => {
    // 这句里同时有「截止时间」和「课程」，只该认截止时间那一个
    assert.equal(pickErrorField('截止时间不能早于课程开始', names), 'dueAt');
  });
});

// ============================================================
// DOM 那部分 + 样式
// ============================================================

describe('★ 字段错误的呈现', () => {
  test('★ 有 .field__error 的样式，用危险色', () => {
    const at = css.indexOf('.field__error {');
    assert.notEqual(at, -1, '样式表里没有 .field__error');
    const body = css.slice(at, css.indexOf('}', at));
    assert.match(body, /color:\s*var\(--c-danger\)/,
      '错误文字要用危险色 —— 它压在两种底色上都过 4.5:1（有专门断言守着）');
    assert.match(body, /display:\s*flex/, '要和图标排在一行');
  });

  test('★ aria-invalid 的输入框边框换成危险色', () => {
    assert.match(css, /\.input\[aria-invalid='true'\]\s*\{[^}]*border-color:\s*var\(--c-danger\)/,
      '出错的框没有视觉标记，用户还是得自己找');
  });

  test('★ 不靠颜色单独表达（文案 + 图标一起上）', () => {
    // 色盲用户看不出红色边框，但看得见文字和图标
    const src = fnSource('setFieldError');
    assert.match(src, /icon\('alert'/, '错误框里应该带一个警示图标');
    assert.match(src, /createTextNode\(message\)/, '错误文字要真的写进去');
  });

  test('★ 错误文字用 textContent 塞，不拼 innerHTML', () => {
    // 错误文案里会夹用户输入（比如课程名、密码提示里的原话），
    // 拼字符串早晚会漏一个转义 —— 那就是一个 XSS 口子。
    const src = fnSource('setFieldError');
    assert.ok(!/innerHTML\s*=\s*`[^`]*\$\{message\}/.test(src),
      '★ 把 message 拼进 innerHTML 了，这是注入风险');
    assert.match(src, /createTextNode\(message\)/);
  });

  test('★ 设置 aria-invalid 和 aria-describedby', () => {
    const src = fnSource('setFieldError');
    assert.match(src, /setAttribute\('aria-invalid', 'true'\)/,
      '读屏不会知道这个框是无效的');
    // ⚠️ 必须断言**写入**那一句，不能只 grep `aria-describedby` 这个词：
    // 上面读取属性那句（getAttribute('aria-describedby')）里也有这个词，
    // 于是把 setAttribute 那句删掉之后断言照样绿 —— A/B 时就是这么假通过的。
    assert.match(src, /setAttribute\('aria-describedby',/,
      '读屏拿不到错误内容，只念一个「无效」等于没说');
  });

  test('★ 清错误时不能把字段原有的 aria-describedby 一起摘掉', () => {
    // 密码框本来就有一个 aria-describedby 指向「至少 8 位」那段说明
    const src = fnSource('clearFieldError');
    assert.match(src, /startsWith\('fe_'\)/,
      '应该是「只摘掉自己加的那个 id」，不能整条 removeAttribute');
  });

  test('★ 用户一开始改就把错误去掉（不用等再次提交）', () => {
    const src = fnSource('initFieldErrors');
    assert.match(src, /addEventListener\('input', clearOne, true\)/,
      '改的时候错误还挂着，用户会以为自己改错了');
    assert.match(src, /addEventListener\('change', clearOne, true\)/);
    // 捕获阶段：有些组件的 input 事件会被 stopPropagation 吃掉
    assert.match(src, /, true\)/, '要用捕获阶段，否则可能收不到事件');
  });

  test('★ 出错时把第一个坏字段聚焦并滚进视野', () => {
    const src = fnSource('focusFirstInvalid');
    assert.match(src, /focus\(/, '不聚焦的话用户还得自己找');
    assert.match(src, /scrollIntoView/,
      '手机上调出键盘后，聚焦的框可能被挡在屏幕外面');
  });

  test('★ 提交成功后清掉所有字段错误', () => {
    assert.ok(/clearFieldErrors\(form\)/.test(app),
      '提交成功后没清错误，残留的红字会让人以为又错了');
  });

  test('★ 真的接进了那几个表单（不是写完摆着没人用）', () => {
    // 抽出函数却没人调用，是「假装修好了」的典型
    for (const [where, needle] of [
      ['作业表单', /placeServerError\(form, err\.message\)/],
      ['课程表单', /setFieldError\(input, `请只填数字/],
      ['学期表单', /setFieldError\(dateInput,/],
      ['密码表单', /setFieldError\(confirm, '两次输入的新密码不一样'\)/],
    ]) {
      assert.match(app, needle, `${where}没有用上字段级错误`);
    }
  });

  test('★ placeServerError 在认不出字段时返回 false，让调用方退回 toast', () => {
    const src = fnSource('placeServerError');
    assert.match(src, /if \(!field\) return false/);
    assert.match(src, /if \(!input\) return false/);
    // 调用方必须真的用了返回值，否则「认不出」时会静默什么都不显示
    assert.match(app, /if \(!placeServerError\(form, err\.message\)\) toast\(err\.message, 'error'\)/,
      '★ 没接住 false —— 认不出字段时用户什么都看不到');
  });
});
