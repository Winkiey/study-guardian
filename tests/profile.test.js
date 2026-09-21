/**
 * 个人资料的校验与保存。
 *
 * 这一组的核心只有一件事：**学校必须在名单里**。
 * 它不是「顺手校验一下」—— 校友社区里「同校」是唯一的可见性边界，
 * 学校字符串就是那个边界的全部依据。允许手填，就等于允许任何人写
 * 「北京大学」，然后看到北大同学公开的资料。
 *
 * 另外这里还修掉一个真 bug：以前「称呼」和「学校」既存在于 users 表、
 * 又存在于 settings 表，而设置页上那两个输入框其实是**死的** ——
 * 前端把它们 skip 掉（注释写着"走用户资料接口"），可那个接口根本不存在。
 * 所以有断言专门盯着「这两个键不许再回到 SETTING_DEFS 里」。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-profile-test-'));
process.env.DATA_DIR = DATA_DIR;

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let auth;
let db;

before(async () => {
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;
const newUser = (extra = {}) => auth.createUser({
  username: `p${(seq += 1)}_${Math.random().toString(36).slice(2, 7)}`,
  password: 'test123456',
  ...extra,
});

const KNOWN = '东北财经大学';

describe('★ 学校必须来自名单', () => {
  test('★ 名单里的学校能过', () => {
    const p = auth.normalizeProfile({ displayName: '小王', school: KNOWN });
    assert.equal(p.school, KNOWN);
  });

  test('★ 名单外的学校被拒绝，而且说清为什么', () => {
    assert.throws(
      () => auth.normalizeProfile({ school: '家里蹲大学' }),
      (err) => /不在学校名单里/.test(err.message) && /找不到同学/.test(err.message),
      '拒绝的理由要能让人看懂，不能只说"参数错误"',
    );
  });

  test('★ 差一个字也不行（「北大」不是「北京大学」）', () => {
    // 这条正是名单方案的意义：模糊匹配会让「北大」和「北京大学」变成
    // 两所学校（或者反过来把不同学校当成同校）—— 后者意味着有人能看到
    // 本不该看到的资料。所以只认精确相等。
    assert.throws(() => auth.normalizeProfile({ school: '北大' }), /不在学校名单里/);
    assert.throws(() => auth.normalizeProfile({ school: '北京大学光华管理学院' }), /不在学校名单里/,
      '带后缀的学院名也不算 —— 只认校名本身');
    // ⚠️ 但前后空格**会被 trim 掉**，所以 `'北京大学 '` 是有效校名、不该抛错。
    //    第一版这里断言它抛错，和另一条「前后空格和中间多余空白会被规范化」
    //    直接矛盾 —— 两条测试里必有一条是错的。
    assert.equal(auth.normalizeProfile({ school: ' 北京大学 ' }).school, '北京大学');
  });

  test('前后空格和中间多余空白会被规范化', () => {
    const p = auth.normalizeProfile({ school: `  ${KNOWN}  `, displayName: '小  王' });
    assert.equal(p.school, KNOWN);
    assert.equal(p.displayName, '小 王', '连续空白要压成一个');
  });

  test('★ 空学校是允许的（注册选填），但不参与社区', () => {
    const p = auth.normalizeProfile({ displayName: '小王' });
    assert.equal(p.school, '');
    assert.equal(auth.schoolIsVerified(p.school), false,
      '空学校不能被当成"已验证"，否则所有没填学校的人都会互相看见');
  });

  test('★ 注册时不许有默认学校', () => {
    // 以前 register 里写的是 `school: ... || '东北财经大学'` —— 不填学校的人
    // 会被静默安上这个默认值，于是所有没填的人都成了「同校」，
    // 按学校分组就完全失去意义了。
    //
    // ⚠️ 匹配前**必须去注释**：我在修这个 bug 时写了一句注释说明"以前写的是
    //    `|| '东北财经大学'`"，那句话里就带着要禁掉的字符串 ——
    //    第一版断言直接命中注释、永远为真。这个坑这一轮我已经踩了第三次了。
    const pages = read('src/routes/pages.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\|\|\s*'东北财经大学'/.test(pages),
      '★ 又出现默认学校了 —— 那会让所有没填学校的人变成同校');
  });
});

describe('★ 学院 / 专业是自由填写', () => {
  test('不校验内容（学校名单管不到院系），但有长度上限', () => {
    const p = auth.normalizeProfile({ college: '金融科技学院', major: '金融科技' });
    assert.equal(p.college, '金融科技学院');
    assert.equal(p.major, '金融科技');
    // 这些字会显示给别人看，不设上限的话有人能拿它刷屏
    assert.throws(() => auth.normalizeProfile({ college: '很'.repeat(41) }), /学院不能超过/);
    assert.throws(() => auth.normalizeProfile({ major: '很'.repeat(41) }), /专业不能超过/);
    assert.throws(() => auth.normalizeProfile({ displayName: '很'.repeat(25) }), /昵称不能超过/);
  });

  test('空值给空串，不是 undefined（模板里到处拼字符串）', () => {
    const p = auth.normalizeProfile({});
    assert.deepEqual(p, { displayName: '', school: '', college: '', major: '' });
  });
});

describe('★ 写库', () => {
  test('★ updateProfile 真的写进 users 表', () => {
    const u = newUser();
    auth.updateProfile(u.id, {
      displayName: '小王', school: KNOWN, college: '金融科技学院', major: '金融科技',
    });
    const row = db.get(
      'SELECT display_name, school, college, major FROM users WHERE id = ?', u.id,
    );
    assert.equal(row.display_name, '小王');
    assert.equal(row.school, KNOWN);
    assert.equal(row.college, '金融科技学院');
    assert.equal(row.major, '金融科技');
  });

  test('★ 校验失败时一个字都不写（不能写一半）', () => {
    const u = newUser();
    auth.updateProfile(u.id, { displayName: '原来的名字' });
    assert.throws(() => auth.updateProfile(u.id, { displayName: '新名字', school: '家里蹲大学' }));
    const row = db.get('SELECT display_name, school FROM users WHERE id = ?', u.id);
    assert.equal(row.display_name, '原来的名字', '★ 校验失败却把昵称写进去了');
    assert.equal(row.school, '');
  });

  test('★ 注册时能直接带上学院和专业', () => {
    const u = newUser({ school: KNOWN, college: '统计学院', major: '统计学' });
    assert.equal(u.school, KNOWN);
    assert.equal(u.college, '统计学院');
    assert.equal(u.major, '统计学');
  });

  test('★ 只影响自己（不能改到别人的资料）', () => {
    const a = newUser({ displayName: '甲' });
    const b = newUser({ displayName: '乙' });
    auth.updateProfile(a.id, { displayName: '甲改了' });
    assert.equal(db.get('SELECT display_name FROM users WHERE id = ?', b.id).display_name, '乙');
  });
});

describe('★ 老账号的学校不能被删掉', () => {
  test('★ 手填的旧学校保留着，只是标记成「未从名单选择」', () => {
    // 用户自己填过的值不能因为"对不上名单"就被代码清掉。
    // 做法是只做标记：页面上提示重选，重选之前不参与社区。
    const u = newUser({ school: '某某学院（旧版手填）' });
    const row = db.get('SELECT school FROM users WHERE id = ?', u.id);
    assert.equal(row.school, '某某学院（旧版手填）', '旧值被清掉了');
    assert.equal(auth.schoolIsVerified(row.school), false, '它不该被当成已验证的学校');
  });

  test('迁移只加列，不动已有数据', async () => {
    const { MIGRATIONS } = await import('../src/db/schema.js');
    const v6 = MIGRATIONS[6];
    assert.ok(v6, '缺少 v6 迁移');
    assert.equal(v6.length, 2, 'v6 应该给 college / major 各加一列');
    const code = v6.map((f) => f.toString()).join('\n');
    assert.ok(!/UPDATE|DELETE/i.test(code),
      '★ v6 迁移里出现了 UPDATE/DELETE —— 老账号的学校可能被改动');
  });
});

describe('★ 那两个死掉的设置项不许回来', () => {
  test('★ SETTING_DEFS 里不再有 display_name / school', () => {
    const settings = read('src/lib/settings.js');
    const defs = settings.slice(settings.indexOf('SETTING_DEFS'), settings.indexOf('];', settings.indexOf('SETTING_DEFS')));
    assert.ok(!/key:\s*'display_name'/.test(defs),
      '★ display_name 回到设置里了 —— 它和 users 表里的值是两份状态，谁是真的说不清');
    assert.ok(!/key:\s*'school'/.test(defs),
      '★ school 回到设置里了 —— 同上');
  });

  test('★ 前端不再需要 skip 这两个键', () => {
    const app = read('src/web/public/app.js');
    assert.ok(!/continue; \/\/ 这两项走用户资料接口/.test(app),
      '★ 那句注释对应的"用户资料接口"以前根本不存在，现在有了 /api/profile，'
      + '设置表单也不该再出现这两个键');
  });

  test('★ 设置页不再渲染「仅用于展示」的学校说明（那是旧文案）', () => {
    const settings = read('src/lib/settings.js');
    assert.ok(!/仅用于展示/.test(settings),
      '旧文案还在：学校现在不只是展示，它是社区的分组依据');
  });
});
