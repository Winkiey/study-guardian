/**
 * 资料分类。
 *
 * 用户要的分类是：课件 / 讲义 / 作业 / 试卷 / 资料 / 教材 / 其他。
 *
 * 改这个的时候发现旧代码里这份清单**写了三遍**（lib 里一份、资料库页的
 * 筛选标签一份、上传和编辑表单的下拉框各一份），而且已经走散了：
 * 「教材」只在 lib 那一份里有 —— 于是出现「老数据显示成教材，
 * 但下拉框选不了、标签也筛不出来」这种半截状态，而且不报任何错。
 *
 * 所以这里的重点不是「七个分类对不对」，而是**它只能有一份**：
 * 加一个分类时，标签页、两个下拉框必须自动跟上，不靠人记得改三处。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-category-test-'));
process.env.DATA_DIR = DATA_DIR;

let m;
let db;

before(async () => {
  m = await import('../src/lib/materials.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('分类清单', () => {
  test('★ 就是用户要的那七个，顺序也一样', () => {
    assert.deepEqual(
      m.MATERIAL_CATEGORIES.map((c) => c.label),
      ['课件', '讲义', '作业', '试卷', '资料', '教材', '其他'],
    );
  });

  test('★ key 都是稳定的英文短名，没有空格和大写（要进 URL 和数据库）', () => {
    for (const c of m.MATERIAL_CATEGORIES) {
      assert.match(c.key, /^[a-z][a-z0-9_]*$/, `分类 key 不合规：${c.key}`);
    }
  });

  test('★ key 不重复（重复了会让两份资料显示成同一类）', () => {
    const keys = m.MATERIAL_CATEGORIES.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length, `有重复的 key：${keys.join(', ')}`);
  });

  test('默认分类必须在清单里（否则表单预选一个不存在的值）', () => {
    assert.ok(m.isKnownCategory(m.DEFAULT_MATERIAL_CATEGORY));
    assert.equal(m.DEFAULT_MATERIAL_CATEGORY, 'courseware');
  });
});

describe('分类的中文名', () => {
  test('认识的 key 给出中文名', () => {
    assert.equal(m.categoryLabel('courseware'), '课件');
    assert.equal(m.categoryLabel('handout'), '讲义');
    assert.equal(m.categoryLabel('book'), '教材');
  });

  test('★ 空值说「未分类」，不能混进「其他」', () => {
    // 「其他」是用户主动选的，「未分类」是还没选 —— 混在一起会让用户
    // 以为是自己选错了，而去翻一遍自己到底选了什么
    for (const empty of ['', '   ', null, undefined]) {
      assert.equal(m.categoryLabel(empty), '未分类', `输入 ${JSON.stringify(empty)}`);
    }
  });

  test('★ 认不出的值原样显示，不要谎称它属于某一类', () => {
    assert.equal(m.categoryLabel('legacy_thing'), 'legacy_thing');
  });

  test('isKnownCategory 只认清单里的', () => {
    assert.equal(m.isKnownCategory('exam'), true);
    assert.equal(m.isKnownCategory('exam '), true, '首尾空格要容忍');
    assert.equal(m.isKnownCategory(''), false);
    assert.equal(m.isKnownCategory('nope'), false);
    assert.equal(m.isKnownCategory(null), false);
    // 原型链上的东西不能被当成合法分类
    assert.equal(m.isKnownCategory('constructor'), false);
    assert.equal(m.isKnownCategory('toString'), false);
  });
});

// ============================================================
// 静态守卫：这三个地方必须从那一份清单生成
//
// 这些守卫看着啰嗦，但它们防的正是「已经发生过一次」的事：
// 有人在一个地方加了新分类，另外两个地方忘了加。
// ============================================================

describe('★ 分类清单只能有一份', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('★ 资料库页的筛选标签从 MATERIAL_CATEGORIES 生成，不再手写', () => {
    const src = read('src/web/pages/materials.js');
    assert.match(src, /\.\.\.MATERIAL_CATEGORIES\.map/, '标签页应该从清单展开');
    // 手写的话会出现诸如 `{ value: 'courseware', label: '课件' }` 这种字面量
    assert.ok(!/value:\s*'courseware'\s*,\s*label/.test(src),
      '不要在这里再抄一份分类清单');
  });

  test('★ 上传 / 编辑表单的下拉框也从清单生成', () => {
    const src = read('src/web/pages/materials.js');
    assert.match(src, /categoryOptions\(/, '两个下拉框都应该用 categoryOptions()');
    assert.ok(!/<option value="courseware">/.test(src),
      '不要手写下拉框选项 —— 以前就是这样漏掉「教材」的');
  });

  test('★ 标签页的数字按分类统计，不是按文件类型', () => {
    const src = read('src/web/pages/materials.js');
    assert.match(src, /stats\.byCategory/, '标签数字要用 byCategory');
    assert.ok(!/stats\.byKind\.find/.test(src),
      'byKind 是文件类型（ppt/pdf/…），拿它比分类键永远匹配不上，数字一个都不会显示');
  });

  test('★ materialStats 必须同时给出 byCategory', async () => {
    const stats = m.materialStats(999_999);
    assert.ok(Array.isArray(stats.byCategory), 'materialStats 要返回 byCategory');
    assert.ok(Array.isArray(stats.byKind), 'byKind 也得留着（别的地方在用）');
  });
});

describe('★ 写入时校验分类', () => {
  test('每个合法分类都能存进去，读回来的中文名对得上', async () => {
    const auth = await import('../src/lib/auth.js');
    const u = auth.createUser({ username: `分类测试${Date.now()}`, password: 'test123456' });

    for (const c of m.MATERIAL_CATEGORIES) {
      // eslint-disable-next-line no-await-in-loop
      const row = await m.createMaterialFromUpload(
        u.id,
        { filename: `${c.key}.txt`, mime: 'text/plain', data: Buffer.from('x') },
        { category: c.key },
      );
      assert.equal(row.category, c.key, `${c.key} 应该被原样存下来`);
      assert.equal(m.getMaterial(u.id, row.id).categoryLabel, c.label);
    }
  });

  test('★ 分类筛选能查出对应的资料', async () => {
    const auth = await import('../src/lib/auth.js');
    const u = auth.createUser({ username: `筛选测试${Date.now()}`, password: 'test123456' });

    for (const [key, n] of [['handout', 2], ['exam', 1]]) {
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await m.createMaterialFromUpload(
          u.id,
          { filename: `${key}${i}.txt`, mime: 'text/plain', data: Buffer.from('x') },
          { category: key },
        );
      }
    }

    assert.equal(m.listMaterials(u.id, { category: 'handout' }).length, 2);
    assert.equal(m.listMaterials(u.id, { category: 'exam' }).length, 1);
    assert.equal(m.listMaterials(u.id, { category: 'book' }).length, 0);

    // 顶部标签上的数字，必须和筛出来的条数一致
    const stats = m.materialStats(u.id);
    const countOf = (key) => stats.byCategory.find((r) => r.category === key)?.count || 0;
    assert.equal(countOf('handout'), 2, '标签上的数字要和实际条数一致');
    assert.equal(countOf('exam'), 1);
  });
});
