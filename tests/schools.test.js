/**
 * 高校名单。
 *
 * 这份名单不是「锦上添花的自动补全」—— 它是校友社区**唯一**的可见性边界：
 * 「同校」= 两个人的 school 字符串精确相等。所以：
 *   · 名单漏了一所学校 → 那所学校的学生注册不了 / 进不了社区；
 *   · 匹配写成模糊的 → 「北大」和「北京大学」被当成两所学校（或反过来，
 *     把不同学校当成同校），而后者意味着**有人能看到本不该看到的资料**；
 *   · 名字里混进空行或重复 → 按名字反查会有歧义。
 *
 * 数据是 scripts/build-schools.js 从 xlsx 生成的，这里守的是生成结果的质量。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const {
  SCHOOL_NAMES, SCHOOL_COUNT, isKnownSchool, schoolPlace,
} = await import('../src/data/schools.js');

describe('★ 名单本身的质量', () => {
  test('★ 数量对得上（源表 3057 行，去掉 44 条重复）', () => {
    assert.equal(SCHOOL_COUNT, SCHOOL_NAMES.length);
    // 给一个宽区间：学校会增减，但绝不该掉到 2500 以下（那说明生成时丢了一大截）
    assert.ok(SCHOOL_COUNT > 2500 && SCHOOL_COUNT < 4000,
      `学校数 ${SCHOOL_COUNT} 不在合理区间内`);
  });

  test('★ 没有空名字、没有重复名字', () => {
    const empty = SCHOOL_NAMES.filter((n) => !n || !n.trim());
    assert.deepEqual(empty, [], '名单里有空名字');
    const dup = SCHOOL_NAMES.filter((n, i) => SCHOOL_NAMES.indexOf(n) !== i);
    assert.deepEqual([...new Set(dup)], [],
      '★ 有重复校名 —— 按名字反查会变成"随便命中一个"，同校判断就不可靠了');
  });

  test('★ 名字里没有换行或制表符（打包格式的分隔符，混进去会切错列）', () => {
    const bad = SCHOOL_NAMES.filter((n) => /[\n\r\t]/.test(n));
    assert.deepEqual(bad, [], '校名里有控制字符，会把打包数据切错');
  });

  test('能被找到的学校确实在名单里', () => {
    for (const name of ['北京大学', '清华大学', '东北财经大学', '复旦大学']) {
      assert.ok(isKnownSchool(name), `${name} 不在名单里`);
    }
  });

  test('★ 手填的假学校会被挡住（这就是这一条的意义）', () => {
    // ⚠️ 注意 `'北京大学 '`（带空格）**不在**这个列表里 ——
    // 实现里会 trim，所以它应该被认成有效校名。第一版把它当成了假名字，
    // 和下面那条「前后空格会被容忍」自相矛盾，两条测试里必有一条是错的。
    for (const fake of ['家里蹲大学', '北大', '', '   ', null, undefined, '哈哈哈', '北京大学光华管理学院']) {
      assert.equal(isKnownSchool(fake), false, `「${fake}」不该被认为是名单里的学校`);
    }
  });

  test('前后空格会被容忍（用户复制粘贴常带空格）', () => {
    assert.equal(isKnownSchool('  北京大学  '), true, '前后空格应该被 trim 掉');
  });

  test('学校所在地查得到，查不到时给空串而不是 undefined', () => {
    assert.match(schoolPlace('东北财经大学'), /辽宁/);
    assert.equal(schoolPlace('家里蹲大学'), '');
    assert.equal(schoolPlace(''), '');
  });

  test('★ 按拼音序（补全时同前缀的学校要挨在一起）', () => {
    const sample = SCHOOL_NAMES.slice(0, 50);
    const sorted = [...sample].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    assert.deepEqual(sample, sorted, '前 50 个不是有序的 —— 补全的体验会变差');
  });
});

describe('★ 生成脚本', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/build-schools.js'), 'utf8');

  test('★ 脚本里没有把 xlsx 的内容硬编码进来（数据只能来自那个文件）', () => {
    // ⚠️ 匹配前必须去注释：第一版这里被自己的注释骗了 ——
    // 脚本里有一句注释写着「「北大」和「北京大学」算不算同校？」，
    // 于是断言直接命中注释、永远为真。这个坑项目里踩过好几次了。
    const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/北京大学|东北财经大学/.test(code), '脚本里出现了具体校名，说明硬编码了');
  });

  test('★ xlsx 是输入、不入库（生成出来的模块才入库）', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\/\*\.xlsx$/m, 'xlsx 没被忽略，名单源文件会被提交进去');
  });

  test('生成的数据文件入库（运行时要用它）', () => {
    assert.ok(fs.existsSync(path.join(root, 'src/data/schools.js')));
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.ok(!/schools\.js/.test(ignore), '生成的数据文件被忽略了，线上会跑不起来');
  });
});
