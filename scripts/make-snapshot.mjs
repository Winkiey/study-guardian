/**
 * 导出数据库快照（用于迁移或备份）。
 *
 * 为什么需要它，而不是直接复制 data/app.db：
 *   本项目用 SQLite 的 WAL 模式，新写入的数据先落在 `app.db-wal` 里，
 *   主库文件可能只有几 KB。直接拷 `app.db` 会得到一个**几乎空的库** ——
 *   这个坑在迁移时真实踩过（app.db 4KB，而真正的内容在 816KB 的 wal 里）。
 *   `VACUUM INTO` 会导出一份完整、自洽、已合并 WAL 的副本。
 *
 * 为什么要做成脚本文件，而不是 `node -e "..."` 一行命令：
 *   那段代码里有单双引号嵌套，在 PowerShell 里需要用 `\"` 转义 ——
 *   而 PowerShell 根本不认这种转义（那是 bash 的写法）。
 *   结果是命令被拆坏、静默失败，然后 tar 又不报错地跳过缺失的文件，
 *   最后得到一个「看起来正常、其实没有数据库」的压缩包。
 *   写成文件就完全绕开了引号问题。
 *
 * 用法：
 *   node scripts/make-snapshot.mjs                # 默认导出到 data/migrate.db
 *   node scripts/make-snapshot.mjs my-backup.db   # 指定输出文件名
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('data', 'app.db');
const outArg = process.argv[2] || 'migrate.db';
const out = path.resolve('data', path.basename(outArg));

if (!fs.existsSync(src)) {
  console.error(`\n✗ 找不到数据库：${src}`);
  console.error('  请在项目根目录下运行本脚本。\n');
  process.exit(1);
}

// 覆盖前先删掉旧的，避免误以为"导出了新的"其实还是旧的
fs.rmSync(out, { force: true });

const db = new DatabaseSync(src);
try {
  // VACUUM INTO 里的路径要转义单引号（Windows 路径一般不会有，但不能不防）
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);

  const count = (sql) => {
    try {
      return db.prepare(sql).get().n;
    } catch {
      return '?';
    }
  };

  const users = count('SELECT COUNT(*) n FROM users');
  const courses = count('SELECT COUNT(*) n FROM courses');
  const materials = count('SELECT COUNT(*) n FROM materials');
  const assignments = count('SELECT COUNT(*) n FROM assignments');
  const sizeKb = Math.round(fs.statSync(out).size / 1024);

  console.log('\n✓ 快照完成');
  console.log(`  文件：${out}`);
  console.log(`  大小：${sizeKb} KB`);
  console.log(`  内容：用户 ${users} · 课程 ${courses} · 资料 ${materials} · 作业 ${assignments}`);
  console.log('');

  /*
   * 关键一步：如果课程是 0，那就是导出了一个空库。
   * 这正是迁移失败的典型症状 —— 而且它不会报错，只会让你在
   * 换机器之后发现「网站让我重新创建账号」。所以这里直接把人拦住。
   */
  if (courses === 0 && users === 0) {
    console.warn('⚠️  这个库里没有任何用户和课程。');
    console.warn('    如果你本来就有课表，说明源数据库不对 —— 别急着往下做。\n');
    process.exit(2);
  }
} finally {
  db.close();
}
