/**
 * 课件「渲染路径」的测试。
 *
 * 用户问的是：「能不能让课件直接渲染出来，有没有什么办法」。
 * 查下来真正的原因分两层：
 *
 *   1. 我们自己的 PowerShell 脚本里，PowerPoint 的参数类型写错了
 *      （Visible 和 Open 的 WithWindow 都要 MsoTriState，不是布尔值），
 *      导致文件根本打不开。跟 Office 装没装无关。
 *
 *   2. 就算打得开，Office 导 PDF 还依赖打印管线；没有可用打印机的会话里
 *      PowerPoint 会直接崩。但同一份文件导出 PNG 是好的
 *      —— 所以加了一条「每页导出成图片」的路。
 *
 * 这个文件测的是第 2 条路带来的那些纯逻辑部分：
 * 预览方式的选择、路径派生、页数统计、以及数据库迁移能不能给老库补上新列。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-slides-test-'));
process.env.DATA_DIR = DATA_DIR;

let materials;
let config;
let schema;

before(async () => {
  materials = await import('../src/lib/materials.js');
  config = (await import('../src/config.js')).default;
  schema = await import('../src/db/schema.js');
});

describe('预览方式的选择', () => {
  const base = { kind: 'ppt', pdf_name: '', slides_dir: '' };

  test('★ 有 PDF 就用 PDF（可检索、单文件）', () => {
    assert.equal(materials.previewMode({ ...base, pdf_name: 'x.pdf' }), 'pdf');
  });

  test('★ 没有 PDF 但有幻灯片图片时走 slides', () => {
    assert.equal(materials.previewMode({ ...base, slides_dir: '../cache/slides/abc' }), 'slides');
  });

  test('★ PDF 优先于图片（两个都有时不该退而求其次）', () => {
    assert.equal(
      materials.previewMode({ ...base, pdf_name: 'x.pdf', slides_dir: '../cache/slides/abc' }),
      'pdf',
    );
  });

  test('★ 两个都没有时才是文字版预览', () => {
    assert.equal(materials.previewMode(base), 'office');
  });

  test('Word / Excel 不该被塞进 slides 模式', () => {
    assert.equal(materials.previewMode({ kind: 'word', pdf_name: '', slides_dir: '' }), 'office');
    assert.equal(materials.previewMode({ kind: 'excel', pdf_name: '', slides_dir: '' }), 'office');
  });

  test('其它类型不受影响', () => {
    assert.equal(materials.previewMode({ kind: 'image', pdf_name: '', slides_dir: '' }), 'image');
    assert.equal(materials.previewMode({ kind: 'video', pdf_name: '', slides_dir: '' }), 'video');
    assert.equal(materials.previewMode({ kind: 'text', pdf_name: '', slides_dir: '' }), 'text');
    assert.equal(materials.previewMode({ kind: 'other', pdf_name: '', slides_dir: '' }), 'none');
  });
});

describe('幻灯片图片目录', () => {
  test('★ 目录名由 stored_name 派生（重跑覆盖，不用额外记状态）', () => {
    const a = materials.slidesDirFor('2026/09/20260911-abc123.pptx');
    const b = materials.slidesDirFor('2026/09/20260911-abc123.pptx');
    assert.equal(a, b, '同一个文件应该派生出同一个目录');
    assert.ok(a.includes('abc123'), `目录名里应该带上文件 ID：${a}`);
    assert.ok(a.startsWith(config.cacheDir), '应该落在缓存目录下');
  });

  test('★ 不同文件派生出不同目录（否则会互相覆盖）', () => {
    const a = materials.slidesDirFor('2026/09/aaa.pptx');
    const b = materials.slidesDirFor('2026/09/bbb.pptx');
    assert.notEqual(a, b);
  });
});

describe('列出幻灯片图片', () => {
  // 注意：这里必须用 config.dataDir，不能自己拿 DATA_DIR 常量拼路径。
  //
  // 测试是 --test-isolation=none 跑的，所有测试文件共用一个进程，
  // config.js 只加载一次 —— 谁先 import 谁就决定了 dataDir。
  // 早先这里用自家常量拼，一旦别的测试文件先加载了 config，
  // 拼出来的路径就落在 data 目录外面，derivedPath 直接拒绝，
  // 而 listSlideImages 又把异常吞成空数组，于是表现为「找到 0 个文件」，
  // 看起来像功能坏了，其实是测试自己站错了地方。
  let dir;

  before(async () => {
    const cfg = (await import('../src/config.js')).default;
    dir = path.join(cfg.dataDir, 'fake-slides');

    fs.mkdirSync(dir, { recursive: true });
    // 故意写成乱序，并且混进不该被当成幻灯片的文件
    for (const n of [10, 2, 1, 3]) {
      fs.writeFileSync(path.join(dir, `slide-${n}.png`), 'x');
    }
    fs.writeFileSync(path.join(dir, 'thumb.png'), 'x');
    fs.writeFileSync(path.join(dir, 'slide-abc.png'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  });

  test('★ 只认 slide-N.png，别的文件一概不算', () => {
    const list = materials.listSlideImages({ slides_dir: dir });
    assert.equal(list.length, 4, `实际 ${list.length} 个：${list.map((p) => path.basename(p)).join(',')}`);
  });

  test('★ 按页码数字排序，而不是按字符串（否则 10 会排在 2 前面）', () => {
    const names = materials.listSlideImages({ slides_dir: dir }).map((p) => path.basename(p));
    assert.deepEqual(names, ['slide-1.png', 'slide-2.png', 'slide-3.png', 'slide-10.png']);
  });

  test('没有 slides_dir 时返回空数组，不抛异常', () => {
    assert.deepEqual(materials.listSlideImages({ slides_dir: '' }), []);
    assert.deepEqual(materials.listSlideImages({}), []);
  });

  test('目录不存在时返回空数组，不抛异常', () => {
    assert.deepEqual(materials.listSlideImages({ slides_dir: path.join(dir, '不存在') }), []);
  });

  test('★ 路径跑出数据目录时返回空数组（不把异常抛给页面）', () => {
    // 库里存的路径要是坏了，列表页不应该整页崩掉
    assert.deepEqual(materials.listSlideImages({ slides_dir: '../../../etc' }), []);
  });
});

describe('派生文件的路径解析', () => {
  let files;
  let cfg;

  before(async () => {
    files = await import('../src/lib/files.js');
    cfg = (await import('../src/config.js')).default;
  });

  test('★ 能解析出 uploads 目录以外的派生文件（PDF 就存在 cache 里）', () => {
    // 这正是「第二节 PPT 打不开」的根因：
    // pdf_name 存的是 '../cache/pdf/xxx.pdf'，用 uploadPath() 会直接抛异常
    const p = files.derivedPath('../cache/pdf/abc.pdf');
    assert.ok(p.startsWith(cfg.cacheDir), `应该落在 cache 目录里：${p}`);
    assert.ok(p.endsWith('abc.pdf'));
  });

  test('★ 上传文件的路径照样解析得了', () => {
    const p = files.derivedPath('2026/09/abc.pptx');
    assert.equal(p, path.join(cfg.uploadDir, '2026', '09', 'abc.pptx'));
  });

  test('★ 幻灯片图片目录也走这条路（和 PDF 保持一致）', () => {
    const p = files.derivedPath('../cache/slides/abc123');
    assert.ok(p.includes(path.join('cache', 'slides')));
  });

  test('★ 边界仍然守着：跑出数据目录的一律拒绝', () => {
    // uploads 和 cache 都在 data 下面，但再往上就不行了
    assert.throws(() => files.derivedPath('../../../etc/passwd'), /非法/);
    assert.throws(() => files.derivedPath('../../../../Windows/System32/config/SAM'), /非法/);
  });

  test('★ 数据目录本身（相对写法）不会被误判为越界', () => {
    assert.doesNotThrow(() => files.derivedPath('..'));
  });

  test('空路径要明确报错，而不是静默解析成目录', () => {
    assert.throws(() => files.derivedPath(''), /缺少文件路径/);
    assert.throws(() => files.derivedPath(null), /缺少文件路径/);
  });

  test('★ 和 uploadPath 的分工不能混（混用就是那个 bug）', () => {
    // 派生文件用 uploadPath 一定失败 —— 这正是要防住的回归
    assert.throws(() => files.uploadPath('../cache/pdf/abc.pdf'), /非法的存储路径/);
    // 而 derivedPath 对它没问题
    assert.doesNotThrow(() => files.derivedPath('../cache/pdf/abc.pdf'));
  });
});

describe('数据库迁移', () => {
  test('★ 迁移里给 materials 补上了 slides_dir 这一列', () => {
    assert.ok(Array.isArray(schema.MIGRATIONS[2]), 'v2 应该有迁移步骤');
    assert.equal(schema.SCHEMA_VERSION, 3);
  });

  test('★ v3：还停在旧默认色的课程被换成新主色，用户自己挑的颜色不动', () => {
    const file = path.join(DATA_DIR, 'colors.db');
    fs.rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE courses (id INTEGER PRIMARY KEY, color TEXT NOT NULL DEFAULT '')");
    const ins = db.prepare('INSERT INTO courses (color) VALUES (?)');
    ins.run('#4f7cff'); // 应用自己的旧默认值 —— 要换掉
    ins.run('#10a86a'); // 用户手动挑的绿色 —— 一个字都不能改
    ins.run('#3a63e8'); // 已经是新主色 —— 保持原样

    const { changes } = schema.MIGRATIONS[3][0](db);

    assert.equal(changes, 1, '只应该动那一行旧默认色');
    const got = db.prepare('SELECT color FROM courses ORDER BY id').all().map((r) => r.color);
    assert.deepEqual(got, ['#3a63e8', '#10a86a', '#3a63e8'],
      '课表色块和课程卡顶条全靠这个字段，洗错颜色就是改用户数据');
    db.close();
  });

  test('★ v3 可以重跑：第二遍影响 0 行（迁移中途失败重跑是常态）', () => {
    const db = new DatabaseSync(path.join(DATA_DIR, 'colors.db'));
    const { changes } = schema.MIGRATIONS[3][0](db);
    assert.equal(changes, 0, '幂等：旧默认色已经被换过一次了，不该再匹配到任何行');
    db.close();
  });

  test('★ 新建课程用的默认色和迁移后的颜色是同一个', () => {
    // 两边写的是同一份字面量就容易漂移，这里钉住它们必须一致
    assert.equal(schema.DEFAULT_COURSE_COLOR, '#3a63e8');
  });

  test('★ 全新数据库建出来就带 slides_dir', async () => {
    const { getDb } = await import('../src/db/index.js');
    const cols = getDb().prepare('PRAGMA table_info(materials)').all();
    assert.ok(cols.some((c) => c.name === 'slides_dir'), '新建的库应该直接有这一列');
  });

  test('★ 老库能就地补上这一列（这是迁移真正要解决的问题）', () => {
    // 手工造一个「还没有 slides_dir」的 v1 库
    const legacy = path.join(DATA_DIR, 'legacy.db');
    fs.rmSync(legacy, { force: true });
    const db = new DatabaseSync(legacy);
    db.exec('CREATE TABLE materials (id INTEGER PRIMARY KEY, pdf_name TEXT NOT NULL DEFAULT \'\')');
    db.exec('PRAGMA user_version = 1');

    // 模拟老库升级：跑 v2 的迁移步骤
    for (const step of schema.MIGRATIONS[2]) step(db);

    const cols = db.prepare('PRAGMA table_info(materials)').all();
    assert.ok(cols.some((c) => c.name === 'slides_dir'),
      '老库应该被补上这一列，否则预览查询会因为缺列直接报错');
    db.close();
  });

  test('★ 迁移是幂等的：重复跑不会因为「列已存在」而炸', () => {
    const db = new DatabaseSync(path.join(DATA_DIR, 'legacy.db'));
    assert.doesNotThrow(() => {
      for (const step of schema.MIGRATIONS[2]) step(db);
      for (const step of schema.MIGRATIONS[2]) step(db);
    }, '重复执行迁移应该安全 —— 中途失败重跑是常见情况');
    db.close();
  });

  test('addColumnIfMissing 只在缺的时候动手', () => {
    const db = new DatabaseSync(path.join(DATA_DIR, 'legacy.db'));
    assert.equal(
      schema.addColumnIfMissing(db, 'materials', 'slides_dir', "TEXT NOT NULL DEFAULT ''"),
      false,
      '已经有了就不该再加',
    );
    assert.equal(
      schema.addColumnIfMissing(db, 'materials', 'brand_new', "TEXT NOT NULL DEFAULT ''"),
      true,
      '缺的应该补上',
    );
    db.close();
  });
});
