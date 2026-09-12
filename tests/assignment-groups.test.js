/**
 * 作业分组的标题必须和实际分档一致。
 *
 * 起因是用户的一句话：「我觉得在三天外的 ddl 不能叫做稍后截止」。
 * 当时 normal 这一组的标题是「稍后截止」，而它的范围是 3 天以上、上不封顶——
 * 三周后的作业被叫「稍后」，等于在淡化它。改成「3 天以后截止」之后，
 * 就多了一条新的约束：**标题里写的数字必须和 urgencyOf 的实际阈值对得上**。
 *
 * 所以下面的测试不是把「24 小时 / 3 天」再抄一遍（那样测不出任何东西），
 * 而是先用 urgencyOf 把真实边界探测出来，再去看标题有没有说对。
 * 谁改了 datetime.js 的阈值而忘了改标题，这里就会红。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-group-test-'));

let urgencyOf;
let GROUP_META;

before(async () => {
  ({ urgencyOf } = await import('../src/lib/datetime.js'));
  ({ GROUP_META } = await import('../src/web/pages/assignments.js'));
});

/** 固定的观察起点，避免测试结果随「现在几点」变化 */
const FROM = '2026-03-02 12:00';

/** 距离 FROM 再过 n 小时的时间字符串 */
function plusHours(n) {
  const d = new Date(2026, 2, 2, 12, 0); // 本地时间，和 FROM 对应
  d.setMinutes(d.getMinutes() + Math.round(n * 60));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 取某个分组的标题 */
function titleOf(key) {
  const meta = GROUP_META.find((g) => g.key === key);
  assert.ok(meta, `缺少 ${key} 分组`);
  return meta.title;
}

/**
 * 探测 urgent 的上界（小时）和 soon 的上界（小时）。
 * 从 1 小时一路加下去，记下最后一个还属于该档的时间点。
 *
 * 结果做了缓存：这个函数会在多个 test 里被调用，但只有在 before()
 * 跑完之后 urgencyOf 才可用 —— describe 的回调是在收集阶段就执行的，
 * 那时候还没有任何 import，所以只能在 test 内部惰性求值。
 */
let probed = null;
function probeBoundaries() {
  if (probed) return probed;

  let urgentHours = 0;
  let soonHours = 0;
  for (let h = 1; h <= 24 * 30; h += 1) {
    const level = urgencyOf(plusHours(h), FROM);
    if (level === 'urgent') urgentHours = h;
    if (level === 'soon') soonHours = h;
  }
  probed = { urgentHours, soonHours };
  return probed;
}

describe('urgencyOf 的分档边界', () => {
  test('★ 刚好 24 小时算 urgent（边界含在 24 小时内）', () => {
    assert.equal(urgencyOf(plusHours(24), FROM), 'urgent');
  });

  test('★ 24 小时零一点就不算 urgent 了', () => {
    assert.equal(urgencyOf(plusHours(24.02), FROM), 'soon');
  });

  test('★ 刚好 3 天算 soon', () => {
    assert.equal(urgencyOf(plusHours(72), FROM), 'soon');
  });

  test('★ 超过 3 天算 normal（这一档上不封顶）', () => {
    assert.equal(urgencyOf(plusHours(73), FROM), 'normal');
    assert.equal(urgencyOf(plusHours(24 * 30), FROM), 'normal', '一个月后也还是 normal');
  });

  test('已过期和没有 DDL 各自成档', () => {
    assert.equal(urgencyOf(plusHours(-1), FROM), 'overdue');
    assert.equal(urgencyOf(null, FROM), 'none');
  });
});

describe('分组标题和分档一致', () => {
  test('★ 探测到的边界确实是 24 小时和 3 天', () => {
    const { urgentHours, soonHours } = probeBoundaries();
    assert.equal(urgentHours, 24, 'urgent 的边界变了，标题可能已经不对了');
    assert.equal(soonHours, 72, 'soon 的边界变了，标题可能已经不对了');
  });

  test('★ 紧急那一组的标题写的是探测到的 24 小时', () => {
    const { urgentHours } = probeBoundaries();
    const title = titleOf('urgent');
    const m = /(\d+)\s*小时/.exec(title);
    assert.ok(m, `「${title}」里没有说清是多少小时`);
    assert.equal(Number(m[1]), urgentHours, `标题说 ${m[1]} 小时，实际是 ${urgentHours} 小时`);
  });

  test('★ 临近那一组的标题写的是探测到的 3 天', () => {
    const { soonHours } = probeBoundaries();
    const title = titleOf('soon');
    const m = /(\d+)\s*天/.exec(title);
    assert.ok(m, `「${title}」里没有说清是多少天`);
    assert.equal(Number(m[1]), soonHours / 24, `标题说 ${m[1]} 天，实际是 ${soonHours / 24} 天`);
  });

  test('★ 三天外那一组的标题也说的是同一个 3 天边界', () => {
    const { soonHours } = probeBoundaries();
    const title = titleOf('normal');
    const m = /(\d+)\s*天/.exec(title);
    assert.ok(m, `「${title}」里没有说清是从多少天往后`);
    assert.equal(Number(m[1]), soonHours / 24, `标题说 ${m[1]} 天，实际分界是 ${soonHours / 24} 天`);
  });
});

describe('三天外的分组不能淡化紧迫性', () => {
  test('★ 不再叫「稍后截止」（用户明确指出的问题）', () => {
    for (const g of GROUP_META) {
      assert.ok(!g.title.includes('稍后'), `「${g.title}」又把三天外说成稍后了`);
    }
  });

  test('★ 三天外那一组要明确表达「在此之后」，而不是「还早」', () => {
    const title = titleOf('normal');
    assert.match(title, /以后|之后|以上|超过/, `「${title}」没有表达出「在此之后」的意思`);
  });

  test('★ 没有哪个标题用评价性说法淡化时间', () => {
    // 这些词都在暗示「不急」，而分组标题只该陈述离 DDL 多远
    const belittling = ['稍后', '不急', '还早', '有空再', '慢慢来', '随时'];
    for (const g of GROUP_META) {
      for (const word of belittling) {
        assert.ok(!g.title.includes(word), `「${g.title}」含淡化时间的说法「${word}」`);
      }
    }
  });
});

describe('分组结构本身', () => {
  test('分组顺序是从最紧急到最不紧急', () => {
    assert.deepEqual(
      GROUP_META.map((g) => g.key),
      ['overdue', 'urgent', 'soon', 'normal', 'none'],
    );
  });

  test('每个分组都有标题和配色', () => {
    for (const g of GROUP_META) {
      assert.ok(g.title, `${g.key} 缺标题`);
      assert.ok(g.tone, `${g.key} 缺配色`);
    }
  });

  test('每个分组都有说明文案（可以是空串，但不能是 undefined）', () => {
    for (const g of GROUP_META) {
      assert.equal(typeof g.hint, 'string', `${g.key} 的 hint 类型不对`);
    }
  });
});
