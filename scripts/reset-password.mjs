/**
 * 重置账号密码。
 *
 * 用途：忘记密码时用。数据（课表、作业、课件）都还在，只是进不去。
 *
 * 用法：
 *   node scripts/reset-password.mjs 新密码
 *   node scripts/reset-password.mjs 新密码 Winkie     # 指定用户名
 *
 * 说明几点：
 *   - 密码用项目自己的 hashPassword 生成，格式和注册时完全一致
 *     （scrypt$N$r$p$salt$hash），不是另写一套。
 *   - 写完会**立刻用 verifyPassword 校验一遍**，确认真的能用才报成功 ——
 *     不然「写进去了但哈希不对」这种错很难发现。
 *   - 它操作的是当前配置的数据目录（默认 data/app.db）。
 *     想重置别处的库，用 DATA_DIR 环境变量指过去。
 */

import { hashPassword, verifyPassword } from '../src/lib/auth.js';
import { getDb } from '../src/db/index.js';
import config from '../src/config.js';

const [password, username] = process.argv.slice(2);

if (!password) {
  console.log(`
重置账号密码

  用法：node scripts/reset-password.mjs 新密码 [用户名]

  例：  node scripts/reset-password.mjs my-new-pass
        node scripts/reset-password.mjs my-new-pass Winkie

  不给用户名时，默认改第一个账号。

  当前数据目录：${config.dataDir}
`);
  process.exit(1);
}

if (password.length < 6) {
  console.error('\n✗ 密码至少 6 位（和注册时的规则一致）。\n');
  process.exit(1);
}
if (password.length > 200) {
  console.error('\n✗ 密码太长了（最多 200 位）。\n');
  process.exit(1);
}

const db = getDb();

const user = username
  ? db.prepare('SELECT id, username FROM users WHERE username = ?').get(username)
  : db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();

if (!user) {
  const all = db.prepare('SELECT username FROM users ORDER BY id').all();
  console.error(`\n✗ 找不到账号${username ? `「${username}」` : ''}。`);
  if (all.length) {
    console.error(`  现有账号：${all.map((u) => u.username).join('、')}\n`);
  } else {
    console.error('  这个库里一个账号都没有 —— 打开网站会引导你创建。\n');
  }
  process.exit(1);
}

db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
  .run(hashPassword(password), user.id);

// 写完立刻读回来验一遍。不要只写不验 ——
// 「写成功但哈希格式不对」的话，人要到登录时才发现，很难排查。
const saved = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
if (!verifyPassword(password, saved.password_hash)) {
  console.error('\n✗ 写入后校验失败，密码可能没生效。请把这条信息告诉我。\n');
  process.exit(1);
}

console.log('\n✓ 密码已重置');
console.log(`  账号：${user.username}`);
console.log(`  数据目录：${config.dataDir}`);
console.log('  现在可以用这个新密码登录了。\n');
