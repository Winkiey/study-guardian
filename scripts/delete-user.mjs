/**
 * 删除账号（连同这个账号的全部数据）。
 *
 * 用途有两个：
 *   1. 服务器上出现了不该存在的账号（测试账号、别人试注册留下的），
 *      而网页端的「注销账号」要求输入**原密码** —— 密码不知道就删不掉；
 *   2. 你自己想彻底清掉一个账号，又不想先登录一遍。
 *
 * 用法：
 *   node scripts/delete-user.mjs                    # 只列出账号，不做任何事
 *   node scripts/delete-user.mjs 用户名              # 先预览要删什么，然后要求确认
 *   node scripts/delete-user.mjs 用户名 --yes        # 跳过确认（脚本/无人值守）
 *
 * 几点说明：
 *   - 真正干活的是 `src/lib/account.js` 的 deleteAccount()，和网页端注销
 *     走的是**同一段代码**：事务里删数据库（含没有外键的 notify_log / settings）、
 *     提交后再删磁盘上的课件、转换出来的 PDF、幻灯片图片。
 *     这里不另写一套删除逻辑 —— 两套逻辑迟早会不一致，而不一致的那一半
 *     就是「注销了但数据还在」。
 *   - 默认要打一次 yes 才真删。删号是不可逆的，误删只能靠备份。
 *   - 它操作当前配置的数据目录（默认 data/app.db）。
 *     想删别处的库，用 DATA_DIR 环境变量指过去。
 */

import { createInterface } from 'node:readline/promises';

import { deleteAccount, collectUserFiles } from '../src/lib/account.js';
import { getDb } from '../src/db/index.js';
import config from '../src/config.js';

const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes') || args.includes('-y');
const username = args.find((a) => !a.startsWith('-'));

const db = getDb();

/**
 * 查账号列表。
 *
 * **每次都重新查**，不要在外面查一次然后一直用那个快照 ——
 * 删除之后打印「剩余账号」时，用旧快照会把刚删掉的账号又列一遍，
 * 看上去像没删成功（第一版就是这么写错的）。
 */
function accounts() {
  return db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
}

/** 只列出账号，方便先看清楚再动手 */
function listAccounts() {
  const rows = accounts();
  console.log(`\n现有账号（共 ${rows.length} 个）：`);
  for (const u of rows) {
    console.log(`  ${String(u.id).padStart(3)}  ${u.username}${u.created_at ? `   （建于 ${u.created_at}）` : ''}`);
  }
  console.log('');
}

const everyone = accounts();

if (!username) {
  console.log(`
删除账号（连同全部数据）

  用法：node scripts/delete-user.mjs 用户名 [--yes]

  例：  node scripts/delete-user.mjs codex_qa_20260919
        node scripts/delete-user.mjs 旧账号 --yes

  不加用户名时只列出账号，不做任何改动。
  --yes 跳过确认（交互式终端下默认会问一次）。

  当前数据目录：${config.dataDir}`);
  listAccounts();
  process.exit(everyone.length ? 0 : 1);
}

if (everyone.length === 0) {
  console.error('\n✗ 这个库里一个账号都没有，没什么可删的。\n');
  process.exit(1);
}

// 和 reset-password.mjs 一致：按 lower() 查，因为登录本身不区分大小写。
// 大小写敏感会出现「名单上明明有、却删不掉」这种自相矛盾的情况。
const user = db.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?)')
  .get(String(username).trim());

if (!user) {
  console.error(`\n✗ 找不到账号「${username}」。`);
  listAccounts();
  process.exit(1);
}

// 先把「会删掉什么」算出来给人看。deleteAccount 内部也会算一次，
// 这里重复算是故意的：确认之前必须让操作者看到代价。
const { files, dirs } = collectUserFiles(user.id);
const materialCount = Number(
  db.prepare('SELECT COUNT(*) AS c FROM materials WHERE user_id = ?').get(user.id)?.c || 0,
);

console.log('\n即将删除：');
console.log(`  账号：${user.username}（id ${user.id}）`);
console.log(`  ${materialCount} 份课件，磁盘上 ${files.length} 个文件、${dirs.length} 个图片目录`);
console.log('  以及这个账号的课程、作业、提醒、通知渠道、发送日志和设置。');

// 打码一下路径：这些是服务器上的绝对路径，贴给别人看时不必暴露
for (const f of files.slice(0, 5)) console.log(`    ${f.replace(config.dataDir, 'data')}`);
if (files.length > 5) console.log(`    …… 还有 ${files.length - 5} 个文件`);

console.log('\n⚠️  这一步不可撤销。删完只能靠备份恢复。');

if (!skipConfirm) {
  // 非交互终端（比如 `node script.mjs 用户名 < /dev/null`）不能让 readline 挂住
  if (!process.stdin.isTTY) {
    console.error('\n✗ 当前不是交互式终端，无法确认。确认要删就加 --yes。\n');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n请输入 yes 确认删除「${user.username}」：`);
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('\n已取消，什么都没删。\n');
    process.exit(0);
  }
}

const result = await deleteAccount(user.id);

if (!result.ok) {
  console.error('\n✗ 删除失败：账号在删除前就不存在了（是同时被别的地方删掉了吗？）。\n');
  process.exit(1);
}

console.log('\n✓ 已删除');
console.log(`  账号：${result.username}`);
console.log(`  数据库：${Object.entries(result.counts).map(([t, n]) => `${t} ${n}`).join('、')}`);
console.log(`  磁盘：清掉 ${result.removedFiles} 项（文件 + 图片目录）`);
console.log(`  数据目录：${config.dataDir}`);
console.log('\n  剩余账号：');
listAccounts();
