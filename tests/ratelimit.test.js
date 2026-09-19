/**
 * 限流与客户端标识的单元测试。
 *
 * 重点不是「桶能不能算对」这种小事，而是**能不能被绕过**：
 * 这个功能存在的全部意义就是给按流量计费的账单兜底，
 * 如果攻击者伪造一个 HTTP 头就能绕过去，那它比没有还危险（让人以为有保护）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, limiterKey, pickLimiter } from '../src/lib/ratelimit.js';

/** 造一个最小的假请求 */
function fakeReq({ ip = '1.2.3.4', xff } = {}) {
  return {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: ip },
  };
}

describe('令牌桶的基本行为', () => {
  test('容量之内放行，并正确报告剩余量', () => {
    const lim = createRateLimiter({ capacity: 3, perMinute: 3, name: 't' });
    assert.equal(lim.take('a', 0).allowed, true);
    assert.equal(lim.take('a', 0).allowed, true);
    const third = lim.take('a', 0);
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0, '用完最后一个后剩余应该是 0');
  });

  test('★ 超出容量后被挡，并给出 Retry-After', () => {
    const lim = createRateLimiter({ capacity: 2, perMinute: 60, name: 't' });
    lim.take('a', 0);
    lim.take('a', 0);
    const blocked = lim.take('a', 0);
    assert.equal(blocked.allowed, false);
    // 60/分钟 = 每秒 1 个，缺 1 个就是等 1 秒
    assert.equal(blocked.retryAfterSec, 1);
    assert.equal(blocked.remaining, 0);
  });

  test('★ 时间过去之后会匀速回填（不是整分钟才重置）', () => {
    const lim = createRateLimiter({ capacity: 10, perMinute: 60, name: 't' });
    for (let i = 0; i < 10; i += 1) lim.take('a', 0);
    assert.equal(lim.take('a', 0).allowed, false, '桶空了应该被挡');

    // 过了 5 秒 → 60/分钟 × 5/60 分钟 = 5 个令牌回来
    assert.equal(lim.take('a', 5_000).allowed, true, '5 秒后应该至少能过 1 个');
    for (let i = 0; i < 4; i += 1) assert.equal(lim.take('a', 5_000).allowed, true);
    assert.equal(lim.take('a', 5_000).allowed, false, '回填的 5 个用完又该被挡');
  });

  test('回填不会超过容量上限', () => {
    const lim = createRateLimiter({ capacity: 3, perMinute: 60, name: 't' });
    lim.take('a', 0);
    // 放很久
    for (let i = 0; i < 3; i += 1) assert.equal(lim.take('a', 3_600_000).allowed, true);
    assert.equal(lim.take('a', 3_600_000).allowed, false, '攒了很久也只能攒到容量那么多');
  });

  test('★ 不同 key 之间互不影响（一个 IP 被限不该连累别人）', () => {
    const lim = createRateLimiter({ capacity: 1, perMinute: 1, name: 't' });
    assert.equal(lim.take('a', 0).allowed, true);
    assert.equal(lim.take('a', 0).allowed, false, 'a 用完了');
    assert.equal(lim.take('b', 0).allowed, true, 'b 不该被 a 连累');
  });

  test('时间倒流（时钟回拨）不会把桶撑爆', () => {
    const lim = createRateLimiter({ capacity: 2, perMinute: 60, name: 't' });
    lim.take('a', 10_000);
    lim.take('a', 10_000);
    const r = lim.take('a', 5_000); // 时间往回走
    assert.equal(r.allowed, false, '时钟回拨不该白送令牌');
  });

  test('参数不合法时明确报错，而不是默默按 0 处理', () => {
    assert.throws(() => createRateLimiter({ capacity: 0, perMinute: 1 }), /正数/);
    assert.throws(() => createRateLimiter({ capacity: 1, perMinute: 0 }), /正数/);
  });
});

describe('桶的清理（否则大量 IP 会把内存撑爆）', () => {
  test('★ 长时间不用、且已经回满的桶会被清掉', () => {
    const lim = createRateLimiter({ capacity: 5, perMinute: 60, name: 't' });
    for (let i = 0; i < 50; i += 1) lim.take(`ip-${i}`, 0);
    assert.equal(lim.size, 50);

    // 过很久之后再访问一个，触发回满；此时旧桶应该被 sweep 掉
    lim.take('ip-0', 60 * 60 * 1000);
    const removed = lim.sweep(60 * 60 * 1000);
    assert.ok(removed >= 49, `应该清掉大部分，实际清了 ${removed}`);
  });

  test('★ 最近用过的桶不会被清掉（否则限流会在最需要的时候失效）', () => {
    // 关键：桶还没回满，说明这个 IP 正在被限。删了它就等于给它解除限流。
    const lim = createRateLimiter({ capacity: 5, perMinute: 1, name: 't' });
    lim.take('busy', 0); // 用掉 1 个 → 还剩 4，没回满

    assert.equal(lim.sweep(10_000), 0, '刚用过 10 秒的桶不能删');
    assert.equal(lim.size, 1);
  });

  test('闲置够久、且早已回满的桶才会被清掉', () => {
    const lim = createRateLimiter({ capacity: 5, perMinute: 1, name: 't' });
    lim.take('old', 0);

    // 半小时没动静，5 个令牌早就回满了 —— 这时候删掉和留着在效果上等价
    assert.equal(lim.sweep(30 * 60_000), 1);
    assert.equal(lim.size, 0);
  });
});

describe('★ 客户端标识不能被伪造（这是限流能不能被绕过的关键）', () => {
  test('默认只认 TCP 连接给的 remoteAddress', () => {
    const req = fakeReq({ ip: '10.0.0.5', xff: '1.1.1.1' });
    assert.equal(limiterKey(req, false), '10.0.0.5');
  });

  test('★ 不信任代理时，伪造 X-Forwarded-For 完全没用', () => {
    // 这是最要紧的一条：如果能靠改这个头换桶，限流等于没做
    const a = limiterKey(fakeReq({ ip: '10.0.0.5', xff: '1.1.1.1' }), false);
    const b = limiterKey(fakeReq({ ip: '10.0.0.5', xff: '9.9.9.9' }), false);
    assert.equal(a, b, '同一台机器换 XFF 应该仍然算同一个 key');
  });

  test('★ 打开 TRUST_PROXY 时取 XFF 的最后一个（代理亲眼看到的那个）', () => {
    // 反代是把客户端 IP 追加到末尾，所以开头那些是客户端自己塞的，不可信
    const req = fakeReq({ ip: '127.0.0.1', xff: '6.6.6.6, 7.7.7.7, 8.8.8.8' });
    assert.equal(limiterKey(req, true), '8.8.8.8');
  });

  test('打开 TRUST_PROXY 但没有 XFF 时回落，不会算成同一个空 key', () => {
    assert.equal(limiterKey(fakeReq({ ip: '10.0.0.5' }), true), '10.0.0.5');
  });

  test('XFF 是空串或只有逗号时不会炸', () => {
    assert.equal(limiterKey(fakeReq({ ip: '10.0.0.5', xff: '   ' }), true), '10.0.0.5');
    assert.equal(limiterKey(fakeReq({ ip: '10.0.0.5', xff: ',,' }), true), '10.0.0.5');
  });

  test('拿不到 remoteAddress 时有个兜底值，不会变成 undefined', () => {
    assert.equal(limiterKey({ headers: {}, socket: null }, false), 'unknown');
  });
});

describe('该用哪个限流器', () => {
  const general = { name: 'general' };
  const auth = { name: 'auth' };

  test('★ 登录、注册、初始化账号都走严格的那档', () => {
    assert.equal(pickLimiter('/login', 'POST', { general, auth }), auth);
    assert.equal(pickLimiter('/setup', 'POST', { general, auth }), auth);
    // 注册同样要严：不限的话邀请码就能被无限次试出来，
    // 而且可以批量建号把磁盘和数据库当免费空间用
    assert.equal(pickLimiter('/register', 'POST', { general, auth }), auth);
  });

  test('★ 只是打开登录页/注册页不算试密码，走普通档', () => {
    assert.equal(pickLimiter('/login', 'GET', { general, auth }), general);
    assert.equal(pickLimiter('/register', 'GET', { general, auth }), general);
  });

  test('登出走普通档（它不需要密码，限它没意义）', () => {
    assert.equal(pickLimiter('/logout', 'POST', { general, auth }), general);
  });

  test('普通页面和接口走普通档', () => {
    assert.equal(pickLimiter('/', 'GET', { general, auth }), general);
    assert.equal(pickLimiter('/api/assignments', 'POST', { general, auth }), general);
  });
});
