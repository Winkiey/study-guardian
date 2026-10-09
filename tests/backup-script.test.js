/**
 * 备份脚本。
 *
 * 备份这种东西最坑的地方是：**它平时永远不会报错**。
 * 你会一直以为有备份，直到需要它的那一天才发现里面是个空库 ——
 * 而那一天通常也是数据已经没了的那一天。
 *
 * 所以这个文件里，重点不在"能不能打出备份"，而在三件事：
 *   1. 数据库那一份必须是 `VACUUM INTO` 出来的（WAL 模式下直接拷 app.db
 *      会得到几乎空的库，这个坑项目里真实踩过）；
 *   2. 备份完要**把备份打开数一遍**，对不上就以非 0 退出；
 *   3. `--status` 能回答"到底有没有在跑" —— 这是用户的原话（"确认备份是否真在跑"）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-backup-test-'));
const DATA_DIR = path.join(TMP, 'data');
const BACKUP_DIR = path.join(TMP, 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * ⚠️⚠️ 这一行必须在这里，**在所有 import 之前**。
 *
 * 第一版漏了它，于是 seedDb() 里那几个 `import('../src/lib/...')` 用的是
 * **默认的 data 目录** —— 也就是项目根目录下那个真的数据目录。
 * 结果我往里面写了一个账号、一门课、一份资料、两个作业。
 *
 * （那是开发机上的本地库，不是服务器上的生产库。发现之后按用户名精确匹配
 *   删掉了那一行，级联把其余几行一起带走，核对过用户的真实数据没动。）
 *
 * 任何"会写库"的测试都必须先把 DATA_DIR 指到临时目录 —— 这是这个项目里
 * 每写一个测试文件都要做的一件事，漏了的后果不是测试失败，而是**污染真数据**。
 */
process.env.DATA_DIR = DATA_DIR;

/** 再上一道锁：数据目录必须落在本次的临时目录里，否则宁可让整个文件失败 */
function assertSandboxed() {
  const resolved = path.resolve(process.env.DATA_DIR);
  if (!resolved.startsWith(path.resolve(TMP))) {
    throw new Error(`测试的数据目录跑到临时目录外面去了：${resolved}`);
  }
}


/** 跑脚本：输出写进文件（这个沙箱里管道不可靠），返回退出码和输出 */
function runBackup(args = []) {
  const logPath = path.join(TMP, `log-${Math.random().toString(36).slice(2)}.txt`);
  const fd = fs.openSync(logPath, 'w');
  const res = spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: root,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, DATA_DIR, BACKUP_DIR },
  });
  fs.closeSync(fd);
  return { code: res.status, out: fs.readFileSync(logPath, 'utf8') };
}

function backupDirs() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  // ⚠️ 后缀是必须的：同一秒内跑两次会撞名，脚本会加 -2、-3。
  //    这里如果只匹配不带后缀的名字，同一秒里的第二份就会被漏掉 ——
  //    （第一版就是这样，于是 --with-files 和 --keep 两条都莫名其妙地红了。）
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/.test(n)).sort();
}

/** 造一个"有内容"的数据库：一个账号、一门课、一份资料、一个作业、一场考试 */
async function seedDb() {
  assertSandboxed();
  const auth = await import('../src/lib/auth.js');
  const courses = await import('../src/lib/courses.js');
  const asg = await import('../src/lib/assignments.js');
  const db = await import('../src/db/index.js');
  db.getDb();
  // 真的确认一下：临时目录里出现了 app.db。
  // （别写 db.getDb().location —— 那是个**方法**不是字符串，
  //   path.resolve(它) 会直接抛错；也别写 `|| true`，那等于没检查。）
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'app.db')),
    '★ 数据库没落在临时目录里 —— 这一条要是红了，说明要污染真数据了');
  const u = auth.createUser({ username: `bk${Date.now() % 100000}`, password: 'test123456' });
  const termId = courses.createTerm(u.id, { name: '备份测试学期', startDate: '2026-03-02', weekCount: 18 });
  const courseId = courses.createCourse(u.id, { name: '备份测试课', termId });
  db.run(
    `INSERT INTO materials (user_id, course_id, title, original_name, stored_name)
     VALUES (?, ?, '备份测试资料', 'a.txt', 'a.txt')`,
    u.id, courseId,
  );
  asg.createAssignment(u.id, { title: '备份测试作业', dueAt: '2027-01-01 23:59' });
  asg.createAssignment(u.id, { title: '备份测试考试', kind: 'exam', dueAt: '2027-01-02 14:00' });

  /*
   * ⚠️⚠️ 这里**故意不 closeDb()**。
   *
   * 第一版关了，于是这个文件根本测不出它最该测的那件事：
   * SQLite 在**正常关闭**时会把 WAL 里的内容回写到 app.db（checkpoint），
   * 关干净之后直接 `cp app.db` 也是完整的。
   *
   * 但生产环境不是这样：服务一直开着，数据就在 `app.db-wal` 里，
   * `app.db` 可能只有几 KB。所以备份必须用 VACUUM INTO。
   *
   * 保持连接打开，就等于模拟"服务正在跑" —— 这时候拷文件才会露馅。
   * （这一条是反向验证抓出来的：把 VACUUM INTO 换成 copyFileSync，
   *   测试居然全绿，说明它压根没覆盖到 WAL 那个坑。）
   */
  return u.id;
}

before(async () => {
  // 先把库建出来（脚本要求 app.db 存在）
  await seedDb();
});

after(async () => {
  const db = await import('../src/db/index.js');
  db?.closeDb?.();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('★ 备份本身', () => {
  test('★ 没有数据库时明确报错，不是默默成功', () => {
    const emptyDir = path.join(TMP, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const logPath = path.join(TMP, 'log-empty.txt');
    const fd = fs.openSync(logPath, 'w');
    const res = spawnSync(process.execPath, ['scripts/backup.mjs'], {
      cwd: root, stdio: ['ignore', fd, fd],
      env: { ...process.env, DATA_DIR: emptyDir, BACKUP_DIR: path.join(TMP, 'b-empty') },
    });
    fs.closeSync(fd);
    assert.notEqual(res.status, 0, '找不到库却退出了 0 —— 这种备份最危险');
    assert.ok(/找不到数据库/.test(fs.readFileSync(logPath, 'utf8')));
  });

  test('★★ 备份出来的数据库是**完整**的（不是一个空壳）', async () => {
    const { code, out } = runBackup();
    assert.equal(code, 0, `备份应该成功：\n${out}`);

    const dirs = backupDirs();
    assert.equal(dirs.length, 1, `应该有 1 份备份，实际 ${dirs.length}`);
    const dir = path.join(BACKUP_DIR, dirs[0]);

    // 数据库文件在
    const dbPath = path.join(dir, 'app.db');
    assert.ok(fs.existsSync(dbPath), '备份目录里没有 app.db');

    // ★ 最关键的一条：把备份**打开**，数一遍。
    //   WAL 那个坑的症状就是"文件在、但是空的" —— 所以必须真的打开数。
    const { DatabaseSync } = await import('node:sqlite');
    const check = new DatabaseSync(dbPath);
    try {
      const n = (sql) => Number(check.prepare(sql).get().n);
      assert.ok(n('SELECT COUNT(*) n FROM users') > 0, '★ 备份里的 users 是空的');
      assert.ok(n('SELECT COUNT(*) n FROM courses') > 0, '★★ 备份里的 courses 是空的 —— 这正是 WAL 那个坑');
      assert.ok(n('SELECT COUNT(*) n FROM materials') > 0, '备份里的资料没进去');
      assert.ok(n("SELECT COUNT(*) n FROM assignments WHERE kind = 'exam'") > 0,
        '考试（v11 加的列）没进备份');
    } finally {
      check.close();
    }
  });

  test('★ 清单里记下了内容和数量（给人看的、也是自测要核对的那份）', () => {
    const dir = path.join(BACKUP_DIR, backupDirs().at(-1));
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(m.createdAt, '清单里应该有创建时间');
    assert.ok(m.counts.users > 0 && m.counts.courses > 0, `数量不对：${JSON.stringify(m.counts)}`);
    assert.equal(m.verifiedCourses, m.counts.courses,
      '★ 清单里的"验证数"和"源库数"对不上 —— 说明验证那一步没真跑');
    assert.equal(m.withFiles, false, '默认不该把课件也备上（那会很慢很大）');
  });

  test('★ --with-files 才把课件一起备上', () => {
    const up = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(path.join(up, '2026', '01'), { recursive: true });
    fs.writeFileSync(path.join(up, '2026', '01', 'x.txt'), 'x');

    const before = backupDirs().length;
    const { code, out } = runBackup(['--with-files']);
    assert.equal(code, 0, out);
    assert.equal(backupDirs().length, before + 1);

    const dir = path.join(BACKUP_DIR, backupDirs().at(-1));
    assert.ok(fs.existsSync(path.join(dir, 'uploads', '2026', '01', 'x.txt')),
      '★ 加了 --with-files 却没备课件');
  });

  test('★ 默认不备课件（不然每次备份都会很慢很大）', () => {
    const { code } = runBackup();
    assert.equal(code, 0);
    const dir = path.join(BACKUP_DIR, backupDirs().at(-1));
    assert.ok(!fs.existsSync(path.join(dir, 'uploads')), '★ 没加 --with-files 却备了课件');
  });

  test('★ --keep 会真的轮换掉旧的', () => {
    const before = backupDirs().length;
    const { code } = runBackup(['--keep', '2']);
    assert.equal(code, 0);
    const after = backupDirs();
    assert.equal(after.length, 2, `应该只剩 2 份，实际 ${after.length}（之前 ${before} 份）`);
    // 留下来的必须是**最新的**两份
    assert.equal(after.at(-1), [...after].sort().at(-1));
  });
});

describe('★★ --status：回答"备份到底有没有在跑"', () => {
  test('★★ 有新鲜备份时说「✓ 备份是新的」，退出码 0', () => {
    const { code, out } = runBackup(['--status']);
    assert.equal(code, 0, `应该判定为新鲜：\n${out}`);
    assert.ok(/✓ 备份是新的/.test(out), out);
    assert.ok(/最近一次/.test(out), '应该报出最近一次是什么时候');
  });

  test('★★ 一份备份都没有时退出码非 0，并告诉人怎么配', () => {
    const { code, out } = runBackup(['--status', '--out', path.join(TMP, 'never')]);
    assert.notEqual(code, 0, '★ 没有备份却退出了 0 —— 那就等于没在监控');
    assert.ok(/一份备份都没有/.test(out), out);
    assert.ok(/crontab/.test(out), '应该告诉人下一步怎么配');
  });

  test('★★ 备份太旧时退出码非 0（定时任务挂了要能发现）', () => {
    // ⚠️ 要在一个**只有旧备份**的目录里问，不能往"有新鲜备份的目录"里塞一个旧目录 ——
    //    --status 看的是**最新那一份**，塞个旧目录进去，最新的还是新的，
    //    于是判定为正常。（第一版就是这么写的，报"备份过期了却判定为正常"。）
    const lonely = path.join(TMP, 'only-old');
    fs.mkdirSync(path.join(lonely, '2020-01-01_030000'), { recursive: true });
    const { code, out } = runBackup(['--status', '--out', lonely, '--max-age-hours', '1']);
    assert.notEqual(code, 0, '★ 备份过期了却判定为正常');
    assert.ok(/没备份了/.test(out), out);
    assert.ok(/crontab -l/.test(out), '应该告诉人先去看定时任务在不在');
  });

  test('★ 没有清单的那一份会被标出来（不是假装它没问题）', () => {
    const half = path.join(BACKUP_DIR, '2099-01-01_000000');
    fs.mkdirSync(half, { recursive: true });   // 故意不写 manifest.json
    const { out } = runBackup(['--status', '--max-age-hours', '999999']);
    assert.ok(/没有 manifest\.json/.test(out), `应该指出这一份没做完：\n${out}`);
    fs.rmSync(half, { recursive: true, force: true });
  });
});

describe('★ --list', () => {
  test('★ 列得出所有备份，带数量和大小', () => {
    const { code, out } = runBackup(['--list']);
    assert.equal(code, 0);
    assert.ok(/共 \d+ 份/.test(out), out);
    assert.ok(/用户 \d+ · 课程 \d+/.test(out), `每一份都该有内容摘要：\n${out}`);
  });
});
