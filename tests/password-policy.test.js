/**
 * 密码规则：下限、边界、以及「规则只写一处」。
 *
 * 背景：下限从 6 位提到 8 位，因为这个站开始给同学用了 ——
 * 以前只有自己一个账号，密码弱不弱是自己的事；现在**别人注册的密码是别人的风险**。
 *
 * 这次改动真正的风险不在「8 还是 6」，而在**规则散在多处**：
 * 改之前这个数字同时写在
 *   1. `src/lib/auth.js` 的 passwordProblem（权威）
 *   2. `src/routes/api.js` 的改密码接口（自己又写了一遍）
 *   3. `src/web/pages/settings.js` 的 minlength 和帮助文字
 *   4. `src/web/public/app.js` 的前端校验
 *   5. `scripts/reset-password.mjs`
 * 改了下限却漏掉其中一处，**不会报任何错**，只会出现
 * 「页面说要 8 位、服务端只查 6 位」这种规则形同虚设的错位。
 * 所以这一组测试除了盯数值，更盯「有没有第二个地方偷偷写了这个数字」。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-pwpolicy-test-'));
process.env.DATA_DIR = DATA_DIR;

const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** 去掉注释再匹配：注释里为了说明改动会提到「6 位」，别被自己写的注释骗了 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

// ============================================================
// 数值与边界
// ============================================================

describe('★ 密码下限', () => {
  test('★ 下限是 8 位', () => {
    assert.equal(auth.PASSWORD_MIN_LENGTH, 8);
  });

  test('★ 7 位被拒、8 位通过（边界两侧都要验）', () => {
    // 只验「5 位被拒」是不够的：那样即使规则被改回 6 位，测试照样是绿的。
    // 7 位正是「以前能过、现在必须挡住」的那一档。
    assert.match(auth.passwordProblem('1234567'), /至少 8 位/);
    assert.equal(auth.passwordProblem('12345678'), '');
  });

  test('报错文案里的数字和常量一致（不能一个说 8 一个说 6）', () => {
    const msg = auth.passwordProblem('a');
    assert.ok(msg.includes(String(auth.PASSWORD_MIN_LENGTH)),
      `文案「${msg}」里的数字应该来自常量 ${auth.PASSWORD_MIN_LENGTH}`);
  });

  test('空密码、非字符串都安全', () => {
    assert.match(auth.passwordProblem(''), /至少 8 位/);
    assert.match(auth.passwordProblem(null), /至少 8 位/);
    assert.match(auth.passwordProblem(undefined), /至少 8 位/);
    // 数字会被 String() 转成字符串再数字符 —— 只要不崩、结论跟字符串一致就行。
    // （注意 12345678 转成字符串正好是 8 位，所以它是**通过**的，不是被拒的。）
    assert.equal(auth.passwordProblem(12345678), '', '8 位数字转成字符串后是合规的');
    assert.match(auth.passwordProblem(1234), /至少 8 位/, '4 位数字应该被拒');
    assert.doesNotThrow(() => auth.passwordProblem({}), '奇怪的对象也不该把校验弄崩');
  });

  test('超长仍被拒（scrypt 对超长输入很慢，是个廉价的拒绝服务面）', () => {
    assert.match(auth.passwordProblem('a'.repeat(201)), /太长/);
    assert.equal(auth.passwordProblem('a'.repeat(200)), '');
  });
});

// ============================================================
// 老账号不受影响（我在改动里承诺过这件事，得有测试兜着）
// ============================================================

describe('★ 加长下限不影响已有账号', () => {
  test('★ 6 位的老密码照样能登进来', () => {
    // 登录只校验哈希，不看长度 —— 这条要钉住：
    // 如果哪天有人「顺手」在登录路径上也加上 passwordProblem，
    // 所有密码短于 8 位的老账号会**当场全部登不进来**，
    // 而且报的是「用户名或密码不正确」，看起来像密码错了，极难排查。
    const user = auth.createUser({ username: '老账号六位密码', password: 'abc123' });
    assert.ok(user?.id, '前提：能建出这个账号');

    const found = auth.findUserByUsername('老账号六位密码');
    assert.ok(auth.verifyPassword('abc123', found.password_hash),
      '★ 6 位的老密码必须还能验证通过');

    // 反过来：新规则只约束「设置密码」这一步
    assert.match(auth.passwordProblem('abc123'), /至少 8 位/);
  });
});

// ============================================================
// 规则只有一处实现
// ============================================================

describe('★ 规则只写一处（改了下限不能只改一半）', () => {
  test('★ 改密码接口用的是 auth.js 那一条规则，没有自己另写判断', () => {
    const api = code(read('src/routes/api.js'));
    assert.match(api, /passwordProblem/, '★ api.js 应该调用 passwordProblem，而不是自己比长度');

    // 只要这里出现「拿 newPassword 去比长度」，就说明又分叉出一份规则了。
    // 分叉之后不会有任何报错，只会让改密码这条路悄悄用回旧下限。
    const hardcoded = /newPassword[^\n]{0,80}length\s*[<>]=?\s*\d/.exec(api);
    assert.equal(hardcoded, null,
      `★ 不要在路由里手写密码长度判断：${hardcoded?.[0]}`);
  });

  test('★ 页面上的 minlength 来自常量，不是写死的数字', () => {
    const page = code(read('src/web/pages/settings.js'));
    const hardcoded = /minlength="\d+"/.exec(page);
    assert.equal(hardcoded, null,
      `★ 写死数字的话，改了下限页面不会跟着变：${hardcoded?.[0]}`);
    assert.match(page, /minlength="\$\{PASSWORD_MIN_LENGTH\}"/,
      '注册和改密两个输入框都要用常量插值');
  });

  test('★ 命令行脚本也用同一条规则（它比服务端宽松的话会「重置成功但登不上」）', () => {
    const script = code(read('scripts/reset-password.mjs'));
    assert.match(script, /passwordProblem/, '★ 应该复用 passwordProblem');
    assert.doesNotMatch(script, /password\.length\s*<\s*\d/,
      '★ 不要在脚本里手写长度判断');
  });

  test('★ 前端校验的长度从输入框自己的 minlength 读，不写死数字', () => {
    const app = code(read('src/web/public/app.js'));
    // 客户端拿不到服务端常量，所以从服务端渲染的 minlength 上读 ——
    // 写死的话，服务端改了下限，前端还会放行旧下限的密码，然后吃一个服务端报错
    assert.match(app, /minLength/, '应该读 input.minLength');
    assert.doesNotMatch(app, /newPassword[^\n]{0,60}length\s*<\s*\d/,
      '★ 不要在客户端手写密码长度判断');
  });
});
