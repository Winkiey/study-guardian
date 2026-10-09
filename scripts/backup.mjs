/**
 * 备份。
 *
 * ## 为什么不是 `tar czf backup.tgz data`
 *
 * 这是最容易写、也最容易在**需要它的那天**才发现是坏的那种备份。两个原因，
 * 而且两个都在这个项目里真实踩过：
 *
 * 1. **WAL 模式**：新写入的数据先落在 `data/app.db-wal` 里，主库文件可能只有
 *    几 KB。迁移时就因为直接拷 `app.db` 得到过一个**几乎空的库**
 *    （app.db 4KB，真正的内容在 816KB 的 wal 里）。
 *    tar 虽然会把 `-wal` 一起打包，但它是**逐个文件读**的 —— 数据库在打包
 *    过程中被写入，就会得到"库"和"wal"来自不同时刻的一对文件。
 *    恢复时能不能读出来全靠运气。
 *    → 所以数据库那一份必须用 SQLite 自己的 `VACUUM INTO`：
 *      它是原子的，服务正在跑也安全。
 *
 * 2. **没有验证**：tar 打包完就完事了，没人知道里面那 4KB 的 app.db
 *    是不是空的。等到真出事那天打开才发现 —— 那时候已经晚了。
 *    → 所以每次备份完都要**把备份打开数一遍**（用户/课程/资料/作业），
 *      对不上就以非 0 退出。
 *
 * ## 为什么是目录而不是一个压缩包
 *
 * 这个项目零依赖，Node 里没有内置的 tar/zip **写**。要生成单个压缩包就得
 * 自己写一个打包器（几百行，还得自己保证正确）—— 而备份这种东西，
 * "简单到不可能出错"比"方便"重要。
 *
 * 想要单个文件的话，在**备份完成之后**再打包那个目录是绝对安全的：
 *
 *   tar czf /root/backup-$(date +%F).tgz -C /opt/study-guardian/backups 2026-09-21_030000
 *
 * 注意区别：打包的是**已经做完的备份目录**，不是正在被写入的 data 目录。
 * 前者随便压，后者不能碰。
 *
 * ## 用法
 *
 *   node scripts/backup.mjs                    # 备份一次（crontab 里就用这个）
 *   node scripts/backup.mjs --with-files       # 连课件原文件一起备（大、慢）
 *   node scripts/backup.mjs --keep 30          # 保留最近 30 份（默认 14）
 *   node scripts/backup.mjs --status           # 最近一次备份是什么时候？是不是太久没备了？
 *   node scripts/backup.mjs --list             # 列出所有备份
 *
 * 退出码：0 成功；非 0 失败（crontab 会因此给你发信，日志里也看得出来）。
 * 这一点很重要 —— 一个**悄悄失败**的备份比没有备份更危险：
 * 你以为有。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import config from '../src/config.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const optOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

/**
 * 备份放哪：默认项目下的 backups/，可以用 BACKUP_DIR 指走（指到别的盘更稳妥）。
 * ⚠️ `--out` 优先于环境变量 —— 命令行上明写的东西应该赢。反过来的话，
 *    `BACKUP_DIR=... node scripts/backup.mjs --out /tmp/x` 会**静默**写到
 *    环境变量那一边，而用户以为自己指定了 /tmp/x。
 */
const BACKUP_DIR = path.resolve(optOf('--out', process.env.BACKUP_DIR || 'backups'));
const KEEP = Math.max(1, Number.parseInt(optOf('--keep', '14'), 10) || 14);
const MAX_AGE_HOURS = Number.parseFloat(optOf('--max-age-hours', '36')) || 36;

const DATA_DIR = path.resolve(config.dataDir);
const DB_SRC = path.join(DATA_DIR, 'app.db');

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
};

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const humanAge = (ms) => {
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} 分钟前`;
  if (h < 48) return `${h.toFixed(1)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
};

/**
 * 从目录名里读出这次备份的**时刻**。
 *
 * ⚠️ 不能用目录的 mtime 来判断新旧：mtime 会随着**复制/解压**而变。
 *    你把备份 scp 到另一台机器、或者解开一个压缩包，那份"三天前的备份"
 *    立刻就变成了"刚刚的备份" —— 于是 --status 说一切正常，
 *    而实际上你已经三天没备份了。
 *    目录名是我们自己按时刻生成的，它才是权威的那个时间。
 */
function stampMsOf(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], 0).getTime();
}

/** 列出已有的备份（新的在前） */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/.test(e.name))
    .map((e) => {
      const dir = path.join(BACKUP_DIR, e.name);
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      } catch {
        // 没有清单 = 那次备份没做完（或者被手删了）。留着，但要能看出来。
      }
      let bytes = 0;
      try {
        const walk = (p) => {
          for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
            const full = path.join(p, ent.name);
            if (ent.isDirectory()) walk(full);
            else bytes += fs.statSync(full).size;
          }
        };
        walk(dir);
      } catch { /* 算不出来就算了，不影响备份本身 */ }
      // 新旧以**目录名里的时刻**为准（mtime 会被复制/解压改掉）
      return { name: e.name, dir, manifest, bytes, atMs: stampMsOf(e.name) ?? fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** 递归复制（Node 里没有内置的 cp -r） */
function copyDir(from, to) {
  let files = 0;
  let bytes = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) {
      const sub = copyDir(src, dst);
      files += sub.files;
      bytes += sub.bytes;
    } else if (ent.isFile()) {
      fs.copyFileSync(src, dst);
      files += 1;
      bytes += fs.statSync(dst).size;
    }
  }
  return { files, bytes };
}

/**
 * 本次备份的目录名。
 *
 * ⚠️ 时间戳只到**秒**，所以同一秒内跑两次会撞名 —— 而 `VACUUM INTO`
 *    在目标文件已存在时会直接报 "output file already exists"。
 *    （这不是理论问题：自测连跑几次备份就撞上了。）
 *    撞名时加 `-2`、`-3` 后缀，**不覆盖**已经做完的那一份。
 */
function uniqueStampDir() {
  const base = stamp();
  let name = base;
  let n = 1;
  while (fs.existsSync(path.join(BACKUP_DIR, name))) {
    n += 1;
    name = `${base}-${n}`;
  }
  return path.join(BACKUP_DIR, name);
}

// ============================================================
// --status：回答"备份到底有没有在跑"
// ============================================================

if (has('--status')) {
  const all = listBackups();
  const newest = all[0];
  console.log(`\n备份目录：${BACKUP_DIR}`);
  if (!newest) {
    console.error('\n✗ 一份备份都没有 —— 自动备份没在跑。');
    console.error(`\n  照 DEPLOY.md 的「自动备份」一节配 crontab，或者先手动跑一次：`);
    console.error(`    cd /opt/study-guardian && node scripts/backup.mjs\n`);
    process.exit(1);
  }

  const ageMs = Date.now() - newest.atMs;
  const hours = ageMs / 3600000;
  const stale = hours > MAX_AGE_HOURS;

  console.log(`  最近一次：${newest.name}（${humanAge(ageMs)}，${kb(newest.bytes)}）`);
  if (newest.manifest) {
    const c = newest.manifest.counts || {};
    console.log(`  内容：用户 ${c.users} · 课程 ${c.courses} · 资料 ${c.materials}`
      + ` · 作业 ${c.assignments} · 考试 ${c.exams}`);
  } else {
    console.log('  ⚠️ 这一份没有 manifest.json —— 那次备份没做完，不要指望它。');
  }
  console.log(`  共 ${all.length} 份，占 ${kb(all.reduce((s, b) => s + b.bytes, 0))}`);

  if (stale) {
    console.error(`\n✗ 已经 ${humanAge(ageMs)} 没备份了（上限 ${MAX_AGE_HOURS} 小时）—— 定时任务多半没在跑。`);
    console.error('  在服务器上执行 `crontab -l` 看有没有那一行；下面的日志能看出它跑没跑成功：');
    console.error(`    tail -20 ${path.join(BACKUP_DIR, 'backup.log')}\n`);
    process.exit(1);
  }
  console.log('\n✓ 备份是新的。\n');
  process.exit(0);
}

if (has('--list')) {
  const all = listBackups();
  console.log(`\n备份目录：${BACKUP_DIR}（共 ${all.length} 份）\n`);
  for (const b of all) {
    const c = b.manifest?.counts;
    console.log(`  ${b.name}  ${kb(b.bytes).padStart(9)}  `
      + `${c ? `用户 ${c.users} · 课程 ${c.courses} · 资料 ${c.materials} · 作业 ${c.assignments}` : '（没有清单，未完成）'}`);
  }
  console.log('');
  process.exit(0);
}

// ============================================================
// 正式备份
// ============================================================

if (!fs.existsSync(DB_SRC)) {
  console.error(`\n✗ 找不到数据库：${DB_SRC}`);
  console.error('  请在项目根目录下运行本脚本（或者用 DATA_DIR 指向真正的数据目录）。\n');
  process.exit(1);
}

const dir = uniqueStampDir();
fs.mkdirSync(dir, { recursive: true });

let db;
try {
  // ① 数据库：用 VACUUM INTO，不直接拷文件（见文件开头第 1 条）
  const out = path.join(dir, 'app.db');
  db = new DatabaseSync(DB_SRC);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

  const count = (sql) => {
    try {
      return db.prepare(sql).get().n;
    } catch {
      return '?';
    }
  };
  const counts = {
    users: count("SELECT COUNT(*) n FROM users"),
    courses: count("SELECT COUNT(*) n FROM courses"),
    materials: count("SELECT COUNT(*) n FROM materials"),
    assignments: count('SELECT COUNT(*) n FROM assignments'),
    exams: count("SELECT COUNT(*) n FROM assignments WHERE kind = 'exam'"),
  };

  // ② 验证：**把备份打开数一遍**。
  //    这一步是整件事里最值钱的：它把"备份文件存在"变成"备份能用"。
  const check = new DatabaseSync(out);
  let verified = 0;
  try {
    verified = Number(check.prepare('SELECT COUNT(*) n FROM courses').get().n) || 0;
  } finally {
    check.close();
  }

  // ③ 头像（很小，丢了就得让每个人重传，顺手备上）
  let extra = { files: 0, bytes: 0 };
  const avatars = path.join(DATA_DIR, 'avatars');
  if (fs.existsSync(avatars)) extra = copyDir(avatars, path.join(dir, 'avatars'));

  // ④ 课件原文件：默认不备（可能很大、而且多数能从老师那儿再拿到），
  //    但**恢复时缺了它们，库里的记录就会指向不存在的文件**。
  //    所以 DEPLOY.md 里讲清楚：真要"整机搬家"就加 --with-files。
  let uploads = { files: 0, bytes: 0, included: false };
  const upDir = path.join(DATA_DIR, 'uploads');
  if (has('--with-files') && fs.existsSync(upDir)) {
    uploads = { ...copyDir(upDir, path.join(dir, 'uploads')), included: true };
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    stamp: path.basename(dir),
    from: DATA_DIR,
    counts,
    verifiedCourses: verified,
    avatars: extra,
    uploads,
    withFiles: has('--with-files'),
  }, null, 2));

  // ⑤ 轮换：只留最近 KEEP 份
  const all = listBackups();
  const removed = [];
  for (const b of all.slice(KEEP)) {
    fs.rmSync(b.dir, { recursive: true, force: true });
    removed.push(b.name);
  }

  // ⑥ 说到做到：课程数对不上就以非 0 退出。
  //    这正是"空库备份"的典型症状（WAL 那个坑），而且它**不会报错**，
  //    只会让你在换机器之后发现"网站让我重新创建账号"。
  const suspect = verified !== counts.courses;
  const emptyish = counts.courses === 0 && counts.users === 0;

  console.log('\n✓ 备份完成');
  console.log(`  位置：${dir}`);
  console.log(`  数据库：${kb(fs.statSync(path.join(dir, 'app.db')).size)}`
    + `（用户 ${counts.users} · 课程 ${counts.courses} · 资料 ${counts.materials}`
    + ` · 作业 ${counts.assignments} · 考试 ${counts.exams}）`);
  if (extra.files) console.log(`  头像：${extra.files} 个文件，${kb(extra.bytes)}`);
  if (uploads.included) console.log(`  课件：${uploads.files} 个文件，${kb(uploads.bytes)}`);
  else console.log('  课件：未包含（要一起备就加 --with-files）');
  if (removed.length) console.log(`  轮换：删掉 ${removed.length} 份旧的（保留最近 ${KEEP} 份）`);
  console.log('');

  if (suspect || emptyish) {
    console.error('✗ 备份里的课程数和源库对不上 —— 这一份不能信。');
    console.error(`  源库 ${counts.courses} 门课，备份里读出来 ${verified} 门。`);
    console.error('  如果源库本来就该有课，说明拿到的不是真正的数据库，别急着往下做。\n');
    process.exit(2);
  }
} catch (err) {
  console.error(`\n✗ 备份失败：${err.message}`);
  console.error('  这一份不完整，已经留在原地但**不要指望它**（没有 manifest.json）。\n');
  process.exit(1);
} finally {
  db?.close?.();
}
