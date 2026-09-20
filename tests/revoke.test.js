/**
 * 「已经发出去的钥匙要能作废」。
 *
 * 会话 Cookie 和日历订阅链接都是**无状态签名令牌** —— 服务端不存它们，
 * 只看签名对不对。好处是不用查表、重启不掉线；坏处是发出去就收不回来。
 *
 * 日历链接尤其难受：有效期一年、**不需要登录**（手机日历不会带 Cookie，
 * 所以链接本身就是钥匙）。没有吊销手段的话，它一旦被截图、被投屏、
 * 被粘到群里，或者在学校 WiFi 上被抄走，唯一的收场办法是换 SESSION_SECRET,
 * 而那会把所有人的登录状态一起清掉 —— 一个人丢了一条链接，全班重新登录。
 *
 * 修法：给用户加两个计数器（session_version / calendar_version），
 * 令牌里带上发出去时的计数值，校验时跟库里的比。要作废就 +1。
 *
 * 这一组测试盯的就是：**+1 之后旧令牌真的失效了，而新令牌还能用**，
 * 以及升级本身不会误伤（旧格式令牌按计数 0 处理，谁都不会被踢下线）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-revoke-test-'));
process.env.DATA_DIR = DATA_DIR;

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let auth;
let db;
let icsExport;
let schema;
let config;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  icsExport = await import('../src/lib/export/ics-export.js');
  schema = await import('../src/db/schema.js');
  config = (await import('../src/config.js')).default;
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;
const newUser = () => auth.createUser({
  username: `r${(seq += 1)}_${Math.random().toString(36).slice(2, 7)}`,
  password: 'test123456',
});

/** 伪造一个请求对象，只带一条 Cookie —— currentUser 就靠它取会话 */
const reqWith = (userId, token) => ({
  headers: { cookie: `sg_session=${token}` },
});

describe('★ 会话令牌可以按人作废', () => {
  test('★ 退出其他设备之后，旧令牌立刻失效', () => {
    const u = newUser();
    const oldToken = auth.createToken(u.id);

    // 作废之前是好的
    assert.ok(auth.currentUser(reqWith(u.id, oldToken)), '刚发的令牌应该能用');

    auth.revokeOtherSessions(u.id);

    assert.equal(auth.currentUser(reqWith(u.id, oldToken)), null,
      '★ 作废之后旧令牌还能用 —— 那「退出其他设备」就是个摆设');
  });

  test('★ 作废之后重新下发的令牌能正常用（当前设备不该被踢）', () => {
    const u = newUser();
    auth.createToken(u.id);
    auth.revokeOtherSessions(u.id);
    const fresh = auth.createToken(u.id);
    assert.ok(auth.currentUser(reqWith(u.id, fresh)),
      '重新下发的令牌必须可用，否则一点「退出其他设备」自己也掉线了');
  });

  test('★ 只影响自己，不动别人的会话', () => {
    const a = newUser();
    const b = newUser();
    const tokenB = auth.createToken(b.id);

    auth.revokeOtherSessions(a.id);

    assert.ok(auth.currentUser(reqWith(b.id, tokenB)),
      '★ 把别人的会话一起作废了 —— 多用户下这是灾难性的');
  });

  test('★ 改密码会踢掉其他设备', () => {
    const u = newUser();
    const oldToken = auth.createToken(u.id);
    assert.ok(auth.currentUser(reqWith(u.id, oldToken)));

    auth.changePassword(u.id, 'newpass123456');

    assert.equal(auth.currentUser(reqWith(u.id, oldToken)), null,
      '★ 改了密码，别人手里那张 Cookie 还能继续用？那改密码等于没改');
    assert.ok(auth.currentUser(reqWith(u.id, auth.createToken(u.id))),
      '改完密码重新登录应该是好的');
  });

  test('改密码之后新密码能登录、旧密码不能', () => {
    const u = newUser();
    auth.changePassword(u.id, 'brandnew12345');
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
    assert.ok(auth.verifyPassword('brandnew12345', row.password_hash));
    assert.ok(!auth.verifyPassword('test123456', row.password_hash));
  });
});

describe('★ 日历订阅链接可以按人作废', () => {
  test('★ 重新生成之后，旧链接立刻失效', () => {
    const u = newUser();
    const oldToken = icsExport.calendarToken(u.id);

    assert.equal(icsExport.verifyCalendarToken(oldToken)?.userId, u.id,
      '刚生成的链接应该有效');

    auth.revokeCalendarTokens(u.id);

    assert.equal(icsExport.verifyCalendarToken(oldToken), null,
      '★ 作废之后旧链接还能拉课表 —— 那这个按钮没解决问题');
  });

  test('★ 重新生成之后，新链接有效而且指向同一个人', () => {
    const u = newUser();
    auth.revokeCalendarTokens(u.id);
    const fresh = icsExport.calendarToken(u.id);
    assert.equal(icsExport.verifyCalendarToken(fresh)?.userId, u.id);
  });

  test('★ 作废链接不影响登录状态（两件事分开）', () => {
    const u = newUser();
    const session = auth.createToken(u.id);
    auth.revokeCalendarTokens(u.id);
    assert.ok(auth.currentUser(reqWith(u.id, session)),
      '★ 换订阅链接把人踢下线了 —— 这两个计数器必须分开');
  });

  test('★ 改密码连订阅链接一起作废', () => {
    // 密码泄露时，链接很可能也一起泄露了（多半就是从同一个地方丢的）。
    const u = newUser();
    const link = icsExport.calendarToken(u.id);
    assert.equal(icsExport.verifyCalendarToken(link)?.userId, u.id);

    auth.changePassword(u.id, 'another123456');

    assert.equal(icsExport.verifyCalendarToken(link), null,
      '★ 改了密码，之前发出去的订阅链接还能看课表');
  });

  test('作废别人的链接不影响我的', () => {
    const me = newUser();
    const other = newUser();
    const myLink = icsExport.calendarToken(me.id);
    auth.revokeCalendarTokens(other.id);
    assert.equal(icsExport.verifyCalendarToken(myLink)?.userId, me.id);
  });

  test('伪造签名的链接一律拒绝（不能只改计数就蒙混过关）', () => {
    const u = newUser();
    const token = icsExport.calendarToken(u.id);
    const parts = token.split('.');
    // 把计数改成 99：签名是对不上的，必须拒
    parts[2] = '99';
    assert.equal(icsExport.verifyCalendarToken(parts.join('.')), null);
  });
});

describe('★ 升级不能误伤：旧格式令牌按计数 0 处理', () => {
  test('★ 升级前发出去的会话令牌仍然有效（不会被集体踢下线）', () => {
    // v5 之前是 `v1.<uid>.<expires>`，没有计数值。
    // 如果直接拒绝，所有人升级完就掉线了 —— 用户会以为是 bug。
    // 按 0 处理既能兼容，又保住了吊销能力（一旦 +1，计数变 1 ≠ 0，照样失效）。
    const u = newUser();
    const legacy = `v1.${u.id}.${Date.now() + 86_400_000}`;
    const signed = `${legacy}.${legacySignature(legacy)}`;
    assert.ok(auth.currentUser(reqWith(u.id, signed)),
      '★ 旧格式令牌被拒了 —— 升级会让所有人掉线一次');
  });

  test('★ 旧格式令牌在计数 +1 之后也会失效', () => {
    const u = newUser();
    const legacy = `v1.${u.id}.${Date.now() + 86_400_000}`;
    const signed = `${legacy}.${legacySignature(legacy)}`;
    auth.revokeOtherSessions(u.id);
    assert.equal(auth.currentUser(reqWith(u.id, signed)), null,
      '★ 旧令牌是「免死金牌」—— 那吊销功能对老会话完全无效');
  });

  test('★ 升级前发出去的订阅链接仍然有效', () => {
    const u = newUser();
    const legacy = `cal.${u.id}.${Date.now() + 86_400_000}`;
    const signed = `${legacy}.${legacySignature(legacy)}`;
    assert.equal(icsExport.verifyCalendarToken(signed)?.userId, u.id,
      '★ 旧格式订阅链接被拒 —— 已经加好的手机日历会突然不更新');
  });

  test('★ 旧格式订阅链接在重新生成之后失效', () => {
    const u = newUser();
    const legacy = `cal.${u.id}.${Date.now() + 86_400_000}`;
    const signed = `${legacy}.${legacySignature(legacy)}`;
    auth.revokeCalendarTokens(u.id);
    assert.equal(icsExport.verifyCalendarToken(signed), null);
  });

  test('过期的令牌照样拒绝（计数对了也不行）', () => {
    const u = newUser();
    const legacy = `v1.${u.id}.${Date.now() - 1000}`;
    assert.equal(auth.currentUser(reqWith(u.id, `${legacy}.${legacySignature(legacy)}`)), null);
    const u2 = newUser();
    const dl = icsExport.calendarToken(u2.id, -1);
    assert.equal(icsExport.verifyCalendarToken(dl), null);
  });
});

/** 用和服务端同一把密钥、同一种算法签一个旧格式令牌 */
function legacySignature(payload) {
  // 密钥必须**复用服务端真正在用的那一把**（config.sessionSecret）。
  // 自己另生成一个的话，签出来的东西服务端根本不认 ——
  // 那种测试会「假绿」：看起来断言通过了，其实验的是另一套东西。
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

describe('★ 数据库迁移与界面入口', () => {
  test('★ SCHEMA_VERSION 提到了 5，并且有对应的迁移', () => {
    assert.equal(schema.SCHEMA_VERSION, 5, '版本号没提上去，迁移不会跑');
    assert.ok(schema.MIGRATIONS[5], '缺少 v5 迁移');
    assert.equal(schema.MIGRATIONS[5].length, 2, 'v5 应该给两个计数器各加一列');
  });

  test('★ 老库（没有这两列）升级后能用，而且默认是 0', () => {
    // 直接造一个 v4 时代的用户表，把 v5 迁移跑一遍 —— 这是真正的升级路径。
    // 只看代码不看结果的话，「ALTER 写错了」要等线上才发现，
    // 而线上的表现是「所有人都登不进去」。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-mig-'));
    const raw = new DatabaseSync(path.join(tmp, 'old.db'));
    try {
      raw.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        school TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`);
      raw.exec("INSERT INTO users (username, password_hash) VALUES ('olduser', 'x')");
      raw.exec('PRAGMA user_version = 4');

      for (const step of schema.MIGRATIONS[5]) step(raw);

      const cols = raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      assert.ok(cols.includes('session_version'), '迁移没加上 session_version');
      assert.ok(cols.includes('calendar_version'), '迁移没加上 calendar_version');
      const row = raw.prepare('SELECT session_version, calendar_version FROM users WHERE id = 1').get();
      assert.equal(Number(row.session_version), 0,
        '默认必须是 0 —— 不是 0 的话升级那一瞬间所有人都掉线');
      assert.equal(Number(row.calendar_version), 0,
        '默认必须是 0 —— 不是 0 的话已经订阅好的手机日历全废');

      // 再跑一次不能报错：迁移必须能安全重跑（全新库会先建表再跑迁移）
      for (const step of schema.MIGRATIONS[5]) step(raw);
      assert.ok(raw.prepare('PRAGMA table_info(users)').all().length > 0);
    } finally {
      raw.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('★ 设置页有「重新生成订阅链接」按钮', () => {
    const settings = read('src/web/pages/settings.js');
    assert.match(settings, /data-regenerate-calendar/, '没有这个按钮，链接作废不了');
    // 按钮旁边必须讲清楚后果，否则用户不知道手机会掉订阅
    assert.match(settings, /以前发出去的所有订阅链接立刻失效/);
  });

  test('★ 设置页有「退出其他所有设备」按钮', () => {
    const settings = read('src/web/pages/settings.js');
    assert.match(settings, /data-revoke-sessions/);
  });

  test('★ 改密码的提示要说清副作用', () => {
    // 不说的话，用户过几天发现手机日历不更新了，会以为是自己弄坏的。
    const appJs = read('src/web/public/app.js');
    const at = appJs.indexOf("'/api/password'");
    assert.notEqual(at, -1);
    const after = appJs.slice(at, at + 800);
    assert.match(after, /日历订阅链接/, '改密码的提示里没提订阅链接会失效');
  });

  test('★ 改密码之后服务端要给当前设备重发 Cookie', () => {
    // 不给的话，改完密码自己也被踢出去了（旧 Cookie 的计数已经过期）。
    const api = read('src/routes/api.js');
    const at = api.indexOf("router.post('/api/password'");
    const body = api.slice(at, api.indexOf('}));', at));
    assert.match(body, /setSessionCookie\(ctx\.res, ctx\.user\.id\)/,
      '★ 改密码后没有重发 Cookie —— 用户改完密码会被立刻登出');
  });

  test('★ 两个新接口都要求登录', () => {
    const api = read('src/routes/api.js');
    for (const route of ['/api/sessions/revoke-others', '/api/calendar/regenerate']) {
      const at = api.indexOf(`router.post('${route}'`);
      assert.notEqual(at, -1, `缺少接口 ${route}`);
      assert.match(api.slice(at, at + 90), /guard\(/, `${route} 没有走登录守卫`);
    }
  });
});
