/**
 * 安全响应头 + 日志打码。
 *
 * 背景：外部审计报告指出站点没有发任何安全响应头（nosniff、Referrer-Policy、
 * 点击劫持防护、Permissions-Policy），而且私人数据没有明确禁止被搜索引擎收录。
 * 这些都是一行一个的东西，成本极低，但**很容易在以后重构时被顺手删掉而没人发现**，
 * 所以这里把契约钉住。
 *
 * 第二件事是日志打码：日历订阅地址是 `?token=…`，而那个 token 是
 * 「拿到即可拉走全部课表和作业」的凭据、有效期一年，手机日历还会定时轮询它 ——
 * 明文写进访问日志等于把凭据抄一份到磁盘上（日志还会被 pm2 收集）。
 *
 * ⚠️ 本文件里最重要的一条是「frame-ancestors 必须是 'self'」那一条，
 *    原因写在那个用例里，动它之前务必先读一遍。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { redactUrl } from '../src/lib/http.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const serverSrc = read('server.js');
// 匹配前先去掉注释：下面这些规则上面的注释里就提到了 'none' / 'Deny' 这些词，
// 不去掉的话正则会先命中注释（这类「守卫被自己的注释骗了」的坑踩过）
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ============================================================
// 安全响应头
// ============================================================

describe('★ 全局安全响应头', () => {
  test('★ 有一处统一装配，而且在每个请求上都会被调用', () => {
    assert.match(serverCode, /function applySecurityHeaders\(res\)/,
      '要有一个统一的装配函数，而不是散在各处');
    assert.match(serverCode, /applySecurityHeaders\(res\);/,
      '★ 定义了却没调用的话，一个头都不会发出去');
  });

  test('★ 每个必需的头都在', () => {
    const required = [
      ['X-Content-Type-Options', 'nosniff'],
      ['Referrer-Policy', 'strict-origin-when-cross-origin'],
      ['X-Frame-Options', 'SAMEORIGIN'],
      ['Content-Security-Policy', null],
      ['Permissions-Policy', null],
      ['X-Robots-Tag', null],
    ];
    for (const [name, value] of required) {
      const re = new RegExp(`setHeader\\(\\s*'${name}'\\s*,\\s*([^)]*)\\)`);
      const m = re.exec(serverCode);
      assert.ok(m, `缺少 ${name}`);
      if (value) assert.ok(m[1].includes(value), `${name} 应该是 ${value}`);
    }
  });

  test('★ frame-ancestors 必须是 self，不能是 none', () => {
    // ── 动这一条之前请先读完 ──────────────────────────────────
    // 这个头会加到**所有**响应上，包括 /materials/:id/pdf ——
    // 而 PDF 预览页恰恰是**自己用 <iframe> 嵌自己的 PDF**（同源）。
    // 写成 frame-ancestors 'none'（或 X-Frame-Options: DENY）之后，
    // 浏览器会把那个 iframe 一起挡掉 —— **PDF 预览直接白屏**，
    // 而服务器上绝大多数课件都是 PDF。
    //
    // 'self' / SAMEORIGIN 一样能挡住「第三方页面套你」，区别只是放行自己。
    // 所以这里不是「写得不够严」，是**必须**这么写。
    const csp = /const CONTENT_SECURITY_POLICY = "([^"]+)"/.exec(serverCode)?.[1];
    assert.ok(csp, '应该有 CSP 常量');
    assert.match(csp, /frame-ancestors 'self'/,
      "★ 必须是 'self'：改成 'none' 会让 PDF 预览白屏（同源 iframe）");
    assert.doesNotMatch(csp, /frame-ancestors 'none'/,
      '★ 不要收紧成 none（见本用例开头的说明）');

    assert.match(serverCode, /setHeader\(\s*'X-Frame-Options'\s*,\s*'SAMEORIGIN'\s*\)/,
      "X-Frame-Options 同理：SAMEORIGIN，不能是 DENY");
  });

  test('★ CSP 不能顺手写上 default-src / script-src / style-src', () => {
    // 页面里有内联主题脚本，还有大量 style="--dot-color:…" 的内联样式（课程颜色）。
    // 一旦写上 default-src 'self' 这类指令，内联样式会被浏览器直接拦掉 ——
    // 表现是「课程颜色全没了」，而且不会有任何报错，很难联想到是 CSP 干的。
    const csp = /const CONTENT_SECURITY_POLICY = "([^"]+)"/.exec(serverCode)?.[1] || '';
    for (const directive of ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src']) {
      assert.ok(!csp.includes(directive),
        `★ 暂时不要写 ${directive}：会把内联样式/脚本挡掉（见用例说明）`);
    }
  });

  test('★ 私人数据明确禁止被收录', () => {
    assert.match(serverCode, /setHeader\(\s*'X-Robots-Tag'\s*,\s*'noindex, nofollow'\s*\)/);
  });

  test('★ 用 setHeader 而不是逐处 writeHead（否则迟早漏一个）', () => {
    // 理由：项目里有七八个 writeHead 调用点（HTML/JSON/静态/302/304/404/429/500）。
    // Node 会把 setHeader 设过的头和之后 writeHead 里的头合并，所以一处就够。
    // 这条守的是「别退回成每个地方各写一遍」。
    const headers = serverCode.match(/setHeader\(/g) || [];
    assert.ok(headers.length >= 6, `applySecurityHeaders 里应该有 6 条 setHeader，实际 ${headers.length}`);
  });
});

// ============================================================
// 日志打码
// ============================================================

describe('★ 日志里的凭据要打码', () => {
  test('★ 日历订阅 token 会被打掉，其余参数原样保留', () => {
    assert.equal(
      redactUrl('/calendar/subscribe.ics?token=cal.1.1750000000000.SIGNATURE&courses=0'),
      '/calendar/subscribe.ics?token=***&courses=0',
      '路径、参数名、别的参数都要留下 —— 排查问题时还得看得出请求长什么样',
    );
  });

  test('★ 只看参数名，不看它在第几个（token 放最后也要打掉）', () => {
    assert.equal(redactUrl('/x?a=1&b=2&token=SECRET'), '/x?a=1&b=2&token=***');
  });

  test('★ 大小写和别名都算（Token / API_KEY / access_token）', () => {
    for (const key of ['Token', 'TOKEN', 'password', 'apikey', 'API_KEY', 'access_token', 'secret']) {
      const out = redactUrl(`/x?a=1&${key}=SECRET`);
      assert.ok(out.includes('=***'), `${key} 应该被打码，实际：${out}`);
      assert.ok(!out.includes('SECRET'), `${key} 的值不该出现在日志里：${out}`);
    }
  });

  test('普通参数不能被误伤（否则日志就没用了）', () => {
    for (const u of [
      '/materials?q=%E5%BE%AE%E8%A7%82&category=courseware',
      '/login?next=%2Fmaterials',
      '/courses?status=done&courseId=3',
      '/settings',
      '/api/materials/12/status',
    ]) {
      assert.equal(redactUrl(u), u, '没有敏感参数时应原样返回（连转义都不重写）');
    }
  });

  test('不带 = 的裸参数、空值、坏编码都不能把它弄崩', () => {
    assert.equal(redactUrl('/x?a=1&token'), '/x?a=1&token', '没有值的参数没什么可打码的');
    assert.equal(redactUrl('/x?token='), '/x?token=***');
    assert.doesNotThrow(() => redactUrl('/x?%E4%B8%AD=1'));
    assert.doesNotThrow(() => redactUrl('/x?token=%zz'), '编码坏了也不能抛，日志路径不能反过来炸掉请求');
    assert.equal(redactUrl(''), '');
    assert.equal(redactUrl(null), '', 'null / undefined 不该抛');
    assert.equal(redactUrl(undefined), '');
  });

  test('★ 访问日志和错误日志都必须走这个函数', () => {
    // 两条路以前都是直接打 req.url / url.search，token 就这么进了日志。
    // 这里钉住「以后别改回去」。
    const logAccess = /function logAccess\([\s\S]*?\n\}/.exec(serverCode)?.[0] || '';
    assert.ok(logAccess, '应该能找到 logAccess');
    assert.match(logAccess, /redactUrl\(/, '★ 访问日志要走 redactUrl');
    assert.doesNotMatch(logAccess, /url\.pathname\}\$\{url\.search/, '★ 别再直接拼 url.search 了');

    const errorResponse = /function errorResponse\([\s\S]*?\n\}/.exec(serverCode)?.[0] || '';
    assert.ok(errorResponse, '应该能找到 errorResponse');
    assert.match(errorResponse, /redactUrl\(req\.url\)/, '★ 500 的错误日志也要打码（它打的也是 req.url）');
  });
});
