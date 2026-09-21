/**
 * 多用户：注册、重名、数据隔离、注销账号。
 *
 * 这一组测试的重心不是「功能能跑」，而是**隔离和删干净**这两件事：
 *   1. 用户名逐字节唯一，但**区分大小写**：`Alice` 和 `alice` 是两个账号（v9 起），
 *      登录必须原样拼对 —— 唯一性口径和 findUserByUsername 永远是同一个
 *   2. 一个人的数据不能被另一个人看见、不能被另一个人删掉
 *   3. 注销要真的删干净，包括两张**没有外键**的表
 *      （notify_log / settings）和磁盘上的课件 —— 漏了不会报错，
 *      现象只是「注销了，东西还在」
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-multiuser-test-'));
process.env.DATA_DIR = DATA_DIR;
// 邀请码必须在 config.js 被 import 之前设好（config 只在模块加载时读一次）
process.env.INVITE_CODE = 'dufe-test-code';
process.env.SCHEDULER_RUN_ON_START = 'false';

let auth;
let account;
let db;
let files;
let materials;
let pages;
let config;

before(async () => {
  auth = await import('../src/lib/auth.js');
  account = await import('../src/lib/account.js');
  db = await import('../src/db/index.js');
  files = await import('../src/lib/files.js');
  materials = await import('../src/lib/materials.js');
  pages = await import('../src/routes/pages.js');
  config = (await import('../src/config.js')).default;
  db.getDb(); // 建库 + 跑迁移
});

after(() => {
  // 用可选链：单跑某几个用例（--test-name-pattern）时 before 可能没执行过，
  // 那种情况下不该反过来再抛一个空指针异常盖住真正想看的结果
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 建一个测试账号，用户名带随机后缀避免和别的用例撞车 */
let seq = 0;
function makeUser(prefix = 'u') {
  seq += 1;
  return auth.createUser({
    username: `${prefix}${seq}_${Math.random().toString(36).slice(2, 8)}`,
    password: 'test123456',
    displayName: '测试用户',
  });
}

// ============================================================
// 用户名校验
// ============================================================

describe('用户名校验', () => {
  test('空的、只有空白的都不行', () => {
    assert.match(auth.usernameProblem(''), /请填写用户名/);
    assert.match(auth.usernameProblem('   '), /请填写用户名/);
    assert.match(auth.usernameProblem(null), /请填写用户名/);
  });

  test('太短太长都不行', () => {
    assert.match(auth.usernameProblem('a'), /至少 2 个字符/);
    assert.equal(auth.usernameProblem('ab'), '');
    assert.equal(auth.usernameProblem('a'.repeat(50)), '');
    assert.match(auth.usernameProblem('a'.repeat(51)), /太长/);
  });

  test('★ 换行和控制字符要被拒掉，而不是清洗后放行', () => {
    // 这些字符会窜进页面标题、CSV 导出和日志里。
    // 「清洗后放行」的问题是：用户以为自己叫 A，系统里存的却是 B。
    assert.match(auth.usernameProblem('小\n王'), /控制字符/);
    assert.match(auth.usernameProblem('小\t王'), /控制字符/);
    assert.match(auth.usernameProblem('小王\u0000'), /控制字符/);
  });

  test('中文、英文、带空格的名字都能用', () => {
    assert.equal(auth.usernameProblem('小王'), '');
    assert.equal(auth.usernameProblem('Zhang San'), '');
    // 用化名：这个仓库是公开的，别把真实姓名写进测试数据里
    // （这一行以前就是真实姓名 —— 等于自己给自己泄露身份）
    assert.equal(auth.usernameProblem('小明-2025'), '');
  });

  test('★ 首尾空格会被去掉（否则「 小王 」和「小王」会是两个账号）', () => {
    assert.equal(auth.normalizeUsername('  小王  '), '小王');
    assert.equal(auth.usernameProblem('  小王  '), '');
  });
});

describe('密码校验', () => {
  test('少于 8 位不行', () => {
    assert.match(auth.passwordProblem('1234567'), /至少 8 位/);
    assert.equal(auth.passwordProblem('12345678'), '');
  });

  test('★ 下限是从 auth.js 导出的常量，页面和脚本都取它', () => {
    // 这个数字以前散在五六个地方（auth.js、api.js、页面 minlength、
    // 前端校验、reset-password 脚本）。改了下限却漏掉一处，
    // 会出现「页面说要 8 位、服务端只查 6 位」这种不报错的错位。
    assert.equal(auth.PASSWORD_MIN_LENGTH, 8);
    assert.match(auth.passwordProblem('a'.repeat(auth.PASSWORD_MIN_LENGTH - 1)), /至少 8 位/);
    assert.equal(auth.passwordProblem('a'.repeat(auth.PASSWORD_MIN_LENGTH)), '');
  });

  test('超长密码被拒（scrypt 对超长输入很慢，是个廉价的拒绝服务面）', () => {
    assert.match(auth.passwordProblem('a'.repeat(201)), /太长/);
    assert.equal(auth.passwordProblem('a'.repeat(200)), '');
  });
});

// ============================================================
// 重名
// ============================================================

describe('用户名不能重名', () => {
  test('★ 完全相同的名字会被拒，而且给的是人话不是 SQL 原文', () => {
    const u = makeUser('dup');
    assert.throws(
      () => auth.createUser({ username: u.username, password: 'test123456' }),
      (err) => {
        assert.ok(err.message.includes(u.username), '错误信息里要说清是哪个名字');
        assert.ok(err.message.includes('已经有人用了'), `应该是人话，实际：${err.message}`);
        assert.ok(!/UNIQUE constraint/i.test(err.message), '不能把 SQL 报错原样抛给用户');
        return true;
      },
    );
  });

  test('★ 只差大小写**不**算重名：Alice 和 alice 是两个账号（v9 起）', () => {
    const u = makeUser('case');
    const upper = u.username.toUpperCase();

    // 用户名一律是小写字母 + 数字（见 makeUser），所以大写形式必然和原名不同
    assert.notEqual(upper, u.username, '前提：这两个名字确实只差大小写');
    assert.equal(auth.isUsernameTaken(upper), false, '大写形式应该是一个可用的新名字');
    assert.doesNotThrow(
      () => auth.createUser({ username: upper, password: 'test123456' }),
      'v9 之后只差大小写的用户名应该能注册成另一个账号',
    );
    // 两个账号各自查得到自己，不会串
    assert.equal(auth.findUserByUsername(u.username)?.id, u.id);
    assert.notEqual(auth.findUserByUsername(upper)?.id, u.id);
  });

  test('★ 逐字节相同才算重名；大小写必须原样拼对', () => {
    const u = makeUser('find');
    assert.equal(auth.findUserByUsername(u.username)?.id, u.id);
    // 大小写不同 → 找不到（登录会因此失败，这正是这一版要的行为）
    assert.equal(auth.findUserByUsername(u.username.toUpperCase()), undefined);
    // 首尾空格仍然不影响（normalizeUsername 会 trim，和大小写是两件事）
    assert.equal(auth.findUserByUsername(`  ${u.username}  `)?.id, u.id);
    assert.equal(auth.findUserByUsername('肯定不存在这个名字xyz'), undefined);
    assert.equal(auth.findUserByUsername(''), undefined);
  });

  test('★ 中文名不受大小写折叠影响，照常能建能登', () => {
    const name = `中文名${Math.random().toString(36).slice(2, 8)}`;
    const u = auth.createUser({ username: name, password: 'test123456' });
    assert.equal(auth.findUserByUsername(name)?.id, u.id);
  });
});

// ============================================================
// 注册闸门
// ============================================================

describe('邀请码', () => {
  test('★ 正确的邀请码才通过', () => {
    assert.equal(pages.inviteMatches('dufe-test-code'), true);
    assert.equal(pages.inviteMatches('  dufe-test-code  '), false, '不该顺手 trim，那会扩大匹配面');
    assert.equal(pages.inviteMatches('dufe-test-cod'), false);
    assert.equal(pages.inviteMatches('dufe-test-codex'), false, '前缀相同也必须拒绝');
    assert.equal(pages.inviteMatches('DUFE-TEST-CODE'), false, '邀请码区分大小写');
    assert.equal(pages.inviteMatches(''), false);
    assert.equal(pages.inviteMatches(null), false);
    assert.equal(pages.inviteMatches('中文邀请码'), false);
  });

  test('★ 配置里没有邀请码时，inviteMatches 一律不通过（不能变成「空码通行」）', () => {
    // 直接改配置对象模拟「没配 INVITE_CODE」
    const saved = config.inviteCode;
    config.inviteCode = '';
    try {
      assert.equal(pages.inviteMatches(''), false, '空邀请码不能让空输入通过');
      assert.equal(pages.inviteMatches('随便什么'), false);
    } finally {
      config.inviteCode = saved;
    }
  });

  test('★ 配了邀请码、且已经有账号时，注册要填码；第一个账号不用填', () => {
    // 这条用例运行时库里已经有账号了（前面的用例建的）
    const p = pages.registerPolicy();
    assert.equal(p.isFirst, false);
    assert.equal(p.open, true, '配了邀请码就开放注册');
    assert.equal(p.inviteRequired, true);
  });
});

// ============================================================
// 注销账号
// ============================================================

/** 给一个用户铺满各类数据，返回他名下的磁盘文件路径 */
async function seedUserData(userId) {
  const now = new Date();
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  db.run(
    'INSERT INTO terms (user_id, name, start_date, is_active) VALUES (?, ?, ?, 1)',
    userId, `测试学期${suffix}`, '2025-09-01',
  );
  const termId = db.scalar('SELECT id FROM terms WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);

  db.run(
    'INSERT INTO courses (user_id, term_id, name) VALUES (?, ?, ?)',
    userId, termId, `测试课程${suffix}`,
  );
  const courseId = db.scalar('SELECT id FROM courses WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);

  // 真的写一个文件到 uploads，再写两个派生产物到 cache
  //
  // 注意用 saved.relPath 而不是 saved.storedName：库里那一列存的是**相对路径**
  // （形如 2025/11/xxx.txt，带年月子目录），只取文件名会指向一个不存在的文件。
  // 这一段之所以非要 fs.existsSync 验一遍，就是因为字符串比对看不出来这个差别。
  const saved = await files.saveUpload(Buffer.from('测试课件内容', 'utf8'), '.txt');
  const originalPath = files.uploadPath(saved.relPath);
  const base = path.basename(saved.storedName, path.extname(saved.storedName));
  const slidesDir = materials.slidesDirFor(saved.storedName);
  await fsp.mkdir(slidesDir, { recursive: true });
  await fsp.writeFile(path.join(slidesDir, 'slide-1.png'), Buffer.from('fake png'));
  await fsp.mkdir(path.join(config.cacheDir, 'pdf'), { recursive: true });
  await fsp.writeFile(path.join(config.cacheDir, 'pdf', `${base}.pdf`), Buffer.from('fake pdf'));

  db.run(
    `INSERT INTO materials
       (user_id, course_id, title, original_name, stored_name, ext, kind, size,
        pdf_name, slides_dir, slide_count)
     VALUES (?, ?, ?, ?, ?, '.txt', 'text', ?, ?, ?, 1)`,
    userId, courseId, `测试课件${suffix}`, '课件.txt', saved.relPath, 6,
    `../cache/pdf/${base}.pdf`, `../cache/slides/${base}`,
  );

  db.run(
    'INSERT INTO assignments (user_id, course_id, title, due_at) VALUES (?, ?, ?, ?)',
    userId, courseId, `测试作业${suffix}`, '2030-01-01 23:59',
  );
  db.run(
    'INSERT INTO reminders (user_id, title, fire_at) VALUES (?, ?, ?)',
    userId, `测试提醒${suffix}`, '2030-01-01 20:00',
  );
  db.run(
    'INSERT INTO notify_channels (user_id, type, config) VALUES (?, ?, ?)',
    userId, 'bark', '{"key":"test"}',
  );
  db.run(
    "INSERT INTO settings (user_id, key, value) VALUES (?, 'daily_digest_enabled', '1')",
    userId,
  );
  db.run(
    "INSERT INTO notify_log (user_id, channel_type, title, ok) VALUES (?, 'bark', '测试', 1)",
    userId,
  );

  return {
    files: [
      originalPath,
      path.join(config.cacheDir, 'pdf', `${base}.pdf`),
      path.join(slidesDir, 'slide-1.png'),
    ],
  };
}

/** 数一遍某个用户名下各类数据的行数 */
function countAll(userId) {
  const out = {};
  for (const [table] of [['terms'], ['courses'], ['materials'], ['assignments'],
    ['reminders'], ['notify_channels'], ['notify_log'], ['settings']]) {
    out[table] = Number(db.scalar(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`, userId) || 0);
  }
  return out;
}

describe('注销账号', () => {
  test('★ collectUserFiles 找得到原件、PDF 和幻灯片图片（必须在删库之前调用）', async () => {
    const u = makeUser('files');
    const { files: onDisk } = await seedUserData(u.id);

    const collected = account.collectUserFiles(u.id);

    for (const p of onDisk) {
      assert.ok(collected.files.includes(p) || collected.dirs.includes(path.dirname(p)),
        `应该收得到 ${p}\n实际：${JSON.stringify(collected)}`);
    }
    // 真正去磁盘上确认一遍，不能只看字符串 ——
    // 「路径算对了」和「文件真的在那儿」是两件事，
    // uploads 里带年月子目录这一层就是只比字符串看不出来的。
    assert.ok(fs.existsSync(onDisk[0]), `原件应该真的在磁盘上：${onDisk[0]}`);
    assert.ok(fs.existsSync(onDisk[1]), `PDF 应该真的在磁盘上：${onDisk[1]}`);
    assert.ok(fs.existsSync(onDisk[2]), `幻灯片图片应该真的在磁盘上：${onDisk[2]}`);
  });

  test('★ 没有课件的用户不会伪造出路径', () => {
    const u = makeUser('empty');
    assert.deepEqual(account.collectUserFiles(u.id), { files: [], dirs: [] });
  });

  test('★ 注销会把每一张表都清干净，磁盘文件也删掉', async () => {
    const u = makeUser('del');
    const other = makeUser('keep');
    await seedUserData(u.id);
    await seedUserData(other.id);

    const before = countAll(u.id);
    for (const [table, n] of Object.entries(before)) {
      assert.ok(n > 0, `${table} 应该在删除前有数据（否则这条断言是空转的）`);
    }
    const otherBefore = countAll(other.id);

    const paths = account.collectUserFiles(u.id);
    const result = await account.deleteAccount(u.id);

    assert.equal(result.ok, true);
    assert.equal(result.username, u.username);
    assert.deepEqual(result.counts, before, '返回的行数应该和删除前数到的一致');

    // 该用户的行全没了
    assert.deepEqual(countAll(u.id), {
      terms: 0, courses: 0, materials: 0, assignments: 0,
      reminders: 0, notify_channels: 0, notify_log: 0, settings: 0,
    });
    assert.equal(auth.findUserByUsername(u.username), undefined);
    assert.equal(db.scalar('SELECT COUNT(*) FROM users WHERE id = ?', u.id), 0);

    // 磁盘上也真的没了
    for (const p of paths.files) {
      assert.equal(fs.existsSync(p), false, `文件应该被删掉：${p}`);
    }
    for (const d of paths.dirs) {
      assert.equal(fs.existsSync(d), false, `目录应该被删掉：${d}`);
    }

    // ★ 另一个人的数据一条都不能少（这是隔离的核心断言）
    assert.deepEqual(countAll(other.id), otherBefore, '另一个用户的数据不能被连累');
    assert.ok(auth.findUserByUsername(other.username), '另一个用户应该还能登录');
  });

  test('★ notify_log 和 settings 这两张没有外键的表也要清（级联管不到）', async () => {
    const u = makeUser('nofk');
    await seedUserData(u.id);

    assert.ok(Number(db.scalar('SELECT COUNT(*) FROM notify_log WHERE user_id = ?', u.id)) > 0);
    assert.ok(Number(db.scalar('SELECT COUNT(*) FROM settings WHERE user_id = ?', u.id)) > 0);

    await account.deleteAccount(u.id);

    assert.equal(Number(db.scalar('SELECT COUNT(*) FROM notify_log WHERE user_id = ?', u.id)), 0,
      '发送历史能还原出一个人的作息，注销后不能还留在库里');
    assert.equal(Number(db.scalar('SELECT COUNT(*) FROM settings WHERE user_id = ?', u.id)), 0);
  });

  test('★ 注销不存在（或已注销）的账号不会炸，也不会误删别人', async () => {
    const u = makeUser('twice');
    await seedUserData(u.id);

    assert.equal((await account.deleteAccount(u.id)).ok, true);
    const again = await account.deleteAccount(u.id);
    assert.equal(again.ok, false, '第二次应该如实报告「没这个人」');
    assert.equal(again.removedFiles, 0);

    const never = await account.deleteAccount(999_999_999);
    assert.equal(never.ok, false);
  });
});

// ============================================================
// 每日播报要发给每一个用户
// ============================================================

describe('每日播报是逐个用户的', () => {
  test('★ tick 会依次问过每个用户的设置，而不是只看 1 号', async () => {
    const { getSettings, setSettings } = await import('../src/lib/settings.js');
    const { runOnce } = await import('../src/lib/scheduler.js');

    const quiet = makeUser('quiet');  // 没开播报
    const noisy = makeUser('noisy');  // 开了播报

    setSettings(noisy.id, { daily_digest_enabled: '1', daily_digest_time: '00:00' });
    assert.equal(getSettings(quiet.id, { daily_digest_enabled: '0' }).daily_digest_enabled, '0');
    assert.equal(getSettings(noisy.id, {}).daily_digest_enabled, '1');

    const result = await runOnce();
    const details = result.digest.details;
    const ids = details.map((d) => d.userId);

    assert.ok(ids.includes(quiet.id), '安静的用户也要被问到（否则算不出「他没开」）');
    assert.ok(ids.includes(noisy.id), '开了播报的用户必须被轮到');

    const quietDetail = details.find((d) => d.userId === quiet.id);
    const noisyDetail = details.find((d) => d.userId === noisy.id);

    assert.equal(quietDetail.reason, '未开启每日播报');
    assert.notEqual(noisyDetail.reason, '未开启每日播报',
      '开了播报的人不该被判成「未开启」——那说明读的是别人的设置');
    assert.equal(result.digest.users, ids.length);

    await account.deleteAccount(quiet.id);
    await account.deleteAccount(noisy.id);
  });
});

// ============================================================
// 静态守卫
// ============================================================

describe('静态守卫（动态用例抓不到的那类）', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  /** 去掉注释，避免守卫被一段注释骗过去（这个坑踩过一次） */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('★ 新增「带 user_id 的表」必须同时写进 account.js，否则注销会漏数据', () => {
    const schema = read('src/db/schema.js');
    const accountSrc = read('src/lib/account.js');

    // 找出 SCHEMA_SQL 里所有 CREATE TABLE，再看哪些表带 user_id、哪些有外键级联
    const blocks = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)];
    assert.ok(blocks.length >= 8, `应该解析出足够多的表，实际 ${blocks.length}`);

    const perUser = blocks
      // 只算真的带 user_id 这一列的表（course_sessions 之类是靠 course_id 归属的）
      .filter(([, , body]) => /^\s*user_id\s/m.test(body))
      .map(([, name, body]) => ({
        name,
        // 建表时写了 user_id ... REFERENCES users(id) 的，删 users 那一行时数据库会级联清掉
        cascades: /user_id[^,]*REFERENCES\s+users\s*\(\s*id\s*\)/i.test(body),
      }))
      .filter((t) => t.name !== 'users'); // users 自己是被删的那一方

    assert.ok(perUser.length >= 6, `应该有不少于 6 张按用户分的表，实际 ${perUser.length}`);

    // 第一条：所有按用户分的表都要被清点，否则注销时连「删了多少行」都报不出来
    const unmentioned = perUser.filter((t) => !accountSrc.includes(`'${t.name}'`)).map((t) => t.name);
    assert.deepEqual(unmentioned, [], `这些表按用户分数据，但没写进 account.js 的 USER_TABLES：${unmentioned.join(', ')}`);

    // 第二条才是真正会丢数据的那一条：
    // 没有外键级联的表，deleteAccount 必须**显式** DELETE，否则注销之后
    // 这些行会永远留在库里 —— 不报错、不报错、也没有任何界面能看到它们。
    const noCascade = perUser.filter((t) => !t.cascades).map((t) => t.name);
    assert.ok(noCascade.length >= 2,
      `settings 和 notify_log 就是这一类，应该至少有两张，实际：${noCascade.join(', ') || '（一张都没有？那说明正则没匹配对）'}`);

    const notDeleted = noCascade.filter(
      (t) => !new RegExp(`DELETE\\s+FROM\\s+${t}\\s+WHERE\\s+user_id`, 'i').test(accountSrc),
    );
    assert.deepEqual(notDeleted, [],
      `这些表没有外键级联，注销时必须显式 DELETE：${notDeleted.join(', ')}\n`
      + '漏掉的现象是「注销了、数据还在」，不会有任何报错。');
  });

  test('★ 上面那个守卫真的能抓到漏掉（否则它形同虚设）', () => {
    const accountSrc = read('src/lib/account.js');

    // ① 漏写进 USER_TABLES
    assert.equal(accountSrc.includes("'pretend_new_table'"), false);
    // ② 漏写显式 DELETE
    assert.equal(/DELETE\s+FROM\s+notify_log\s+WHERE\s+user_id/i.test(accountSrc), true,
      'notify_log 目前是显式删的；这条为 true 才说明下面的正则形态是对的');
    assert.equal(/DELETE\s+FROM\s+pretend_new_table\s+WHERE\s+user_id/i.test(accountSrc), false);

    // ③ 正则本身得能认出来真实的建表语句形态，否则整条守卫是空转的
    const schema = read('src/db/schema.js');
    const withFk = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)]
      .filter(([, , body]) => /user_id[^,]*REFERENCES\s+users\s*\(\s*id\s*\)/i.test(body))
      .map(([, name]) => name);
    assert.ok(withFk.includes('materials'), 'materials 确实带外键，正则应该认出来');
    assert.ok(!withFk.includes('notify_log'), 'notify_log 确实没带外键，正则不该把它算进去');
    assert.ok(!withFk.includes('settings'), 'settings 也没带外键');
  });

  test('★ scheduler 不能把每日播报写死成某个用户', () => {
    const src = stripComments(read('src/lib/scheduler.js'));
    assert.equal(/maybeSendDailyDigest\(\s*\d+\s*\)/.test(src), false,
      'maybeSendDailyDigest 只接受用户 id 参数，写死数字就等于只有那一个人收得到播报');
    assert.ok(src.includes('SELECT id FROM users'), '应该遍历所有用户');
  });

  test('★ 守卫用的去注释逻辑本身是有效的（先验证工具再信结论）', () => {
    assert.equal(stripComments('maybeSendDailyDigest(1); // 这里无所谓'), 'maybeSendDailyDigest(1); ');
    assert.equal(stripComments('/* maybeSendDailyDigest(1); */ ok'), ' ok');
    assert.equal(stripComments('const a = 1; // x'), 'const a = 1; ');
  });
});
