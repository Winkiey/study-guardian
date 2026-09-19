/**
 * 「返回码要说实话」—— 越权访问和不存在的资源都该是 404，不是 500/200。
 *
 * 这一组是补测试时**挖出来的真 bug**，起因是外部审计指出
 * 「跨账号隔离只测了课程/作业/资料三类，学期、提醒渠道、设置、作息表、导入都没测」。
 * 补上那几类之后，一次跑出五种错：
 *
 *   · 四个 PATCH 接口在「这条数据不是你的」时返回 **500**，
 *     因为它们底层的 lib 函数抛的是普通 `Error('xx不存在')`，
 *     而接口层把它当成「服务器内部错误」。
 *     SQL 本身是带 user_id 的，所以**数据没有被改**——
 *     但用户看到的是「服务器出错了」，日志里还堆一堆假错误。
 *   · `DELETE /api/terms/:id` 无论如何都回 **200**：
 *     SQL 一行没删（WHERE 带了 user_id），接口却报成功 ——
 *     界面上看起来删掉了，刷新一下还在。
 *
 * 顺带还有个不明显的副作用：500 和 404 的区别本身就是个**探测口子** ——
 * 500 表示「这行存在但不是你的」，404 表示「根本没这行」，
 * 光靠状态码就能把别人的数据 id 一个个试出来。统一成 404 之后这条道就堵了。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-status-test-'));
process.env.DATA_DIR = DATA_DIR;

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let auth;
let db;
let courses;
let assignments;
let materials;
let notify;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  courses = await import('../src/lib/courses.js');
  assignments = await import('../src/lib/assignments.js');
  materials = await import('../src/lib/materials.js');
  notify = await import('../src/lib/notify/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;
function twoUsers() {
  seq += 1;
  const a = auth.createUser({ username: `甲${seq}_${Math.random().toString(36).slice(2, 6)}`, password: 'test123456' });
  const b = auth.createUser({ username: `乙${seq}_${Math.random().toString(36).slice(2, 6)}`, password: 'test123456' });
  return { a, b };
}

/** 断言抛出来的是 404 的 HttpError，而不是普通 Error（后者会变成 500） */
function assertNotFound(fn, what) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `${what}：应该抛错`);
  assert.equal(thrown.status, 404,
    `${what}：应该是 404，实际 ${thrown.status ?? '（没带 status，会变成 500）'}：${thrown.message}`);
}

// ============================================================
// 越权访问：必须是 404
// ============================================================

describe('★ 动别人的数据要回 404，不是 500', () => {
  test('★ 改别人的学期', () => {
    const { a, b } = twoUsers();
    const termId = courses.createTerm(b.id, { name: '乙的学期', startDate: '2026-09-07', weekCount: 18 });
    assertNotFound(() => courses.updateTerm(a.id, termId, { name: '被改了' }), '改别人的学期');
  });

  test('★ 改别人的课程', () => {
    const { a, b } = twoUsers();
    const courseId = courses.createCourse(b.id, { name: '乙的课' });
    assertNotFound(() => courses.updateCourse(a.id, courseId, { name: '被改了' }), '改别人的课程');
  });

  test('★ 改别人的作业', () => {
    const { a, b } = twoUsers();
    const courseId = courses.createCourse(b.id, { name: '乙的课2' });
    const assignmentId = assignments.createAssignment(b.id, { title: '乙的作业', courseId });
    assertNotFound(() => assignments.updateAssignment(a.id, assignmentId, { title: '被改了' }), '改别人的作业');
  });

  test('★ 改别人的资料', async () => {
    const { a, b } = twoUsers();
    // ⚠️ 这里以前是 `materials.createMaterialRow ? … : null`，没有这个函数就 return —— 
    // 结果这一条**从来没跑过**，一直是空转的绿（反向验证时注射 bug 才发现）。
    // 现在走真实的上传入口建一行，建不出来就直接判失败。
    const row = await materials.createMaterialFromUpload(
      b.id,
      { filename: '乙的资料.txt', mime: 'text/plain', data: Buffer.from('乙的资料') },
      { title: '乙的资料' },
    );
    assert.ok(row?.id, '资料没建出来，这条断言就白测了');
    assertNotFound(() => materials.updateMaterial(a.id, row.id, { title: '被改了' }), '改别人的资料');
    // 而且真的没被改掉
    assert.equal(materials.getMaterial(b.id, row.id).title, '乙的资料', '别人的资料被改了');
  });

  test('★ 改别人的提醒渠道', () => {
    const { a, b } = twoUsers();
    const id = notify.createChannel(b.id, { type: 'bark', name: '乙的手机', config: { key: 'ABCDEFGH' } });
    assertNotFound(() => notify.updateChannel(a.id, id, { name: '被改了' }), '改别人的提醒渠道');
  });

  test('不存在的 id 同样回 404（不能因此暴露「哪些 id 是真的」）', () => {
    const { a } = twoUsers();
    assertNotFound(() => courses.updateTerm(a.id, 999999, { name: 'x' }), '改不存在的学期');
    assertNotFound(() => courses.updateCourse(a.id, 999999, { name: 'x' }), '改不存在的课程');
    assertNotFound(() => assignments.updateAssignment(a.id, 999999, { title: 'x' }), '改不存在的作业');
  });
});

describe('★ 删东西要如实回报「删掉了没有」', () => {
  test('★ 删别人的学期返回 false（接口据此回 404），而且别人的学期还在', () => {
    const { a, b } = twoUsers();
    const termId = courses.createTerm(b.id, { name: '乙的学期', startDate: '2026-09-07', weekCount: 18 });

    assert.equal(courses.deleteTerm(a.id, termId), false,
      '★ 一行都没删掉就该返回 false —— 以前接口无论如何都回 200，界面看起来删了、刷新还在');
    assert.ok(courses.listTerms(b.id).some((t) => t.id === termId), '别人的学期必须还在');
  });

  test('删自己的学期返回 true，而且真的没了', () => {
    const { a } = twoUsers();
    const termId = courses.createTerm(a.id, { name: '甲的学期', startDate: '2026-09-07', weekCount: 18 });
    assert.equal(courses.deleteTerm(a.id, termId), true);
    assert.ok(!courses.listTerms(a.id).some((t) => t.id === termId));
  });
});

// ============================================================
// 静态守卫：以后别再把「找不到」写成普通 Error
// ============================================================

describe('★ 别再抛普通 Error 当「找不到」', () => {
  const files = [
    'src/lib/courses.js',
    'src/lib/assignments.js',
    'src/lib/materials.js',
    'src/lib/notify/index.js',
  ];

  test('★ 这几个模块里不许再用 throw new Error(\'…不存在\')', () => {
    for (const f of files) {
      const src = code(read(f));
      const bad = [...src.matchAll(/throw new Error\(\s*['"][^'"]*不存在[^'"]*['"]\s*\)/g)]
        .map((m) => m[0]);
      assert.equal(bad.length, 0,
        `${f} 里还有普通 Error 当「找不到」用（会变成 500）：${bad.join('、')}`);
    }
  });

  test('这四个模块都用上了 notFound，而且都 import 了它', () => {
    // 以前这里写的是「如果用了 notFound 就要求 import 了它」——
    // 有个空洞：某个文件把 notFound 全删了（或改名），这个循环会直接 continue，
    // 断言一次都不跑，照样绿。所以先把「用了」也变成硬要求。
    for (const f of files) {
      const src = code(read(f));
      assert.match(src, /notFound\(/, `${f} 里一次 notFound 都没用上`);
      assert.match(src, /import\s*\{[^}]*notFound[^}]*\}/, `${f} 用了 notFound 却没 import`);
    }
  });
});
