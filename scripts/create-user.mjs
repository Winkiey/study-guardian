/**
 * 直接建一个账号（不经过网页注册）。
 *
 * 什么时候用得上：
 *   - `.env` 里没配 INVITE_CODE，也就是注册关着，但你想给某个人开个号
 *   - 对方在网页上注册总失败（比如用户名被占、邀请码发错了），
 *     你想先替他把号建好，密码再由他自己改
 *   - 你自己把账号注销了，想重新建回来
 *
 * 用法：
 *   node scripts/create-user.mjs 用户名 密码
 *   node scripts/create-user.mjs 用户名 密码 --name 小王 --school 东北财经大学
 *   node scripts/create-user.mjs --list          # 先看看现在有哪些账号
 *
 * 和网页注册的区别：
 *   - 网络那头的限流、邀请码在这里都不存在（能跑到这台机器上执行命令的人
 *     本来就已经是管理员了）
 *   - 校验规则和网页注册**共用同一份**（usernameProblem / passwordProblem），
 *     所以不会出现「网页不让用、命令行能建」这种两套标准
 *   - 建完会顺手建一个默认学期，和网页注册保持一致 ——
 *     少了它，用户一进去课表算不出周次，会以为系统坏了
 */

import {
  createUser,
  findUserByUsername,
  isUsernameTaken,
  passwordProblem,
  usernameProblem,
} from '../src/lib/auth.js';
import * as courses from '../src/lib/courses.js';
import { getDb } from '../src/db/index.js';
import { startOfWeek, todayStr } from '../src/lib/datetime.js';
import config from '../src/config.js';

const argv = process.argv.slice(2);

/** 取 `--name 小王` 这种选项的值 */
function option(name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? String(argv[i + 1] ?? '').trim() : '';
}

function usage() {
  console.log(`
直接创建一个账号

  用法：node scripts/create-user.mjs 用户名 密码 [--name 称呼] [--school 学校]
        node scripts/create-user.mjs --list

  例：  node scripts/create-user.mjs xiaowang my-password
        node scripts/create-user.mjs xiaowang my-password --name 小王
        node scripts/create-user.mjs --list

  当前数据目录：${config.dataDir}
`);
}

// ------------------------------------------------------------
// --list：先把现有账号列出来
// ------------------------------------------------------------
if (argv.includes('--list') || argv.includes('-l')) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.created_at,
            (SELECT COUNT(*) FROM courses c WHERE c.user_id = u.id) AS course_count,
            (SELECT COUNT(*) FROM materials m WHERE m.user_id = u.id) AS material_count
       FROM users u ORDER BY u.id`,
  ).all();

  console.log(`\n数据目录：${config.dataDir}`);
  if (rows.length === 0) {
    console.log('（一个账号都没有。打开网站会引导你创建第一个。）\n');
  } else {
    console.log(`共 ${rows.length} 个账号：\n`);
    for (const r of rows) {
      const name = r.display_name ? `（${r.display_name}）` : '';
      console.log(`  #${r.id}  ${r.username}${name}`);
      console.log(`      注册于 ${r.created_at} · ${r.course_count} 门课 · ${r.material_count} 份资料`);
    }
    console.log('');
  }
  process.exit(0);
}

// ------------------------------------------------------------
// 建号
// ------------------------------------------------------------
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    i += 1; // 跳过它的值
    continue;
  }
  positional.push(argv[i]);
}

const [username, password] = positional;

if (!username || !password) {
  usage();
  process.exit(1);
}

if (passwordProblem(password)) {
  console.error(`\n✗ ${passwordProblem(password)}\n`);
  process.exit(1);
}
if (usernameProblem(username)) {
  console.error(`\n✗ ${usernameProblem(username)}\n`);
  process.exit(1);
}

const db = getDb();

// 先查一次给友好提示；真正的唯一性由 users.username 上的 UNIQUE 约束兜底。
// 口径是**逐字节相等**（v9 起区分大小写）：Alice 和 alice 是两个可用的名字。
if (isUsernameTaken(username)) {
  const existing = findUserByUsername(username);
  console.error(`\n✗ 用户名「${username}」已经被占用了（现有账号 #${existing.id} ${existing.username}）。`);
  console.error('  换个名字，或者用 node scripts/reset-password.mjs 新密码 用户名 改它的密码。\n');
  process.exit(1);
}

try {
  const user = createUser({
    username,
    password,
    displayName: option('name'),
    school: option('school') || '东北财经大学',
  });

  // 和网页注册保持一致：顺手建一个默认学期，
  // 否则这个人一登进来课表算不出周次，会以为系统坏了
  const monday = startOfWeek(todayStr());
  courses.createTerm(user.id, {
    name: courses.guessTermName(monday),
    startDate: monday,
    weekCount: 18,
    isActive: true,
  });

  console.log('\n✓ 账号已创建');
  console.log(`  用户名：${user.username}`);
  console.log(`  显示名：${user.display_name || '（未设置）'}`);
  console.log(`  学校：${user.school}`);
  console.log(`  数据目录：${config.dataDir}`);
  console.log('  现在可以用这个用户名和密码登录了。\n');
} catch (err) {
  // createUser 会把唯一索引冲突翻译成人话；其余错误原样报出来
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
}

// 故意不在这里回显密码 —— 终端历史和录屏里留着明文密码不是好事
