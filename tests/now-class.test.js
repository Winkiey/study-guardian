/**
 * 课程表页上那张「正在上课」的卡：进度和倒计时。
 *
 * 这里钉两类东西，而且第二类比第一类更容易出错：
 *
 * 1. **服务端算的那一份**（currentOccurrence / classProgress / humanLeft）。
 *    边界是重点：正好到**开始**那一刻已经在上课了，正好到**下课**那一刻
 *    已经下课了 —— 也就是半开区间 `[start, end)`。
 *
 * 2. **前端算的那一份**（app.js 里的 nowClassProgress）。
 *    它和服务端是**两套独立实现**（一个跑在 Node 里、一个跑在浏览器里，
 *    没法共用），所以两边口径必须各自钉住 —— 只钉一边的话，
 *    页面上"服务端渲染的初始值"和"一秒后前端接管的值"会不一样，
 *    表现就是**进度条先跳一下**。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-nowclass-test-'));
process.env.DATA_DIR = DATA_DIR;

let tt;
let db;

before(async () => {
  tt = await import('../src/web/pages/timetable.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 造几条课：同一天的、有开始和结束时间 */
const occ = (date, startTime, endTime, name = '课') => ({
  date, startTime, endTime, courseId: 1, courseName: name,
});

describe('★ 现在正在上哪节课（服务端）', () => {
  test('★ 在区间内 → 找得到', () => {
    const list = [occ('2026-09-22', '08:00', '09:40')];
    const got = tt.currentOccurrence(list, { date: '2026-09-22', hm: '08:30' });
    assert.equal(got?.startTime, '08:00');
  });

  test('★★ 正好到开始那一刻 → 已经在上课了（算在内）', () => {
    const list = [occ('2026-09-22', '08:00', '09:40')];
    assert.ok(tt.currentOccurrence(list, { date: '2026-09-22', hm: '08:00' }),
      '★ 08:00 整应该算"正在上课"');
  });

  test('★★ 正好到下课那一刻 → 已经下课了（不算，半开区间）', () => {
    const list = [occ('2026-09-22', '08:00', '09:40')];
    assert.equal(tt.currentOccurrence(list, { date: '2026-09-22', hm: '09:40' }), null,
      '★ 09:40 整不该还算"正在上课" —— 那会让倒计时显示"还剩 0 分钟"却还在上课');
  });

  test('★ 课间（两节之间）没有正在上的课', () => {
    const list = [
      occ('2026-09-22', '08:00', '09:40', '第一节'),
      occ('2026-09-22', '10:00', '11:40', '第二节'),
    ];
    assert.equal(tt.currentOccurrence(list, { date: '2026-09-22', hm: '09:50' }), null);
  });

  test('★ 只认今天那一天 —— 别的日期的课不算', () => {
    const list = [occ('2026-09-21', '08:00', '09:40')];
    assert.equal(tt.currentOccurrence(list, { date: '2026-09-22', hm: '08:30' }), null,
      '★ 昨天同一时间的课被当成了"正在上"');
  });

  test('★ 没补零的时间（8:00）也认 —— 按字符串比会排错', () => {
    const list = [occ('2026-09-22', '8:00', '9:40')];
    assert.ok(tt.currentOccurrence(list, { date: '2026-09-22', hm: '08:30' }),
      '★ 脏数据「8:00」按字符串比会大于「10:00」，于是永远匹配不上');
  });

  test('坏数据（起止一样 / 反了）跳过，不抛异常', () => {
    const list = [occ('2026-09-22', '08:00', '08:00'), occ('2026-09-22', '10:00', '09:00')];
    assert.equal(tt.currentOccurrence(list, { date: '2026-09-22', hm: '08:30' }), null);
    assert.doesNotThrow(() => tt.currentOccurrence(null, { date: 'x', hm: 'x' }));
    assert.doesNotThrow(() => tt.currentOccurrence([], { date: '2026-09-22', hm: '乱写' }));
  });

  test('★ 万一有重叠的课，取开始得最早的那节（结果确定，不靠遍历顺序）', () => {
    const list = [
      occ('2026-09-22', '09:00', '10:00', '晚的'),
      occ('2026-09-22', '08:00', '09:30', '早的'),
    ];
    assert.equal(tt.currentOccurrence(list, { date: '2026-09-22', hm: '09:10' })?.courseName, '早的');
  });
});

describe('★ 进度和倒计时（服务端）', () => {
  test('★ 上到一半 → 50%', () => {
    // 08:00–10:00 共 120 分钟；09:00 是正中间
    const p = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 9 * 3600 });
    assert.equal(Math.round(p.percent), 50);
    assert.equal(Math.round(p.leftSec / 60), 60);
    assert.equal(Math.round(p.elapsedSec / 60), 60);
  });

  test('★ 刚上课 → 0% 左右；快下课 → 接近 100%', () => {
    const a = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 8 * 3600 });
    assert.equal(a.percent, 0);
    const b = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 10 * 3600 - 1 });
    assert.ok(b.percent > 99 && b.percent < 100, `实际 ${b.percent}`);
  });

  test('★★ 秒精度的意义：同一分钟内进度也在动（否则条子看起来是卡住的）', () => {
    const a = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 9 * 3600 });
    const b = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 9 * 3600 + 30 });
    assert.notEqual(a.percent, b.percent, '★ 半分钟过去进度没变 —— 那是按分钟算的');
  });

  test('★★ 越界时夹在 [0,100]（页面开着跨过下课时间，不该出现 103%）', () => {
    const after = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 11 * 3600 });
    assert.equal(after.percent, 100);
    assert.equal(after.leftSec, 0, '★ 剩余时间成了负数，界面上会出现"还剩 -60 分钟"');
    const before = tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: 6 * 3600 });
    assert.equal(before.percent, 0);
    assert.equal(before.elapsedSec, 0);
  });

  test('坏数据返回 null（调用方据此不渲染那张卡）', () => {
    assert.equal(tt.classProgress({ startTime: '08:00', endTime: '08:00', nowSec: 100 }), null);
    assert.equal(tt.classProgress({ startTime: '10:00', endTime: '08:00', nowSec: 100 }), null);
    assert.equal(tt.classProgress({ startTime: '乱写', endTime: '10:00', nowSec: 100 }), null);
    assert.equal(tt.classProgress({ startTime: '08:00', endTime: '10:00', nowSec: null }), null);
  });

  test('★ 人话：向上取整，不出现"还剩 0 分钟"', () => {
    assert.equal(tt.humanLeft(30), '还剩 30 秒');
    assert.equal(tt.humanLeft(59), '还剩 59 秒');
    assert.equal(tt.humanLeft(60), '还剩 1 分钟');
    assert.equal(tt.humanLeft(61), '还剩 2 分钟', '★ 还剩 61 秒该说 2 分钟（向上取整）');
    assert.equal(tt.humanLeft(2100), '还剩 35 分钟');
    assert.equal(tt.humanLeft(0), '还剩 0 秒');
    assert.equal(tt.humanLeft(-5), '还剩 0 秒', '负数不该显示成负的');
  });

  test('★ 刚上课那一小会儿不说"已上课 0 分钟"', () => {
    assert.equal(tt.humanElapsed(0), '刚上课');
    assert.equal(tt.humanElapsed(59), '刚上课');
    assert.equal(tt.humanElapsed(60), '已上课 1 分钟');
    assert.equal(tt.humanElapsed(1500), '已上课 25 分钟');
  });
});

describe('★★ 前端那一半（和服务端是两套实现，口径必须一致）', () => {
  /** 按源码把 app.js 里的 nowClassProgress 取出来跑 —— 前端函数没法 import */
  let clientProgress;

  before(() => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8',
    );
    const start = src.indexOf('function nowClassProgress(');
    assert.ok(start >= 0, '★ app.js 里找不到 nowClassProgress —— 改名了记得同步这里');
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, '取不到函数结尾');
    const body = src.slice(start, end + 2);
    // hmToMinutes 是 app.js 里的另一个小工具，注入一份等价实现
    const hmToMinutes = (hm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? '').trim());
      if (!m) return null;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) return null;
      return h * 60 + mi;
    };
    // eslint-disable-next-line no-new-func
    clientProgress = new Function('hmToMinutes', `${body}; return nowClassProgress;`)(hmToMinutes);
  });

  test('★★ 前端和服务端算出同一个进度（不然页面会先跳一下）', () => {
    const cases = [
      ['08:00', '10:00', 9 * 3600],
      ['08:00', '09:40', 8 * 3600 + 1234],
      ['13:30', '15:05', 14 * 3600 + 45],
    ];
    for (const [s, e, nowSec] of cases) {
      const server = tt.classProgress({ startTime: s, endTime: e, nowSec });
      const client = clientProgress({ startHm: s, endHm: e, nowSec });
      assert.ok(client, `${s}-${e} 前端算不出结果`);
      assert.equal(Math.round(client.percent * 100), Math.round(server.percent * 100),
        `★ ${s}-${e} 两边进度不一致：前端 ${client.percent}、服务端 ${server.percent}`);
      assert.equal(Math.round(client.leftSec), Math.round(server.leftSec),
        `★ ${s}-${e} 两边剩余时间不一致`);
    }
  });

  test('★★ 前端也要在**越界时返回 null**（页面挂过夜之后不能给错进度）', () => {
    assert.equal(clientProgress({ startHm: '08:00', endHm: '10:00', nowSec: 11 * 3600 }), null,
      '★ 下课之后前端没返回 null —— 那张卡会一直挂在页面上');
    assert.equal(clientProgress({ startHm: '08:00', endHm: '10:00', nowSec: 6 * 3600 }), null);
  });

  test('★ 前端同样把坏数据挡住（起止一样 / 反了 / 时间不合法）', () => {
    assert.equal(clientProgress({ startHm: '08:00', endHm: '08:00', nowSec: 100 }), null);
    assert.equal(clientProgress({ startHm: '10:00', endHm: '08:00', nowSec: 100 }), null);
    assert.equal(clientProgress({ startHm: '乱写', endHm: '10:00', nowSec: 100 }), null);
  });

  test('★ 前端那一份被 boot 调用了（不然它永远不会跑）', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8',
    );
    assert.ok(/initNowClass\(\)/.test(src), '★ initNowClass 没有在 boot 里被调用');
  });
});
