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
 *   - 多用户之后有一个安全上的讲究：**站点里有多个账号时必须点名**。
 *     原来不写用户名就默默改「第一个账号」，那在多人共用一台服务器时
 *     会改错人 —— 而且对方会以为自己被盗号了。
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

  站点里只有一个账号时可以不给用户名；有多个账号时必须点名。

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

const everyone = db.prepare('SELECT id, username FROM users ORDER BY id').all();

if (everyone.length === 0) {
  console.error('\n✗ 这个库里一个账号都没有 —— 打开网站会引导你创建第一个。\n');
  process.exit(1);
}

// 站点里有多个账号却不点名，就直接停下来问清楚。
// 名单一起打出来，省得人再去翻：这一步本来就是为了解决「进不去」，
// 不该让人先去别处查用户名。
if (!username && everyone.length > 1) {
  console.error('\n✗ 这个站点有多个账号，必须指明要重置哪一个。\n');
  console.error(`  现有账号（共 ${everyone.length} 个）：`);
  for (const u of everyone) console.error(`    ${u.username}`);
  console.error(`\n  用法：node scripts/reset-password.mjs 新密码 用户名\n`);
  process.exit(1);
}

// 查账号用 lower() 比对：登录本身就是不区分大小写的，
// 重置密码如果区分大小写，就会出现「找得到却重置不了」这种自相矛盾的情况。
const user = username
  ? db.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?)').get(username.trim())
  : everyone[0];

if (!user) {
  console.error(`\n✗ 找不到账号「${username}」。`);
  console.error(`  现有账号：${everyone.map((u) => u.username).join('、')}\n`);
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
