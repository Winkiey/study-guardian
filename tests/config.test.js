/**
 * 配置层的单元测试，重点是**时区**。
 *
 * 为什么值得单独测：课表、作业 DDL、提醒时间全部按「本地时间的字符串」存取，
 * 而 datetime.js 取「现在」用 new Date() —— 那是进程的本地时区。
 * 时区配错不会报任何错，只会让所有提醒整体偏移几小时，
 * 而且要等到点收不到推送才发现。本机开发时又看不出来（自己电脑时区是对的）。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let resolveTimezone;

before(async () => {
  ({ resolveTimezone } = await import('../src/config.js'));
});

describe('resolveTimezone 的判定矩阵', () => {
  test('★ 只有 .env 给了 TZ 时，也算「显式配置」', () => {
    // 这是最关键的一格：用户在自己电脑上跑，process.env.TZ 通常是空的，
    // 只有 .env 里写了 TZ=Asia/Shanghai。如果这一格判成 false，
    // 那个 TZ 就会被完全忽略，然后在一台 UTC 的服务器上偏 8 小时。
    const r = resolveTimezone(undefined, 'Asia/Shanghai');
    assert.equal(r.explicit, true, '.env 里的 TZ 必须被认作显式配置');
    assert.equal(r.value, 'Asia/Shanghai');
  });

  test('只有真实环境变量给了 TZ', () => {
    const r = resolveTimezone('UTC', undefined);
    assert.equal(r.explicit, true);
    assert.equal(r.value, 'UTC');
  });

  test('两边都给时，环境变量优先于 .env', () => {
    const r = resolveTimezone('America/New_York', 'Asia/Shanghai');
    assert.equal(r.value, 'America/New_York');
  });

  test('★ 两边都没给时不算显式配置（不去覆盖操作系统的时区）', () => {
    const r = resolveTimezone(undefined, undefined);
    assert.equal(r.explicit, false, '没配就别动 process.env.TZ，否则会把别的时区的人强行改成北京时间');
    assert.equal(r.value, 'Asia/Shanghai', '默认值本身还是要有个合理的回落');
  });

  test('空字符串等同于没给（.env 里写 TZ= 是常见的手滑）', () => {
    assert.equal(resolveTimezone('', '').explicit, false);
    assert.equal(resolveTimezone('', '').value, 'Asia/Shanghai');
    assert.equal(resolveTimezone('', 'UTC').value, 'UTC');
  });

  test('自定义的默认值会被用上', () => {
    assert.equal(resolveTimezone(undefined, undefined, 'Europe/London').value, 'Europe/London');
  });
});

describe('时区真的能作用到「现在」', () => {
  test('★ 改 process.env.TZ 会改变应用取到的时间', () => {
    // 这条验证的是「config.js 里写 process.env.TZ = ...」这个修法到底有没有用。
    // 如果 Node 不认运行期改的 TZ，那个修法就是自欺欺人。
    const before = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utcHour = new Date().getHours();

      process.env.TZ = 'Asia/Shanghai';
      const cnHour = new Date().getHours();

      const diff = ((cnHour - utcHour) % 24 + 24) % 24;
      assert.equal(diff, 8, `北京时间应比 UTC 快 8 小时，实际差 ${diff}（UTC=${utcHour}, CN=${cnHour}）`);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  test('nowStr() 取的是进程时区，不是写死的', async () => {
    const { nowStr } = await import('../src/lib/datetime.js');
    const before = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const a = nowStr();
      process.env.TZ = 'Asia/Shanghai';
      const b = nowStr();

      assert.match(a, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '格式必须是本地时间字符串');
      assert.notEqual(a.slice(11, 16), b.slice(11, 16), '两个时区取到的「现在」应该不一样');
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('配置层的接线（静态守卫）', () => {
  /**
   * 一定要先去掉注释再匹配。
   *
   * 第一版没做这一步，结果把 `process.env.TZ =` 那行**注释掉**之后
   * 守卫照样是绿的 —— 它匹配到的是注释里的那串文字。
   * 一个会被注释骗过去的守卫等于没有守卫（这是 A/B 试出来的）。
   */
  function stripComments(text) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
      .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1'); // 行注释（避开 https:// 里的 //）
  }

  const src = stripComments(
    fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8'),
  );

  test('★ config.js 必须把时区写回 process.env.TZ', () => {
    // 光有 resolveTimezone 不够 —— 真正的修复是那一行赋值。
    // 把纯函数测得很漂亮、却忘了赋值，症状依旧（而且更难发现），
    // 所以这里直接盯住接线本身。
    assert.match(src, /process\.env\.TZ\s*=/, '缺了这一行，.env 里的 TZ 就是摆设');
  });

  test('★ 只在显式配置时才覆盖，避免强加北京时间', () => {
    assert.match(src, /if\s*\(\s*TIMEZONE\.explicit\s*\)\s*process\.env\.TZ\s*=/,
      '覆盖 process.env.TZ 必须受 explicit 保护');
  });

  test('config.timezone 用的是解析结果，而不是重新读一遍 env', () => {
    assert.match(src, /timezone:\s*TIMEZONE\.value/, '两处各读一次容易漂移');
  });

  test('★ 守卫本身能识破注释（否则它形同虚设）', () => {
    const fake = stripComments('// process.env.TZ = x;\n');
    assert.doesNotMatch(fake, /process\.env\.TZ\s*=/, '注释里的代码不算代码');
  });
});
