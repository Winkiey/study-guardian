/**
 * 考试：作为一种「另一种日程」，和作业最实质的差别是**提醒节奏**。
 *
 * 作业问的是"还有多久要交"，越近越有用；考试问的是"到点就得坐在考场里"，
 * 提前一周是为了留复习时间，当天早上是为了别睡过头、别忘带证件 ——
 * 三件事的用处各不相同，所以节奏不能照抄作业的。
 *
 * 这里要钉住两头：
 *   1. 考试的默认节奏确实是「提前一周 + 提前一天 + 当天早上」；
 *   2. 作业的默认节奏**没有被顺手改掉**（改错了老用户会莫名其妙少收到提醒）。
 *
 * 另外「当天早上」不是一个分钟数 —— 早 7 点对 8 点的考试是提前 60 分钟、
 * 对下午 2 点的是 420 分钟。所以它只能是记号，按当天 07:00 现算。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-exam-test-'));
process.env.DATA_DIR = DATA_DIR;

let asg;
let sched;
let db;
let auth;
let addDays;
let todayStr;

/**
 * ⚠️ 所有日期都**相对今天**算，不写死。
 *
 * 第一版写的是 2026-06-20 这种固定日期 —— 而今天是 2026-09-21，
 * 那个时间点已经过去了，于是 syncAssignmentReminders 把三条提醒
 * **全部按"已经过点了"跳过**，测试报的是"期望 3 条，实际 0 条"。
 * 写死日期的测试会随着时间推移自己烂掉，而且报错完全指不到原因。
 */
const B = () => addDays(todayStr(), 60);
const at = (dateStr, hm) => `${dateStr} ${hm}`;

before(async () => {
  asg = await import('../src/lib/assignments.js');
  sched = await import('../src/lib/scheduler.js');
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  ({ addDays, todayStr } = await import('../src/lib/datetime.js'));
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;
const newUser = () => auth.createUser({
  username: `exam${seq += 1}_${Math.random().toString(36).slice(2, 7)}`,
  password: 'test123456',
}).id;

/** 取一条日程的待发提醒 */
function pendingOf(id) {
  return db.all(
    "SELECT fire_at, title, body FROM reminders WHERE assignment_id = ? AND status = 'pending' ORDER BY fire_at",
    id,
  );
}

describe('★★ 考试的提醒节奏和作业不一样', () => {
  test('★★ 考试默认三条：提前一周、提前一天、当天早上 07:00', () => {
    const uid = newUser();
    // 考试定在下午 14:00 —— 故意不选整点，好验"当天早上"是按 07:00 算的，
    // 而不是"提前 N 分钟"
    const id = asg.createAssignment(uid, {
      title: '高等数学期末', kind: 'exam', dueAt: at(B(), '14:00'),
      location: '之远楼 301', examFormat: '闭卷', examScope: '第 1-8 章',
    });
    const rows = pendingOf(id);
    assert.equal(rows.length, 3, `期望 3 条提醒，实际 ${rows.length}：${JSON.stringify(rows)}`);

    const times = rows.map((r) => r.fire_at);
    assert.ok(times.includes(at(addDays(B(), -7), '14:00:00')),
      `应该有提前一周那条：${times.join(' / ')}`);
    assert.ok(times.includes(at(addDays(B(), -1), '14:00:00')),
      `应该有提前一天那条：${times.join(' / ')}`);
    assert.ok(times.includes(at(B(), '07:00:00')),
      `★ 应该有"当天早上 07:00"那条（不是提前多少分钟）：${times.join(' / ')}`);
  });

  test('★★ 「当天早上」不是一个分钟数：换个考试时间，它还是 07:00', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, {
      title: '早八考试', kind: 'exam', dueAt: at(B(), '08:00'),
    });
    const times = pendingOf(id).map((r) => r.fire_at);
    // 8 点的考试：早 7 点是提前 60 分钟；下午 2 点的是提前 420 分钟。
    // 写成固定分钟数的话，两条里必有一条是错的。
    assert.ok(times.includes(at(B(), '07:00:00')),
      `★ 早 8 点的考试，早上提醒也应该是 07:00：${times.join(' / ')}`);
  });

  test('★ 提醒的措辞说的是「开考」不是「截止」', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, {
      title: '线性代数', kind: 'exam', dueAt: at(B(), '14:00'),
    });
    const rows = pendingOf(id);
    for (const r of rows) {
      assert.ok(r.title.includes('考试'), `考试提醒该说「考试」：${r.title}`);
      assert.ok(!/作业/.test(r.title), `★ 考试的提醒里混进了「作业」：${r.title}`);
      assert.ok(/开考/.test(r.title), `★ 该说「开考」而不是「截止」：${r.title}`);
    }
    const morning = rows.find((r) => r.fire_at.startsWith(B()));
    assert.ok(morning && morning.title.includes('今天开考'), `实际：${morning?.title}`);
  });

  test('★ 考试的提醒正文带上地点/形式/范围（考生最要紧的三件事）', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, {
      title: '数据结构', kind: 'exam', dueAt: at(B(), '14:00'),
      location: '博学楼 108', examFormat: '开卷', examScope: '第 3-9 章',
    });
    const body = pendingOf(id)[0].body;
    assert.ok(body.includes('博学楼 108'), `正文里应该有地点：${body}`);
    assert.ok(body.includes('开卷'), `正文里应该有形式：${body}`);
    assert.ok(body.includes('第 3-9 章'), `正文里应该有范围：${body}`);
    assert.ok(body.includes('开考'), `正文该说「开考」：${body}`);
  });

  test('★★ 作业的默认节奏没被顺手改掉（老用户不该莫名少收提醒）', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, { title: '普通作业', dueAt: at(B(), '23:59') });
    const rows = pendingOf(id);
    assert.equal(rows.length, 2, '★ 作业的默认提前量被改了 —— 原来是 2 条（提前一天 + 提前两小时）');
    for (const r of rows) {
      assert.ok(/截止/.test(r.title), `作业该说「截止」：${r.title}`);
      assert.ok(!/开考/.test(r.title), `★ 作业的提醒里出现了「开考」：${r.title}`);
    }
    assert.ok(!rows.some((r) => r.fire_at.includes('07:00:00')),
      '★ 作业不该有"当天早上"那条 —— 那是考试的节奏');
  });

  test('★ 类型非法时按作业处理（不是 500，也不是变成考试）', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, { title: '乱写类型', kind: '随便', dueAt: at(B(), '23:59') });
    assert.equal(asg.getAssignment(uid, id).kind, 'homework');
  });
});

describe('★ 改类型 / 改时间之后，提醒要跟着重建', () => {
  test('★ 作业改成考试：节奏立刻换成考试那套', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, { title: '先当作业', dueAt: at(B(), '14:00') });
    assert.equal(pendingOf(id).length, 2, '（前提）作业是 2 条');

    asg.updateAssignment(uid, id, { kind: 'exam', remindOffsets: '10080,1440,morning' });
    const rows = pendingOf(id);
    assert.equal(rows.length, 3, `改成考试后应该有 3 条：${rows.map((r) => r.fire_at).join(' / ')}`);
    assert.ok(rows.some((r) => r.fire_at === at(B(), '07:00:00')), '★ 缺了"当天早上"那条');
  });

  test('★ 考试改时间：三条提醒全部跟着挪', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, { title: '改期', kind: 'exam', dueAt: at(B(), '14:00') });
    asg.updateAssignment(uid, id, { dueAt: at(addDays(B(), 7), '09:00') });
    const times = pendingOf(id).map((r) => r.fire_at);
    assert.ok(times.includes(at(B(), '09:00:00')), `提前一周该跟着挪：${times.join(' / ')}`);
    assert.ok(times.includes(at(addDays(B(), 7), '07:00:00')), `当天早上也该跟着挪：${times.join(' / ')}`);
    assert.ok(!times.some((s) => s.startsWith(`${B()} 14`)), '★ 旧时间的提醒没被清掉');
  });

  test('★ 考试也能被勾成「已完成」（考完了就不用再提醒）', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, {
      title: '考完了', kind: 'exam', dueAt: at(addDays(B(), 11), '09:00'),
    });
    assert.ok(pendingOf(id).length > 0, '（前提）本来有提醒');
    asg.setAssignmentStatus(uid, id, 'done');
    assert.equal(pendingOf(id).length, 0, '★ 考完了还在提醒');
  });

  test('★ 地点/形式/范围是考试的字段，改了要存住', () => {
    const uid = newUser();
    const id = asg.createAssignment(uid, { title: '改地点', kind: 'exam', dueAt: at(B(), '14:00') });
    asg.updateAssignment(uid, id, { location: '之远楼 201', examFormat: '机考', examScope: '全部' });
    const got = asg.getAssignment(uid, id);
    assert.equal(got.location, '之远楼 201');
    assert.equal(got.exam_format, '机考');
    assert.equal(got.exam_scope, '全部');
    assert.equal(got.isExam, true);
    assert.equal(got.dueWord, '开考', '★ 考试的时间点该说「开考」');
  });

  test('★ 别人改不动我的考试', () => {
    const uid = newUser();
    const other = newUser();
    const id = asg.createAssignment(uid, { title: '我的考试', kind: 'exam', dueAt: at(B(), '14:00') });
    assert.throws(() => asg.updateAssignment(other, id, { title: '偷偷改' }), /不存在/);
    assert.equal(asg.getAssignment(uid, id).title, '我的考试');
  });
});

describe('★ reminderFireAt / parseRemindSpec 的边界', () => {
  test('分钟数照旧按"往前推"算（没被记号影响）', () => {
    assert.equal(sched.reminderFireAt('2026-06-20 14:00', 60), '2026-06-20 13:00:00');
    assert.equal(sched.reminderFireAt('2026-06-20 14:00', 1440), '2026-06-19 14:00:00');
  });

  test('morning 记号按当天 07:00 算', () => {
    assert.equal(sched.reminderFireAt('2026-06-20 14:00', sched.MORNING_TOKEN), '2026-06-20 07:00:00');
    assert.equal(sched.reminderFireAt('2026-06-20 00:30', sched.MORNING_TOKEN), '2026-06-20 07:00:00');
  });

  test('坏输入不抛异常', () => {
    assert.equal(sched.reminderFireAt('', sched.MORNING_TOKEN), null);
    assert.equal(sched.reminderFireAt('乱写', sched.MORNING_TOKEN), null);
  });

  test('parseRemindSpec 把记号挑出来，分钟数照旧', () => {
    assert.deepEqual(sched.parseRemindSpec('10080,1440,morning'), { offsets: [10080, 1440], morning: true });
    assert.deepEqual(sched.parseRemindSpec('1440,120'), { offsets: [1440, 120], morning: false });
    assert.deepEqual(sched.parseRemindSpec('MORNING'), { offsets: [], morning: true }, '大写也认');
    assert.deepEqual(sched.parseRemindSpec(''), { offsets: [], morning: false });
  });

  test('★ 记号不会被误当成分钟数（那会变成"提前 0 分钟"或者被丢掉）', () => {
    // parseInt('morning') 是 NaN，所以原来的 parseOffsets 会把它丢掉 ——
    // 而丢掉恰恰是危险的那种错：提醒**静默少一条**，不报错。
    assert.deepEqual(sched.parseOffsets('1440,morning'), [1440]);
    assert.equal(sched.parseRemindSpec('1440,morning').morning, true, '★ 记号被丢了');
  });
});
