/**
 * 调休 / 停课覆盖。
 *
 * 这是「某一周整周都错」的那类问题：课表固定周重复，遇到法定节假日调休时
 * 它不会报错、不会缺东西，只是**安安静静地显示了一张错的课表** ——
 * 而错的课表比没有课表更糟，因为你不会去怀疑它。
 *
 * 所以这个文件里两头都要钉：
 *   1. applyOverrides 这个纯函数本身对不对（含"停课那天自己不上、
 *      但别人仍要上那天的课"这种反直觉的组合）；
 *   2. 它有没有真的接到课表查询上（接错了就是纯函数全对、页面全错）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-override-test-'));
process.env.DATA_DIR = DATA_DIR;

let ov;
let db;
let courses;
let auth;

before(async () => {
  ov = await import('../src/lib/schedule-overrides.js');
  courses = await import('../src/lib/courses.js');
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 造一份「周一到周五每天一节」的假课表 */
function occ(week) {
  // week: 以 2026-03-02（周一）开头的那一周
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
  return days.map((date, i) => ({
    date, startTime: '08:00', endTime: '09:40',
    courseId: i + 1, courseName: `周${'一二三四五'[i]}的课`,
  }));
}

describe('★ applyOverrides：纯函数', () => {
  test('没有任何覆盖时原样返回', () => {
    const raw = occ();
    const out = ov.applyOverrides(raw, new Map(), { from: '2026-03-02', to: '2026-03-08' });
    assert.equal(out.length, 5);
  });

  test('★ 停课：那一天的课消失，别的天不受影响', () => {
    const raw = occ();
    const byDate = new Map([['2026-03-03', { date: '2026-03-03', kind: 'off' }]]);
    const out = ov.applyOverrides(raw, byDate, { from: '2026-03-02', to: '2026-03-08' });
    assert.equal(out.length, 4);
    assert.ok(!out.some((o) => o.date === '2026-03-03'), '停课那天的课还在');
    assert.ok(out.some((o) => o.date === '2026-03-04'), '★ 不该把别的天一起删了');
  });

  test('★★ 调课：那天上目标星期几的课，而且**自己的课被换掉**', () => {
    const raw = occ();
    // 2026-03-07 是周六（原本没课），按周三（3）的课表上
    const byDate = new Map([['2026-03-07', { date: '2026-03-07', kind: 'swap', swapTo: 3 }]]);
    const out = ov.applyOverrides(raw, byDate, { from: '2026-03-02', to: '2026-03-08' });

    const moved = out.filter((o) => o.date === '2026-03-07');
    assert.equal(moved.length, 1, '周六应该出现一节"周三的课"');
    assert.equal(moved[0].courseName, '周三的课');
    assert.equal(moved[0].movedFrom, '2026-03-04', '要记住它本来是哪天的');
    // 周三自己的课**还在**（周三没停课）
    assert.ok(out.some((o) => o.date === '2026-03-04'), '周三的课被误删了');
    assert.equal(out.length, 6, '周一~周五 5 节 + 挪过来的 1 节');
  });

  test('★★ 最容易搞错的一种：调课的来源那天**自己停课**，课照样要补上', () => {
    // 这就是国庆的真实形状：10/7（周三）放假，10/11（周六）仍上周三的课
    const raw = occ();
    const byDate = new Map([
      ['2026-03-04', { date: '2026-03-04', kind: 'off' }],                    // 周三停课
      ['2026-03-07', { date: '2026-03-07', kind: 'swap', swapTo: 3 }],        // 周六上周三
    ]);
    const out = ov.applyOverrides(raw, byDate, { from: '2026-03-02', to: '2026-03-08' });

    assert.ok(!out.some((o) => o.date === '2026-03-04'), '周三停课了，不该还有课');
    const moved = out.filter((o) => o.date === '2026-03-07');
    assert.equal(moved.length, 1, '★ 周三停了课，周六就补不上了 —— 来源取了处理后的数据');
    assert.equal(moved[0].courseName, '周三的课');
  });

  test('★★ 结果的顺序不能依赖 Map 的遍历顺序（先停课后调课、反过来都得一样）', () => {
    const raw = occ();
    const a = new Map([
      ['2026-03-04', { date: '2026-03-04', kind: 'off' }],
      ['2026-03-07', { date: '2026-03-07', kind: 'swap', swapTo: 3 }],
    ]);
    const b = new Map([
      ['2026-03-07', { date: '2026-03-07', kind: 'swap', swapTo: 3 }],
      ['2026-03-04', { date: '2026-03-04', kind: 'off' }],
    ]);
    const ra = ov.applyOverrides(raw, a, { from: '2026-03-02', to: '2026-03-08' });
    const rb = ov.applyOverrides(raw, b, { from: '2026-03-02', to: '2026-03-08' });
    assert.deepEqual(ra.map((o) => `${o.date} ${o.courseName}`), rb.map((o) => `${o.date} ${o.courseName}`));
  });

  test('★ 调课那一天自己的课要被换掉，不是叠加', () => {
    const raw = occ();
    // 2026-03-03 是周二（有课），让它按周四（4）上
    const byDate = new Map([['2026-03-03', { date: '2026-03-03', kind: 'swap', swapTo: 4 }]]);
    const out = ov.applyOverrides(raw, byDate, { from: '2026-03-02', to: '2026-03-08' });
    const tue = out.filter((o) => o.date === '2026-03-03');
    assert.equal(tue.length, 1, '周二应该是 1 节（被换掉），不是 2 节');
    assert.equal(tue[0].courseName, '周四的课');
  });

  test('★ 铺出去的那 6 天要被裁掉（不能让上一周的课漏进这一周）', () => {
    const raw = [
      { date: '2026-02-25', startTime: '08:00', courseName: '上周的课' },
      { date: '2026-03-03', startTime: '08:00', courseName: '本周的课' },
    ];
    const out = ov.applyOverrides(raw, new Map([['2026-03-04', { date: '2026-03-04', kind: 'off' }]]),
      { from: '2026-03-02', to: '2026-03-08' });
    assert.ok(!out.some((o) => o.date === '2026-02-25'), '★ 铺出去的上周那天漏出来了');
    assert.equal(out.length, 1);
  });
});

describe('★ 写库与校验', () => {
  let userId;
  before(() => {
    userId = auth.createUser({ username: 'ovuser', password: 'test123456' }).id;
  });

  test('★ 停课能存能读', () => {
    const saved = ov.setOverride(userId, { date: '2026-10-01', kind: 'off', note: '国庆' });
    assert.equal(saved.kind, 'off');
    assert.equal(saved.swapTo, null, '停课不该带 swapTo');
    assert.equal(saved.note, '国庆');
  });

  test('★ 同一天再写一次是**改**，不是两条', () => {
    ov.setOverride(userId, { date: '2026-10-01', kind: 'swap', swapTo: 2 });
    const rows = ov.listOverrides(userId).filter((r) => r.date === '2026-10-01');
    assert.equal(rows.length, 1, '★ 一天出现了两条覆盖 —— UNIQUE 没生效');
    assert.equal(rows[0].kind, 'swap');
    assert.equal(rows[0].swapTo, 2);
  });

  test('★ 参数不合法时抛中文原因（调用方据此回 400）', () => {
    assert.throws(() => ov.setOverride(userId, { date: '2026/10/01', kind: 'off' }), /日期/,
      '★ 斜杠写法被放行了 —— 它会当字符串键用，永远匹配不到任何一天');
    assert.throws(() => ov.setOverride(userId, { date: '2026-2-1', kind: 'off' }), /日期/);
    assert.throws(() => ov.setOverride(userId, { date: '2026-02-30', kind: 'off' }), /日期/,
      '★ 2 月 30 日被放行了（JS 的 Date 会把它滚到 3 月）');
    assert.throws(() => ov.setOverride(userId, { date: '2026-10-02', kind: '乱写' }), /类型/);
    assert.throws(() => ov.setOverride(userId, { date: '2026-10-02', kind: 'swap' }), /星期几/);
    assert.throws(() => ov.setOverride(userId, { date: '2026-10-02', kind: 'swap', swapTo: 9 }), /星期几/);
  });

  test('★★ 调课的目标不能是这一天自己（那是没调，但界面会显示成一句怪话）', () => {
    // 2026-10-02 是周五
    assert.throws(() => ov.setOverride(userId, { date: '2026-10-02', kind: 'swap', swapTo: 5 }), /自己/);
  });

  test('★ 别人的覆盖动不了（按 id 删也要带 user_id）', () => {
    const other = auth.createUser({ username: 'ovother', password: 'test123456' }).id;
    const mine = ov.setOverride(userId, { date: '2026-10-03', kind: 'off' });
    assert.equal(ov.deleteOverride(other, mine.id), false, '★ 别人把我的覆盖删掉了');
    assert.ok(ov.listOverrides(userId).some((r) => r.id === mine.id), '我的覆盖不见了');
    assert.equal(ov.deleteOverride(userId, mine.id), true);
  });

  test('查不到就返回空/空 Map，不抛异常', () => {
    assert.deepEqual(ov.listOverrides(999999), []);
    assert.equal(ov.overridesInRange(999999, '2026-01-01', '2026-12-31').size, 0);
  });
});

describe('★★ 接进课表查询（纯函数对 ≠ 页面对）', () => {
  const SCHOOL = '东北财经大学';

  /**
   * 建一个账号：一门周三的课，学期从 2026-03-02（周一）开始。
   * ⚠️ createTerm / createCourse 返回的是**行 id**（不是对象），
   *    别写 `.id` —— 那会静默变成 undefined，然后在绑参数时才炸，
   *    报错还指向 SQLite（"cannot be bound to parameter 1"），指不到这里。
   */
  function setupUser(name) {
    const u = auth.createUser({ username: name, password: 'test123456', displayName: name });
    const termId = courses.createTerm(u.id, { name: '2026 春', startDate: '2026-03-02', weekCount: 18 });
    const courseId = courses.createCourse(u.id, { name: '周三的课', termId });
    courses.replaceSessions(courseId, [{ weekday: 3, startTime: '08:00', endTime: '09:40', weeks: '1-18' }]);
    return { userId: u.id, termId, courseId };
  }

  test('★★ 调休接上了：周六那天上出了周三的课', () => {
    const { userId } = setupUser('ovweek');
    // 2026-03-07 是周六
    ov.setOverride(userId, { date: '2026-03-07', kind: 'swap', swapTo: 3 });

    const week = courses.occurrencesInRange(userId, '2026-03-02', '2026-03-08').occurrences;
    const saturday = week.filter((o) => o.date === '2026-03-07');
    assert.equal(saturday.length, 1, '★ 调休没生效 —— 周六还是空的（覆盖没接到查询上）');
    assert.equal(saturday[0].courseName, '周三的课');
  });

  test('★★ 停课接上了：那一天没有课了', () => {
    const { userId } = setupUser('ovoff');
    const before = courses.occurrencesInRange(userId, '2026-03-02', '2026-03-08').occurrences;
    assert.equal(before.filter((o) => o.date === '2026-03-04').length, 1, '（前提）周三本来有课');

    ov.setOverride(userId, { date: '2026-03-04', kind: 'off' });
    const after = courses.occurrencesInRange(userId, '2026-03-02', '2026-03-08').occurrences;
    assert.equal(after.filter((o) => o.date === '2026-03-04').length, 0, '★ 停课没生效');
  });

  test('★★ 查"单独一天"时调休也要生效（这是往前铺 6 天的理由）', () => {
    const { userId } = setupUser('ovday');
    ov.setOverride(userId, { date: '2026-03-07', kind: 'swap', swapTo: 3 });
    // 只查周六这一天：源（周三）不在区间里，不铺 6 天就找不到
    const one = courses.occurrencesInRange(userId, '2026-03-07', '2026-03-07').occurrences;
    assert.equal(one.length, 1, '★ 查单天时调休失效了 —— 忘了往前铺');
    assert.equal(one[0].courseName, '周三的课');
  });

  test('★ 首页用的这个函数（todayOccurrences）也吃到了覆盖', () => {
    const { userId } = setupUser('ovhome');
    // 造一个"今天"的覆盖：今天是哪天就用哪天，只验它能跑通并且不炸
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    ov.setOverride(userId, { date: todayStr, kind: 'off' });
    const res = courses.todayOccurrences(userId);
    assert.equal(res.occurrences.filter((o) => o.date === todayStr).length, 0,
      '★ 首页"今天的课"没吃到停课覆盖 —— 两边显示不一致');
  });

  test('★ 别人设的调休影响不到我', () => {
    const a = setupUser('ovisoA');
    const b = setupUser('ovisoB');
    ov.setOverride(b.userId, { date: '2026-03-07', kind: 'swap', swapTo: 3 });

    const mine = courses.occurrencesInRange(a.userId, '2026-03-02', '2026-03-08').occurrences;
    assert.equal(mine.filter((o) => o.date === '2026-03-07').length, 0,
      '★ 别人的调休串到我这儿了');
    const theirs = courses.occurrencesInRange(b.userId, '2026-03-02', '2026-03-08').occurrences;
    assert.equal(theirs.filter((o) => o.date === '2026-03-07').length, 1, '（前提）他那边生效了');
  });
});
