/**
 * scripts/delete-user.mjs —— 服务器上删账号用的小工具。
 *
 * 为什么需要它：网页端的「注销账号」要求输入**原密码**（防误删，设计是对的），
 * 但服务器上出现过不该存在的账号时（测试账号、别人试注册留下的），
 * 密码往往是不知道的 —— 那时候就删不掉了。
 * 这个脚本就是给这种情况用的，也是「站长在自己机器上收拾残局」的工具。
 *
 * 它是**破坏性**的，所以这一组测试重点盯三件事：
 *   1. 默认要人打一次 yes，非交互环境下直接拒绝，**绝不能默默删掉**
 *   2. --yes 之后真的删干净（数据库 + 磁盘上的课件）
 *   3. 干活的是 src/lib/account.js 的 deleteAccount()，不是另写一套删除逻辑
 *      （两套逻辑迟早不一致，而不一致的那一半就是「注销了但数据还在」）
 *
 * 注：这里用「把子进程输出写到临时文件再读」而不是管道，
 * 因为受限环境下拿不到管道（spawn EPERM），而这不影响脚本本身的行为。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(root, 'scripts', 'delete-user.mjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-deluser-test-'));

let auth;
let db;
let materials;

/**
 * 跑一次脚本，返回 { status, out }。
 *
 * 每次都用**新的日志文件**，不要复用同一个名字：
 * 同名的文件被子进程继承之后，下一次 open('w') 截断和上一轮的写入可能交错，
 * 读回来的是两轮混在一起的输出 —— 表现是断言莫名其妙地对着别人的结果判。
 * （A/B 校验脚本上就是这么栽过一次的。）
 */
let logSeq = 0;
function runScript(args) {
  logSeq += 1;
  const log = path.join(DATA_DIR, `out-${logSeq}.log`);
  const fd = fs.openSync(log, 'w');
  let status = -1;
  try {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      env: { ...process.env, DATA_DIR },
      stdio: ['ignore', fd, fd],
      timeout: 60_000,
    });
    status = r.status;
    assert.ok(!r.error, `脚本没能启动：${r.error?.message}`);
  } finally {
    fs.closeSync(fd);
  }
  return { status, out: fs.readFileSync(log, 'utf8') };
}

/** 账号是否还在。注意 findUserByUsername 查不到时返回的是 undefined，不是 null。 */
const accountExists = (name) => Boolean(auth.findUserByUsername(name));

before(async () => {
  process.env.DATA_DIR = DATA_DIR;
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  materials = await import('../src/lib/materials.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 建一个带课件的账号，返回课件在磁盘上的绝对路径 */
async function makeAccountWithMaterial(username) {
  const user = auth.createUser({ username, password: 'probe-password-123' });
  const row = await materials.createMaterialFromUpload(
    user.id,
    { filename: '探针课件.txt', mime: 'text/plain', data: Buffer.from('验证删除用的课件', 'utf8') },
    { title: '探针课件' },
  );
  const material = materials.getMaterial(user.id, row.id);
  const { uploadPath } = await import('../src/lib/files.js');
  return { user, material, file: uploadPath(material.stored_name) };
}

// ============================================================
// 不点名 / 点错名：都不能删任何东西
// ============================================================

describe('★ 不确认就不许删', () => {
  test('不带参数时只列出账号，一个都不删', async () => {
    await makeAccountWithMaterial('列表示例');
    const { status, out } = runScript([]);

    assert.equal(status, 0, '只是列表，应该正常退出');
    assert.match(out, /列表示例/, '要把现有账号列出来，方便看清再动手');
    assert.match(out, /不加用户名时只列出账号，不做任何改动/);
    assert.ok(auth.findUserByUsername('列表示例'), '★ 账号必须还在');
  });

  test('★ 用户名不存在时报错退出，且不碰别的账号', () => {
    const { status, out } = runScript(['根本没有这个账号']);
    assert.equal(status, 1, '应该以失败退出，脚本才能被串在别的流程里');
    assert.match(out, /找不到账号/);
    assert.ok(auth.findUserByUsername('列表示例'), '★ 别人的账号不能被牵连');
  });

  test('★ 非交互终端下不给 --yes 就拒绝执行（这是防手滑的那道闸）', async () => {
    const { file } = await makeAccountWithMaterial('需要确认的账号');

    // 这里 stdin 是 'ignore'，也就是「非交互」——
    // 脚本必须**停下来拒绝**，而不是因为读不到输入就当成同意
    const { status, out } = runScript(['需要确认的账号']);

    assert.equal(status, 1, '应该以失败退出');
    assert.match(out, /无法确认/, '要说清为什么没删');
    assert.match(out, /--yes/, '要告诉人怎么才能继续');
    assert.ok(auth.findUserByUsername('需要确认的账号'), '★ 账号必须还在');
    assert.ok(fs.existsSync(file), '★ 课件文件也必须还在');
  });

  test('★ 拒绝之前要把「将删掉什么」说清楚', async () => {
    const { status, out } = runScript(['需要确认的账号']);
    assert.equal(status, 1);
    assert.match(out, /即将删除/, '要先摆出代价，再让人确认');
    assert.match(out, /1 份课件/, '要说清有多少份课件会被一起删掉');
    assert.match(out, /不可撤销/, '要明确说不可撤销');
  });
});

// ============================================================
// 确认之后：真的删干净
// ============================================================

describe('★ --yes 要真的删干净', () => {
  test('★ 账号、数据库记录、磁盘上的课件一起消失', async () => {
    const { user, file } = await makeAccountWithMaterial('要被删掉的账号');

    const before = Number(
      db.getDb().prepare('SELECT COUNT(*) AS c FROM materials WHERE user_id = ?').get(user.id)?.c || 0,
    );
    assert.equal(before, 1, '前提：这个账号确实有一份课件');
    assert.ok(fs.existsSync(file), '前提：课件文件确实写到了磁盘上');

    const { status, out } = runScript(['要被删掉的账号', '--yes']);

    assert.equal(status, 0, `删除应该成功：\n${out}`);
    assert.match(out, /已删除/);

    assert.ok(!accountExists('要被删掉的账号'), '★ 数据库里的账号要没了');
    assert.ok(!fs.existsSync(file), '★ 磁盘上的课件也要删掉 —— 只删数据库行的话文件会永远留在服务器上');

    const left = Number(
      db.getDb().prepare('SELECT COUNT(*) AS c FROM materials WHERE user_id = ?').get(user.id)?.c || 0,
    );
    assert.equal(left, 0, '★ 课件记录也要没了');
  });

  test('★ 删完之后列的「剩余账号」里不能再出现它', async () => {
    // 第一版脚本在这里是错的：账号列表在开头查了一次就存着，
    // 删完再打印那份旧快照，刚删掉的账号又出现一遍，看着像没删成功。
    await makeAccountWithMaterial('先删这个');
    const { out } = runScript(['先删这个', '--yes']);

    const listPart = out.slice(out.indexOf('剩余账号'));
    assert.ok(listPart, '应该打印剩余账号');
    assert.ok(!listPart.includes('先删这个'),
      '★ 剩余账号列表必须是删完之后重新查的，不能是删除前的旧快照');
  });

  test('★ 大小写必须原样敲对（和登录一样区分大小写），敲错了不删任何东西', async () => {
    await makeAccountWithMaterial('MixedCaseName');

    // 敲错大小写：找不到这个账号，脚本应该报错退出
    const wrong = runScript(['mixedcasename', '--yes']);
    assert.notEqual(wrong.status, 0, `大小写不对应该报错退出，实际退出码 ${wrong.status}`);
    assert.ok(accountExists('MixedCaseName'), '★ 没找到账号时不能顺手删掉任何东西');

    // 原样敲对才删得掉
    const right = runScript(['MixedCaseName', '--yes']);
    assert.equal(right.status, 0, `应该能找到并删除：\n${right.out}`);
    assert.ok(!accountExists('MixedCaseName'));
  });

  test('删完之后其他账号不受影响', async () => {
    await makeAccountWithMaterial('留下的账号');
    await makeAccountWithMaterial('走掉的账号');

    const { status } = runScript(['走掉的账号', '--yes']);
    assert.equal(status, 0);

    assert.ok(!accountExists('走掉的账号'));
    assert.ok(auth.findUserByUsername('留下的账号'), '★ 不能误伤别人');
  });
});

// ============================================================
// 复用已有实现（这条守的是「别写出第二套删除逻辑」）
// ============================================================

describe('★ 不另写一套删除逻辑', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('★ 干活的是 account.js 的 deleteAccount()', () => {
    assert.match(code, /import\s*\{[^}]*deleteAccount[^}]*\}\s*from\s*'\.\.\/src\/lib\/account\.js'/,
      '★ 必须复用 src/lib/account.js —— 它同时管着数据库和磁盘，而且已被端到端测试覆盖');
    assert.match(code, /await deleteAccount\(/, '要真的调用它');
  });

  test('★ 自己不许写 DELETE 语句', () => {
    // 一旦这里出现手写的 DELETE，就等于有了第二套删除逻辑：
    // 漏掉 notify_log / settings（没有外键，级联管不到）或漏删磁盘文件都不会报错，
    // 表现是「注销了但数据还在」—— 没人会发现。
    assert.doesNotMatch(code, /DELETE\s+FROM/i,
      '★ 删除逻辑只该有一处实现在 account.js 里');
    assert.doesNotMatch(code, /db\.prepare\([^)]*DELETE/i);
  });
});
