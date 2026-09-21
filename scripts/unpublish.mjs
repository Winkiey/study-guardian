/**
 * 下架社区里公开的资料（管理员用途）。
 *
 * 为什么需要它：校友社区一旦有人公开了**不该公开**的东西（老师的原件、
 * 带答案的卷子、教材扫描、别人的笔记），原来唯一的处理办法是
 * `delete-user.mjs` 把整个账号删掉 —— 连他的课程、作业、全部资料一起没。
 * 这是"用大炮打蚊子"，而且实际上没人下得去手，结果就是那份东西一直挂着。
 *
 * 用法：
 *   node scripts/unpublish.mjs                        # 列出当前公开了什么，不做任何改动
 *   node scripts/unpublish.mjs 12                     # 收回 id 为 12 的那一份（先预览再确认）
 *   node scripts/unpublish.mjs --user 小王             # 收回某人公开的**全部**
 *   node scripts/unpublish.mjs 12 --yes               # 跳过确认
 *
 * 几点说明：
 *   · 只改 `published`，**不删文件、不动别的字段**，所以随时可以让他重新公开 ——
 *     这是个可逆操作，和删号完全不同。
 *   · 真正改库的是 `src/lib/materials.js` 的 adminSetPublished()。
 *     这里不另写 SQL：那是个绕过归属校验的**危险**函数，只能有一份，
 *     这样 grep 得到、看得见、改得动。
 *   · 默认要打一次 yes。虽然是可逆操作，但它改的是**别人**的东西，
 *     而且对方不会收到任何通知（本来就没有通知机制），值得慢一步。
 *   · 它操作当前配置的数据目录（默认 data/app.db）。
 */

import { createInterface } from 'node:readline/promises';

import { adminListPublished, adminSetPublished } from '../src/lib/materials.js';
import { getDb } from '../src/db/index.js';
import config from '../src/config.js';

const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes') || args.includes('-y');
const userFlagIndex = args.findIndex((a) => a === '--user' || a === '-u');
const wantUsername = userFlagIndex >= 0 ? args[userFlagIndex + 1] : '';
const idArg = args.find((a) => /^\d+$/.test(a));
const materialId = idArg ? Number(idArg) : 0;

const db = getDb();

/** 每次都重新查（下架之后打印"剩余"时用旧快照会把刚下架的又列一遍） */
function published() {
  return adminListPublished({ limit: 500 });
}

/** 谁公开了什么。管理员看的东西，所以带用户名 —— 网页端永远不显示它。 */
function listPublished() {
  const rows = published();
  if (!rows.length) {
    console.log('\n现在**没有任何**公开的资料（社区是空的）。\n');
    return rows;
  }
  const byOwner = new Map();
  for (const r of rows) byOwner.set(r.username, (byOwner.get(r.username) || 0) + 1);
  console.log(`\n现在公开的资料：共 ${rows.length} 份，来自 ${byOwner.size} 个账号`);
  for (const [name, n] of byOwner) console.log(`  ${name}：${n} 份`);
  console.log('');
  for (const r of rows) {
    console.log(`  #${String(r.id).padStart(4)}  ${r.username}  《${r.title}》`
      + `${r.courseName ? `  [${r.courseName}]` : ''}  ${String(r.updatedAt).slice(0, 16)}`);
  }
  console.log('');
  return rows;
}

if (!wantUsername && !materialId) {
  console.log(`
下架社区里公开的资料（只改公开状态，不删文件、可逆）

  用法：node scripts/unpublish.mjs 资料id [--yes]
        node scripts/unpublish.mjs --user 用户名 [--yes]

  例：  node scripts/unpublish.mjs 12
        node scripts/unpublish.mjs --user 小王 --yes

  不带参数时只列出当前公开了什么，不做任何改动。
  --yes 跳过确认（非交互式终端下必须给，否则会拒绝执行）。

  当前数据目录：${config.dataDir}`);
  listPublished();
  process.exit(0);
}

// 先把「会改到什么」算出来给操作者看。确认之前必须看到代价 ——
// 尤其这个操作改的是别人的东西，而且对方不会收到通知。
let targets = [];
let whoLabel = '';

if (wantUsername) {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?')
    .get(String(wantUsername).trim());
  if (!user) {
    console.error(`\n✗ 找不到账号「${wantUsername}」。`);
    const all = db.prepare('SELECT username FROM users ORDER BY id').all();
    console.error(`  现有账号：${all.map((u) => u.username).join('、')}\n`);
    process.exit(1);
  }
  targets = published().filter((r) => r.ownerId === user.id);
  whoLabel = `账号「${user.username}」公开的全部`;
  if (!targets.length) {
    console.log(`\n这个账号现在没有任何公开的资料，没什么可做的。\n`);
    process.exit(0);
  }
} else {
  const row = published().find((r) => r.id === materialId);
  if (!row) {
    console.error(`\n✗ 找不到 id 为 ${materialId} 的**已公开**资料。`);
    console.error('  （要么这个 id 不存在，要么它本来就没公开 —— 那就不用下架。）');
    console.error('  不加参数跑一遍可以看当前公开了什么。\n');
    process.exit(1);
  }
  targets = [row];
  whoLabel = `资料 #${row.id}`;
}

console.log(`\n即将下架：${whoLabel}`);
for (const r of targets) {
  console.log(`  #${String(r.id).padStart(4)}  ${r.username}  《${r.title}》`);
}
console.log(`\n共 ${targets.length} 份。它们会从校友社区里消失，同校同学立刻看不到、也下载不了。`);
console.log('文件**不会**被删除，资料的主人重新勾一下「公开给同校」就能恢复。');
console.log('⚠️  对方不会收到任何通知 —— 如果他问起，就是你告诉他。');

if (!skipConfirm) {
  if (!process.stdin.isTTY) {
    console.error('\n✗ 当前不是交互式终端，无法确认。确认要下架就加 --yes。\n');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n请输入 yes 确认下架 ${targets.length} 份：`);
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('\n已取消，什么都没改。\n');
    process.exit(0);
  }
}

let changed = 0;
for (const r of targets) changed += adminSetPublished({ id: r.id, published: 0 });

console.log(`\n✓ 已下架 ${changed} 份`);
console.log(`  数据目录：${config.dataDir}`);
console.log('\n  现在还剩这些公开的资料：');
listPublished();
