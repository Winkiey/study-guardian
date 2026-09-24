/**
 * `?back=` 的过滤（http.js 的 safeBackPath）。
 *
 * 它存在的唯一理由是挡**开放重定向**：`back` 是用户可控的，
 * 原样拼进 <a href> 就等于把本站当跳板 —— 而那个链接长在我们自己的域名下、
 * 还带着我们的样式，看起来完全可信，这是钓鱼最喜欢的一种。
 *
 * 所以这个文件的重点是「**不**该放行什么」，不是"能放行什么"。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { safeBackPath } from '../src/lib/http.js';

const FB = '/materials';

describe('★ back 参数：放行的是站内已知板块', () => {
  test('普通的站内路径照常放行（否则返回按钮就没用了）', () => {
    for (const p of [
      '/materials',
      '/materials?courseId=3',
      '/materials?q=线代&category=courseware',
      '/materials/42',
      '/courses',
      '/courses/7',
      '/assignments?status=pending',
      '/community',
      '/community/9',
      '/settings',
      '/import',
      '/timetable?week=3',
      '/calendar',
      '/',
    ]) {
      assert.equal(safeBackPath(p, FB), p, `${p} 应该被放行`);
    }
  });

  test('前后空格会被容忍（复制粘贴常见），但不合法的一律回落', () => {
    assert.equal(safeBackPath('  /materials  ', FB), '/materials');
  });
});

describe('★★ 挡开放重定向', () => {
  test('★ 绝对网址被挡（最直白的那种）', () => {
    for (const evil of [
      'https://example.com',
      'http://example.com/x',
      'https://example.com/materials',   // 前缀像也不许 —— 看的是开头
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://x',
    ]) {
      assert.equal(safeBackPath(evil, FB), FB, `${evil} 必须被挡`);
    }
  });

  test('★ 协议相对网址被挡（// 开头，浏览器会当成外站）', () => {
    assert.equal(safeBackPath('//example.com', FB), FB);
    assert.equal(safeBackPath('//example.com/materials', FB), FB);
  });

  test('★ 反斜杠绕过被挡（有些浏览器把 \\ 当 /）', () => {
    assert.equal(safeBackPath('/\\example.com', FB), FB);
    assert.equal(safeBackPath('/materials\\x', FB), FB);
  });

  test('★ 控制字符和换行被挡（换行可以用来骗过粗心的解析）', () => {
    assert.equal(safeBackPath('/materials\nhttps://x', FB), FB);
    assert.equal(safeBackPath('/materials\u0000', FB), FB);
    assert.equal(safeBackPath('/materials\t', FB), FB);
  });

  test('★ 白名单外的站内路径也回落（把可回跳的面收窄）', () => {
    assert.equal(safeBackPath('/nope', FB), FB);
    assert.equal(safeBackPath('/logout', FB), FB);
    assert.equal(safeBackPath('/avatar/1', FB), FB);
  });

  test('★ 前缀相似但不同板块的不算命中（不然白名单形同虚设）', () => {
    assert.equal(safeBackPath('/materialsXYZ', FB), FB);
    assert.equal(safeBackPath('/coursesX', FB), FB);
    assert.equal(safeBackPath('/communityX?y=1', FB), FB);
  });

  test('★ 路径里的 .. 段被挡（同源，但一个"返回上一步"不该需要它）', () => {
    assert.equal(safeBackPath('/materials/../../../etc/passwd', FB), FB);
    assert.equal(safeBackPath('/materials/../settings', FB), FB);
    // 只看 ? 之前那部分，所以查询里的 .. 不受影响
    assert.equal(safeBackPath('/materials?q=..', FB), '/materials?q=..');
  });
});

describe('兜底：坏输入不会抛异常，也不会放行', () => {
  test('空值、非字符串、超长都回落到安全的目标', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, [], true]) {
      assert.equal(safeBackPath(bad, FB), FB, `${JSON.stringify(bad)} 应该回落`);
    }
    assert.equal(safeBackPath(`/materials?q=${'x'.repeat(400)}`, FB), FB, '超长的应该回落');
  });

  test('fallback 本身可以换（课程详情页用的就是 /courses）', () => {
    assert.equal(safeBackPath('https://x', '/courses'), '/courses');
    assert.equal(safeBackPath('', '/courses'), '/courses');
  });

  test('★ 返回值永远是一个 / 开头的站内路径（这是它唯一的契约）', () => {
    const inputs = [
      '/materials', 'https://x', '//x', '/\\x', '', null, 7, '/nope',
      '/materials/../x', 'javascript:x', '/materials?courseId=1',
    ];
    for (const raw of inputs) {
      const out = safeBackPath(raw, FB);
      assert.ok(out.startsWith('/'), `${JSON.stringify(raw)} → ${out} 不是站内路径`);
      assert.ok(!out.startsWith('//'), `${JSON.stringify(raw)} → ${out} 是协议相对地址`);
    }
  });
});
