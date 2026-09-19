/**
 * 课程列表上的「N 份资料 / N 项待办」。
 *
 * 用户报的原话：「课程页面每个课程下面显示的都是 0 份资料和 0 项待办，
 * 和实际不同步」。
 *
 * 根因：这两个数字只在 getCourseDetail() 里算过，而课程**列表**页拿的是
 * listCourses() 的结果 —— 那两个字段压根不存在，模板里写着
 * `c.materialCount ?? 0`，于是每门课都显示 0，而且不报任何错。
 *
 * 所以这里两条都要钉住：
 *   1. listCourses() 必须真的算出这两个数
 *   2. 渲染出来的页面上必须是真实数字（用户看到的就是这个）
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-courses-test-'));
process.env.DATA_DIR = DATA_DIR;

let auth;
let db;
let courses;
let materials;
let coursesPage;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  courses = await import('../src/lib/courses.js');
  materials = await import('../src/lib/materials.js');
  ({ coursesPage } = await import('../src/web/pages/courses.js'));
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;

function makeUser() {
  seq += 1;
  return auth.createUser({
    username: `课程计数${seq}_${Math.random().toString(36).slice(2, 7)}`,
    password: 'test123456',
  });
}

/** 铺一门课，带 n 份资料、m 个待办作业，外加一份「没归属课程」的资料和一个已完成的作业 */
async function seed(userId, { name, materialCount, todoCount }) {
  const termId = courses.createTerm(userId, {
    name: '测试学期', startDate: '2025-09-01', weekCount: 18, isActive: true,
  });
  const courseId = courses.createCourse(userId, { name, termId });

  for (let i = 0; i < materialCount; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await materials.createMaterialFromUpload(
      userId,
      { filename: `${name}-资料${i}.txt`, mime: 'text/plain', data: Buffer.from('x', 'utf8') },
      { courseId },
    );
  }

  for (let i = 0; i < todoCount; i += 1) {
    db.run(
      `INSERT INTO assignments (user_id, course_id, title, due_at, status)
       VALUES (?, ?, ?, '2030-01-01 23:59', 'todo')`,
      userId, courseId, `${name}-作业${i}`,
    );
  }

  return courseId;
}

describe('★ listCourses 要算出资料数与待办数', () => {
  test('★ 数字和实际一致（不是永远 0）', async () => {
    const u = makeUser();
    const courseId = await seed(u.id, { name: '有资料的课', materialCount: 3, todoCount: 2 });

    const list = courses.listCourses(u.id);
    const c = list.find((x) => x.id === courseId);

    assert.ok(c, '应该能找到这门课');
    assert.equal(c.materialCount, 3, '资料数应该是 3');
    assert.equal(c.assignmentCount, 2, '待办数应该是 2');
  });

  test('★ 两个字段必须始终是数字（模板里的 ?? 0 会把 undefined 悄悄变成 0）', async () => {
    const u = makeUser();
    const courseId = await seed(u.id, { name: '空课程', materialCount: 0, todoCount: 0 });

    const c = courses.listCourses(u.id).find((x) => x.id === courseId);
    assert.equal(typeof c.materialCount, 'number', '必须是数字，不能是 undefined');
    assert.equal(typeof c.assignmentCount, 'number', '必须是数字，不能是 undefined');
    assert.equal(c.materialCount, 0);
    assert.equal(c.assignmentCount, 0);
  });

  test('★ 已完成的作业不算待办', async () => {
    const u = makeUser();
    const courseId = await seed(u.id, { name: '有已完成作业的课', materialCount: 0, todoCount: 2 });
    // 再加一个已完成的：它不该被数进去
    db.run(
      `INSERT INTO assignments (user_id, course_id, title, due_at, status)
       VALUES (?, ?, '已经交了的', '2030-01-01 23:59', 'done')`,
      u.id, courseId,
    );

    const c = courses.listCourses(u.id).find((x) => x.id === courseId);
    assert.equal(c.assignmentCount, 2, '已完成的作业不该算进「待办」');
  });

  test('★ 不归属这门课的资料不算进去', async () => {
    const u = makeUser();
    const courseId = await seed(u.id, { name: '目标课', materialCount: 1, todoCount: 0 });

    // 一份没归属课程的资料，和一份归属另一门课的
    await materials.createMaterialFromUpload(
      u.id,
      { filename: '没归属.txt', mime: 'text/plain', data: Buffer.from('x') },
      {},
    );
    const otherId = await seed(u.id, { name: '另一门课', materialCount: 5, todoCount: 9 });

    const list = courses.listCourses(u.id);
    assert.equal(list.find((x) => x.id === courseId).materialCount, 1, '只能数自己名下的');
    assert.equal(list.find((x) => x.id === otherId).materialCount, 5, '另一门课各算各的');
  });

  test('★ 别人的资料不会被算进我的课（多用户下很容易漏）', async () => {
    const me = makeUser();
    const other = makeUser();
    const myCourseId = await seed(me.id, { name: '我的课', materialCount: 1, todoCount: 0 });

    // 另一个人有一门同名课程，并且给「他自己那门」传了很多资料
    await seed(other.id, { name: '我的课', materialCount: 4, todoCount: 4 });

    const c = courses.listCourses(me.id).find((x) => x.id === myCourseId);
    assert.equal(c.materialCount, 1, '只应该数到自己的 1 份资料');
    assert.equal(c.assignmentCount, 0);
  });
});

describe('★ 页面上真的显示这些数字', () => {
  function render(user, list) {
    return coursesPage({
      user,
      courses: list,
      term: null,
      stats: { totalCredits: 0, weeklyHours: 0 },
      keyword: '',
    }).body;
  }

  test('★ 有 3 份资料 / 2 项待办时，页面上写的就是 3 和 2', async () => {
    const u = makeUser();
    await seed(u.id, { name: '渲染测试课', materialCount: 3, todoCount: 2 });

    const html = render(u, courses.listCourses(u.id));

    assert.ok(html.includes('3 份资料'), `页面上应该写「3 份资料」\n${html.slice(0, 400)}`);
    assert.ok(html.includes('2 项待办'), '页面上应该写「2 项待办」');
    assert.ok(!html.includes('0 份资料'), '★ 不该再出现「0 份资料」—— 这正是用户报的那个 bug');
  });

  test('★ 一门课都没有资料时，写 0 是对的（不是把 0 一律当 bug）', async () => {
    const u = makeUser();
    await seed(u.id, { name: '真的空课', materialCount: 0, todoCount: 0 });

    const html = render(u, courses.listCourses(u.id));
    assert.ok(html.includes('0 份资料'), '真的没有资料时，0 就是正确答案');
    assert.ok(html.includes('0 项待办'));
  });
});
