/**
 * 每日简报的发送时机与重试。
 *
 * 这一组测试来自一个实测出来的问题：用户打开「每日简报」但还没配通知渠道时，
 * 调度器**每 60 秒重试一次**，每一次都往 notify_log 写一行失败记录 ——
 * 一整天 1440 行，而设置页只显示最近 30 行，真正的发送记录会被一墙
 * 一模一样的失败糊住。第二个人注册并试用简报时最容易踩到。
 *
 * 根因是「失败时不写 last_sent」这个设计：它本身是对的
 * （写了的话，用户修好渠道就再也等不到今天这条），
 * 但缺了一个「别试太频繁」的刹车。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-digest-test-'));
process.env.DATA_DIR = DATA_DIR;
// 不启定时器：这一组全部用直接调用的方式驱动，结果才可预期
process.env.SCHEDULER_RUN_ON_START = 'false';

let auth;
let db;
let scheduler;
let settings;
let courses;
let datetime;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  scheduler = await import('../src/lib/scheduler.js');
  settings = await import('../src/lib/settings.js');
  courses = await import('../src/lib/courses.js');
  datetime = await import('../src/lib/datetime.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ============================================================
// 脚手架
// ============================================================

/** 起过的假服务器都记在这里，由 after() 统一关闭 —— 漏关会让测试进程不退出 */
const openServers = [];

after(async () => {
  await Promise.all(openServers.map((s) => new Promise((r) => s.close(r))));
  openServers.length = 0;
});

/** 一个总返回 200 的假 Bark 服务器（发送成功的路径） */
function startFakeBark() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, raw });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, message: 'success' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      openServers.push(server);
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * 拿一个「确定没人监听」的端口：先占用再释放。
 * 用来构造「渠道配着但发不出去」—— 连上去立刻 ECONNREFUSED，不用真的等网络超时。
 */
function closedPort() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let seq = 0;
function makeUser(prefix = 'u') {
  seq += 1;
  return auth.createUser({
    username: `${prefix}${seq}_${Math.random().toString(36).slice(2, 8)}`,
    password: 'test123456',
    displayName: '简报测试',
  });
}

/** 开启简报，并把时间设成 00:00（否则大部分时间都判「还没到播报时间」） */
function enableDigest(userId, time = '00:00') {
  settings.setSettings(userId, { daily_digest_enabled: '1', daily_digest_time: time });
}

function addBarkChannel(userId, { base, key = 'TestKey', enabled = 1 }) {
  db.run(
    'INSERT INTO notify_channels (user_id, type, name, config, enabled) VALUES (?, ?, ?, ?, ?)',
    userId, 'bark', '测试渠道', JSON.stringify({ server: base, key }), enabled,
  );
}

/** 这个人的发送日志 */
function logRows(userId) {
  return db.all('SELECT channel_type, ok, detail FROM notify_log WHERE user_id = ? ORDER BY id', userId);
}

function readSetting(userId, key, fallback = '') {
  return settings.getSetting(userId, key, fallback);
}

/** 把「上次尝试时间」往前拨 N 分钟，用来模拟时间流逝 */
function rewindLastTry(userId, minutes) {
  const back = datetime.addMinutes(datetime.nowStr(), -minutes);
  db.run(
    `UPDATE settings SET value = ? WHERE user_id = ? AND key = 'daily_digest_last_try'`,
    back, userId,
  );
  return back;
}

/** 给一个人配一门「今天有课」的课程，课程名带上他的名字以便区分 */
function addCourseToday(userId, name) {
  const monday = datetime.startOfWeek(datetime.todayStr());
  const termId = courses.createTerm(userId, {
    name: '测试学期', startDate: monday, weekCount: 18, isActive: true,
  });
  const courseId = courses.createCourse(userId, { name, termId });
  db.run(
    `INSERT INTO course_sessions (course_id, weekday, start_time, end_time, weeks, location)
     VALUES (?, ?, '08:00', '09:40', '1-18', '测试教室')`,
    courseId, datetime.weekdayOf(datetime.todayStr()),
  );
  return courseId;
}

// ============================================================
// 什么时候该跳过去
// ============================================================

describe('简报的发送条件', () => {
  test('没开启简报时什么都不做，也不写日志', async () => {
    const u = makeUser('off');
    const r = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, '未开启每日播报');
    assert.equal(logRows(u.id).length, 0);
  });

  test('还没到设定的时间时不发', async () => {
    const u = makeUser('early');
    // 设一个肯定还没到的时间：今天的 23:59（除非测试正好在 23:59 之后跑）
    const nowHm = datetime.nowStr().slice(11, 16);
    if (nowHm >= '23:58') return; // 极端时间点跳过，避免偶发

    enableDigest(u.id, '23:59');
    const r = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, '还没到播报时间');
    assert.equal(logRows(u.id).length, 0);
  });
});

// ============================================================
// 没配渠道：不是失败，是「还没配」
// ============================================================

describe('★ 没配通知渠道时不能每 60 秒重试一遍', () => {
  test('★ 一个渠道都没配 → 跳过，而且**一行日志都不写**', async () => {
    const u = makeUser('noch');
    enableDigest(u.id);

    for (let i = 0; i < 5; i += 1) {
      const r = await scheduler.maybeSendDailyDigest(u.id);
      assert.equal(r.skipped, true, '第 ' + (i + 1) + ' 次应该跳过');
      assert.equal(r.reason, '还没有配置通知渠道');
    }

    assert.equal(logRows(u.id).length, 0,
      '「还没配渠道」不是发送失败：写日志只会把设置页那 30 行的日志视图糊满');
    assert.equal(readSetting(u.id, 'daily_digest_try_count', '0'), '0',
      '也不该消耗当天的重试次数 —— 用户配好渠道后应该立刻能收到');
  });

  test('★ 渠道存在但被停用时，同样算「没配」', async () => {
    const u = makeUser('disabled');
    enableDigest(u.id);
    const port = await closedPort();
    addBarkChannel(u.id, { base: `http://127.0.0.1:${port}`, enabled: 0 });

    const r = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, '还没有配置通知渠道');
    assert.equal(logRows(u.id).length, 0);
  });

  test('★ 配好渠道后立刻就会发（不用等到第二天）', async () => {
    const u = makeUser('later');
    enableDigest(u.id);

    // 先来个「还没配」的几轮
    for (let i = 0; i < 3; i += 1) await scheduler.maybeSendDailyDigest(u.id);

    // 现在配上
    const fake = await startFakeBark();
    addBarkChannel(u.id, { base: fake.base });

    const r = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(r.skipped, false);
    assert.equal(r.ok, true, '配好之后应该马上发出去');
    assert.equal(fake.requests.length, 1);
  });
});

// ============================================================
// 发不出去：要有刹车
// ============================================================

describe('★ 发送失败时的重试节奏', () => {
  /** 配一个「连不上」的渠道，返回用户 */
  async function userWithBrokenChannel(prefix) {
    const u = makeUser(prefix);
    enableDigest(u.id);
    const port = await closedPort();
    addBarkChannel(u.id, { base: `http://127.0.0.1:${port}` });
    return u;
  }

  test('★ 第一次失败只写一行日志；紧接着再调不会重复试', async () => {
    const u = await userWithBrokenChannel('bad');

    const first = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(first.skipped, false, '第一次应该真的去试');
    assert.equal(first.ok, false, '渠道连不上，应该失败');
    assert.equal(first.attempts, 1);
    assert.equal(logRows(u.id).length, 1);

    // 调度器 60 秒后又会来一次 —— 这里连续调 10 次模拟 10 分钟
    for (let i = 0; i < 10; i += 1) {
      const r = await scheduler.maybeSendDailyDigest(u.id);
      assert.equal(r.skipped, true, '间隔不到就不该再试');
      assert.match(r.reason, /分钟后再试/);
    }

    assert.equal(logRows(u.id).length, 1,
      '★ 10 次调度只留下 1 行日志。修之前这里会是 11 行，一整天 1440 行');
  });

  test('★ 等够间隔之后会再试一次', async () => {
    const u = await userWithBrokenChannel('retry');

    await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(logRows(u.id).length, 1);

    // 把上次尝试时间往前拨 31 分钟（超过 30 分钟的间隔）
    rewindLastTry(u.id, 31);

    const second = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(second.skipped, false, '过了间隔就该再试');
    assert.equal(second.attempts, 2);
    assert.equal(logRows(u.id).length, 2);
  });

  test('★ 试满当天次数上限后停下来，并说清是「明天再试」', async () => {
    const u = await userWithBrokenChannel('limit');

    // 连着三次「等够了再试」
    for (let i = 1; i <= 3; i += 1) {
      if (i > 1) rewindLastTry(u.id, 31);
      const r = await scheduler.maybeSendDailyDigest(u.id);
      assert.equal(r.skipped, false, `第 ${i} 次应该真的去试`);
      assert.equal(r.attempts, i);
    }
    assert.equal(logRows(u.id).length, 3);

    // 第四次：即使等够了间隔也不再试
    rewindLastTry(u.id, 31);
    const fourth = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(fourth.skipped, true);
    assert.match(fourth.reason, /都已尝试|已尝试 3 次/);
    assert.match(fourth.reason, /明天再试/);
    assert.equal(logRows(u.id).length, 3, '一天最多 3 行日志');
  });

  test('★ 跨天之后重试次数自动归零（不需要额外的清理任务）', async () => {
    const u = await userWithBrokenChannel('nextday');

    // 直接伪造「昨天试了 3 次」
    const yesterday = datetime.addDays(datetime.todayStr(), -1);
    db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'daily_digest_last_try', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      u.id, `${yesterday} 07:30:00`,
    );
    db.run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'daily_digest_try_count', '3')
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      u.id,
    );

    const r = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(r.skipped, false, '跨天之后应该重新开始试');
    assert.equal(r.attempts, 1, '次数要从 1 重新数');
  });
});

// ============================================================
// 发得出去的时候
// ============================================================

describe('发送成功', () => {
  test('★ 成功之后当天不再发第二条', async () => {
    const u = makeUser('ok');
    enableDigest(u.id);
    const fake = await startFakeBark();
    addBarkChannel(u.id, { base: fake.base });

    const first = await scheduler.maybeSendDailyDigest(u.id);
    assert.equal(first.ok, true);
    assert.equal(readSetting(u.id, 'daily_digest_last_sent'), datetime.todayStr());

    for (let i = 0; i < 5; i += 1) {
      const r = await scheduler.maybeSendDailyDigest(u.id);
      assert.equal(r.skipped, true);
      assert.equal(r.reason, '今天已经播报过');
    }

    assert.equal(fake.requests.length, 1, '★ 只应该真的发出去一次');
    assert.equal(logRows(u.id).length, 1);
    assert.equal(logRows(u.id)[0].ok, 1);
  });
});

// ============================================================
// 简报内容必须是本人的
// ============================================================

describe('★ 简报内容不会串到别人身上', () => {
  test('★ 两个人各自的简报里只有自己的课和作业', async () => {
    const a = makeUser('digA');
    const b = makeUser('digB');

    const nameA = `只属于甲的课${seq}`;
    const nameB = `只属于乙的课${seq}`;
    addCourseToday(a.id, nameA);
    addCourseToday(b.id, nameB);

    const titleA = `甲的作业${seq}`;
    const titleB = `乙的作业${seq}`;
    const due = `${datetime.addDays(datetime.todayStr(), 1)} 23:59`;
    db.run('INSERT INTO assignments (user_id, title, due_at) VALUES (?, ?, ?)', a.id, titleA, due);
    db.run('INSERT INTO assignments (user_id, title, due_at) VALUES (?, ?, ?)', b.id, titleB, due);

    const digA = await scheduler.buildDailyDigest(a.id);
    const digB = await scheduler.buildDailyDigest(b.id);

    // 自己的都在
    assert.ok(digA.body.includes(nameA), `甲的简报里应该有 ${nameA}`);
    assert.ok(digA.body.includes(titleA), `甲的简报里应该有 ${titleA}`);
    assert.ok(digB.body.includes(nameB), `乙的简报里应该有 ${nameB}`);
    assert.ok(digB.body.includes(titleB), `乙的简报里应该有 ${titleB}`);

    // 别人的一个字都不该出现 —— 简报是直接推到手机上的，串了就是隐私泄露
    assert.ok(!digA.body.includes(nameB), '★ 甲的简报里不能有乙的课');
    assert.ok(!digA.body.includes(titleB), '★ 甲的简报里不能有乙的作业');
    assert.ok(!digB.body.includes(nameA), '★ 乙的简报里不能有甲的课');
    assert.ok(!digB.body.includes(titleA), '★ 乙的简报里不能有甲的作业');
  });
});
