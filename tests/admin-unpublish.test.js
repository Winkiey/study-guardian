/**
 * 管理员下架用的那条通道（scripts/unpublish.mjs 背后的函数）。
 *
 * 这个文件很小，但守的是这个项目里**唯一一处故意绕过归属校验**的写操作：
 * 网页那边公开/收回资料必须是「只能动自己的」（setPublishedBulk 的第一条
 * WHERE 就是 user_id），而管理员要能下架**别人**的东西 —— 否则有人公开了
 * 不该公开的东西，唯一的办法就是把整个账号删掉。
 *
 * 所以这里要钉死的是那个"绕过"的**边界**，而不是它好不好用：
 *   1. 什么都不给的时候，**一行都不许改**（没有 WHERE 的 UPDATE 最可怕）；
 *   2. 给不存在的 id，改 0 行、不报错；
 *   3. 给 id / userId 时，只动该动的那几行。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-admin-unpub-'));
process.env.DATA_DIR = DATA_DIR;

let materials;
let db;

before(async () => {
  materials = await import('../src/lib/materials.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 直接插两行测试数据（这个文件只关心 published 这一列） */
function seed() {
  const d = db.getDb();
  d.exec('DELETE FROM materials');
  d.exec('DELETE FROM users');
  const u = d.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')");
  u.run('甲');
  u.run('乙');
  const ids = d.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  // ⚠️ original_name 是 NOT NULL 而且**没有默认值**，漏了会直接报约束错误
  const insert = d.prepare(
    `INSERT INTO materials (user_id, title, original_name, stored_name, kind, size, published)
     VALUES (?, ?, ?, ?, 'text', 10, ?)`,
  );
  insert.run(ids[0], '甲的公开资料', 'a.txt', 'a.txt', 1);
  insert.run(ids[0], '甲的私密资料', 'b.txt', 'b.txt', 0);
  insert.run(ids[1], '乙的公开资料', 'c.txt', 'c.txt', 1);
  return ids;
}

describe('★ 管理员下架：能下架别人的，但边界要钉死', () => {
  test('★★ 什么参数都不给时，一行都不许改', () => {
    seed();
    const before = materials.adminListPublished().length;
    const changed = materials.adminSetPublished({});

    assert.equal(changed, 0, '★ 没给 id 也没给 userId 却改了东西 —— 那是没有 WHERE 的 UPDATE，会把整站资料一次改掉');
    assert.equal(materials.adminListPublished().length, before, '★ 公开的资料数量变了，说明真的动了行');
  });

  test('★ 给一个不存在的 id：改 0 行，不抛异常', () => {
    seed();
    const before = materials.adminListPublished().length;
    assert.equal(materials.adminSetPublished({ id: 999999, published: 0 }), 0);
    assert.equal(materials.adminListPublished().length, before);
  });

  test('★ 按 id 下架：只动那一行，别人的不动', () => {
    seed();
    const all = materials.adminListPublished();
    assert.equal(all.length, 2, '（前提）此刻有 2 份公开的资料');

    assert.equal(materials.adminSetPublished({ id: all[0].id, published: 0 }), 1);

    const after = materials.adminListPublished();
    assert.equal(after.length, 1, '★ 应该只剩 1 份公开');
    assert.equal(after[0].id, all[1].id, '★ 下架错了行 —— 动到了另一份');
  });

  test('★ 按 userId 下架：只清那个人公开的', () => {
    const ids = seed();
    assert.equal(materials.adminSetPublished({ userId: ids[0], published: 0 }), 1);

    const after = materials.adminListPublished();
    assert.equal(after.length, 1, '★ 应该只剩另一个人的那一份');
    assert.equal(after[0].ownerId, ids[1], '★ 下架越界了 —— 动到了别人（甲）的东西');
  });

  test('★ 下架是「只改公开状态」，不是删东西', () => {
    seed();
    const d = db.getDb();
    const rowsBefore = Number(d.prepare('SELECT COUNT(*) AS c FROM materials').get().c);

    for (const r of materials.adminListPublished()) {
      materials.adminSetPublished({ id: r.id, published: 0 });
    }

    assert.equal(Number(d.prepare('SELECT COUNT(*) AS c FROM materials').get().c), rowsBefore,
      '★ 下架把资料删掉了 —— 那是个可逆操作，不该删任何一行');
  });

  test('★ 管理员列表带用户名（这是它唯一存在的理由）', () => {
    seed();
    const adminRows = materials.adminListPublished();
    assert.equal(adminRows.length, 2, '（前提）两份公开的资料都在列表里');
    assert.ok(adminRows.every((r) => typeof r.username === 'string' && r.username),
      '管理员看不到是谁放的，就没法判断该下架谁的');
  });
});
