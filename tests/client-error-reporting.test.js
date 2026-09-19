/**
 * 断网 / 出错时用户到底看到什么。
 *
 * 起因是外部审计报告里的一条：客户端全局错误兜底的注释写着
 * 「网络断了或接口 500 时给出提示而不是静默失败」，
 * 而实现是 `if (!/Failed to fetch|NetworkError/i.test(msg)) toast(...)` ——
 * **恰好把断网这一类挡掉了**，和注释写的正好相反。
 *
 * 核对代码之后实际情况比报告说的更细，分两种：
 *   1. 绝大多数操作路径自己 catch 了，会 toast —— 但弹的是英文原文
 *      `TypeError: Failed to fetch`，对用户没有任何意义；
 *   2. 没被 catch 的才会走到全局兜底，而它被正则挡掉了 → 真正静默。
 * 所以修法是两处：api() 里把网络错误翻译成中文；全局兜底不要再过滤掉它们。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');

/**
 * 去掉注释再匹配。
 *
 * ⚠️ 这一步是**必须**的，不是讲究。这个项目已经第三次踩这个坑了：
 * 本文件里解释「原来那个 bug」的注释，原文就是
 * `if (!/Failed to fetch|NetworkError/i.test(msg))` ——
 * 于是「不该再出现 `!/Failed to fetch`」这条断言命中的是**注释**，
 * 永远为真，等于没写。（前两次分别栽在 CSS 的 z-index 注释和测试窗口太小。）
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** 把某个函数从 app.js 里抠出来，在假环境里真跑一遍。
 *  只 grep 源码里有没有某个字符串，是测不出逻辑对错的。 */
function extractFunction(name, src = app) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = re.exec(src);
  assert.ok(m, `app.js 里应该有 ${name}()`);
  return stripComments(m[0]);
}

// eslint-disable-next-line no-new-func
const describeFetchError = new Function(
  `${extractFunction('describeFetchError')}\nreturn describeFetchError;`,
)();

// ============================================================
// 翻译
// ============================================================

describe('★ 断网要变成中文', () => {
  test('★ 各浏览器抛的「断网」措辞都要认出来', () => {
    // 这三家的原文完全不一样，只认一种就会漏：
    // Chrome/Edge → Failed to fetch，Safari → Load failed，Node/undici → fetch failed
    const networkErrors = [
      new TypeError('Failed to fetch'),
      new TypeError('Load failed'),
      new TypeError('fetch failed'),
      new TypeError('NetworkError when attempting to fetch resource.'),
      new Error('net::ERR_INTERNET_DISCONNECTED'),
    ];
    for (const err of networkErrors) {
      const msg = describeFetchError(err);
      assert.match(msg, /网络/, `「${err.message}」要翻译成中文，实际：${msg}`);
      assert.doesNotMatch(msg, /Failed to fetch|Load failed|fetch failed|NetworkError|net::/i,
        `不能把英文原文端给用户，实际：${msg}`);
    }
  });

  test('★ 服务端返回的业务错误必须原样透出，不能被当成断网', () => {
    // 这条很关键：如果把 400「密码至少 8 位」也替换成「网络连接失败」，
    // 用户就永远不知道真正错在哪了 —— 比不翻译更糟。
    const cases = [
      '用户名或密码不正确',
      '密码至少 8 位',
      '请求太频繁，请等 60 秒后再试',
      '请求失败（HTTP 500）',
      '这门课已经有同名的了',
    ];
    for (const text of cases) {
      assert.equal(describeFetchError(new Error(text)), text);
    }
  });

  test('空 / 奇怪的输入要有兜底文案，不能显示 "undefined"', () => {
    for (const bad of [null, undefined, '', new Error('')]) {
      const msg = describeFetchError(bad);
      assert.ok(msg && msg !== 'undefined', `空输入要有兜底，实际：${JSON.stringify(msg)}`);
    }
    assert.equal(describeFetchError('字符串也算'), '字符串也算', '直接传字符串也要能处理');
  });
});

// ============================================================
// 接线
// ============================================================

describe('★ 客户端接线', () => {
  test('★ api() 要把 fetch 的网络失败接住并翻译', () => {
    // 不在 api() 里接的话，各调用点 toast 出来的就是英文原文
    const api = extractFunction('api');
    assert.match(api, /try\s*\{[\s\S]*await fetch/, 'fetch 要包在 try 里');
    assert.match(api, /catch\s*\([^)]*\)\s*\{[\s\S]*describeFetchError/, 'catch 里要过一遍翻译');
  });

  test('★ 全局兜底不能把断网消息排除掉（这正是原来那个 bug）', () => {
    const boot = extractFunction('boot');
    // 以前是 `if (!/Failed to fetch|NetworkError/i.test(msg)) toast(...)`
    assert.doesNotMatch(boot, /!\s*\/Failed to fetch/,
      '★ 不要再写「命中就跳过」的取反判断 —— 那等于断网时闭嘴');
    assert.match(boot, /unhandledrejection/, '要有 Promise 兜底');
    assert.match(boot, /describeFetchError/, '兜底也要走翻译');
  });

  test('★ 同步异常也要兜住（以前只监听 unhandledrejection）', () => {
    // 事件处理函数里抛的 TypeError 会让按钮「点了完全没反应」，
    // 而控制台之外没有任何痕迹 —— 最容易被当成「网站坏了」。
    const boot = extractFunction('boot');
    assert.match(boot, /addEventListener\('error'/, '要监听 window 的 error 事件');
  });

  test('★ 全局兜底要去重：同一个错误只提示一次', () => {
    // toast 本身没有任何抑制，全局兜底如果每次都播报，
    // 一个反复失败的初始化会糊满一屏提示条，把真正要看的东西盖掉。
    const report = extractFunction('reportGlobalError');
    assert.match(report, /Set\(\)|has\(/, '要有去重集合');
    assert.match(report, /if\s*\([^)]*has\([^)]*\)\)\s*return/, '重复的要说一次就返回');
  });

  test('★ 发送到全局兜底的路径真的会调用它', () => {
    const boot = extractFunction('boot');
    const calls = (boot.match(/reportGlobalError\(/g) || []).length;
    assert.ok(calls >= 2, `unhandledrejection 和 error 两条路都要调 reportGlobalError，实际 ${calls} 处`);
  });
});
