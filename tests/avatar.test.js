/**
 * 头像 + 社区可见性。
 *
 * 两件事都属于「错了不会报错，但后果很实在」：
 *
 * 1. **头像的格式判断。** 只看扩展名和 MIME 的话，一个改名的
 *    `x.php`→`x.png` 会被照单全收；不限像素的话，几十 KB 的 PNG
 *    可以声称自己 5 万×5 万（和 PDF 那边的解压炸弹是同一类问题）。
 *
 * 2. **可见性判断。** 「同校」= 学校字符串精确相等，而且**双方都从名单里选过**。
 *    这一条要是松了，把学校填成「北京大学」的人就能看到北大同学的东西 ——
 *    而那个名字是他自己挑的。
 *
 * ⚠️ 后面那些断言里，很多是在守「**不**该发生什么」：不同校看不到、
 *    没公开看不到、没验证看不到、community 的资料里没有用户名。
 *    这类断言才是真正挡住信息泄露的东西。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-avatar-test-'));
process.env.DATA_DIR = DATA_DIR;

let avatar;
let community;
let auth;
let db;
let png;

before(async () => {
  avatar = await import('../src/lib/avatar.js');
  community = await import('../src/lib/community.js');
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  png = await import('../src/lib/png.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** 造一张真正合法的 PNG（用项目自己的编码器，省得手搓字节） */
function makePng(w = 4, h = 3) {
  const data = Buffer.alloc(w * h * 3, 0x40);
  return png.encodePng({ width: w, height: h, channels: 3, data });
}

/** 造一张带 SOF0 的最小 JPEG（只要能读出宽高就够） */
function makeJpeg(w = 10, h = 7) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);      // 段长
  sof[4] = 8;                    // 精度
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;                    // 分量数
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),   // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),  // APP0
    sof,
    Buffer.from([0xff, 0xd9]),   // EOI
  ]);
}

let seq = 0;
const newUser = (extra = {}) => auth.createUser({
  username: `a${(seq += 1)}_${Math.random().toString(36).slice(2, 7)}`,
  password: 'test123456',
  ...extra,
});

const SCHOOL = '东北财经大学';

// ============================================================
// 格式识别：只看文件头
// ============================================================

describe('★ 头像格式：只看文件头，不信扩展名', () => {
  test('认得 PNG 和 JPEG', () => {
    assert.equal(avatar.sniffImageType(makePng()), 'png');
    assert.equal(avatar.sniffImageType(makeJpeg()), 'jpeg');
  });

  test('★ 其它格式一律不认（包括改名成 .png 的文本）', () => {
    assert.equal(avatar.sniffImageType(Buffer.from('<?php echo 1; ?>')), null);
    assert.equal(avatar.sniffImageType(Buffer.from('GIF89a')), null, 'GIF 不在支持列表里');
    assert.equal(avatar.sniffImageType(Buffer.from('RIFF....WEBP')), null,
      'WebP 有意不收 —— 宽高藏在三种不同的块里，收益却很小');
    assert.equal(avatar.sniffImageType(Buffer.alloc(0)), null);
    assert.equal(avatar.sniffImageType(null), null);
  });

  test('★ 名字叫 .png 但内容是文本 → 被拒（扩展名不作数）', () => {
    assert.throws(() => avatar.checkAvatar(Buffer.from('这不是图片，只是名字叫 a.png')),
      /不是 PNG 或 JPEG/);
  });
});

describe('★ 尺寸：读图片自己声明的宽高', () => {
  test('PNG 从 IHDR 读', () => {
    assert.deepEqual(avatar.readImageSize(makePng(12, 34), 'png'), { width: 12, height: 34 });
  });

  test('★ JPEG 要扫段找 SOFn（不能只看开头几个字节）', () => {
    assert.deepEqual(avatar.readImageSize(makeJpeg(20, 15), 'jpeg'), { width: 20, height: 15 });
  });

  test('读不出来时返回 null，不抛异常', () => {
    assert.equal(avatar.readImageSize(Buffer.alloc(4), 'png'), null);
    assert.equal(avatar.readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg'), null);
    assert.equal(avatar.readImageSize(Buffer.alloc(10), '未知格式'), null);
  });
});

describe('★ 校验：三个上限', () => {
  test('体积上限', () => {
    const huge = Buffer.concat([makePng(), Buffer.alloc(3 * 1024 * 1024)]);
    assert.throws(() => avatar.checkAvatar(huge), /不能超过/);
  });

  test('★ 像素上限（体积小但声称很大 —— 这就是炸弹）', () => {
    // 真造一张 5000×5000 的 PNG 太大，直接伪造 IHDR 里的宽高：
    // 只有几十字节，却声称自己是 5000×5000。
    const fake = Buffer.from(makePng(4, 3));
    fake.writeUInt32BE(5000, 16);
    fake.writeUInt32BE(5000, 20);
    assert.throws(() => avatar.checkAvatar(fake), /图片太大了/,
      '★ 只看体积是挡不住这种的');
  });

  test('空内容', () => {
    assert.throws(() => avatar.checkAvatar(Buffer.alloc(0)), /没有收到图片内容/);
  });

  test('合格时返回类型和尺寸', () => {
    const info = avatar.checkAvatar(makePng(8, 6));
    assert.equal(info.type, 'png');
    assert.equal(info.ext, 'png');
    assert.equal(info.width, 8);
    assert.equal(info.height, 6);
  });
});

// ============================================================
// 存储
// ============================================================

describe('★ 存储：按用户隔离、换头像不留旧文件', () => {
  test('★ 存下来、读得到、库里有标记', () => {
    const u = newUser();
    avatar.saveAvatar(u.id, makePng(5, 5));
    assert.equal(avatar.avatarExtOf(u.id), 'png');
    assert.ok(avatar.avatarExists(u.id));
    // 路径里只有数字 userId 和固定扩展名，不含用户提供的字符串
    assert.equal(avatar.avatarPath(u.id, 'png'), path.join(DATA_DIR, 'avatars', `${u.id}.png`));
  });

  test('★ 换格式时旧文件被删掉（否则读到哪个看运气）', () => {
    const u = newUser();
    avatar.saveAvatar(u.id, makePng(5, 5));
    const oldFile = avatar.avatarPath(u.id, 'png');
    assert.ok(fs.existsSync(oldFile));

    avatar.saveAvatar(u.id, makeJpeg(5, 5));
    // ⚠️ 库里存的是**扩展名**（jpg），不是类型名（jpeg）。
    //    第一版我在这里写成了 'jpeg'，顺带发现模块里也混了这两套名字 ——
    //    结果是 avatarMime('jpg') 查不到、退回 image/png，
    //    一张 JPEG 头像被当成 PNG 发出去。
    assert.equal(avatar.avatarExtOf(u.id), 'jpg');
    assert.equal(avatar.avatarMime('jpg'), 'image/jpeg', '★ JPEG 头像被当成 PNG 发出去了');
    assert.equal(avatar.avatarMime('png'), 'image/png');
    assert.ok(!fs.existsSync(oldFile), '★ 换了头像，旧的 png 还在磁盘上');
    assert.ok(fs.existsSync(avatar.avatarPath(u.id, 'jpg')));
  });

  test('★ 头像文件互相隔离（不能读到别人的）', () => {
    const a = newUser();
    const b = newUser();
    avatar.saveAvatar(a.id, makePng(5, 5));
    assert.equal(avatar.avatarExists(b.id), false, '★ 没上传过的人居然"有"头像');
    assert.notEqual(avatar.avatarPath(a.id, 'png'), avatar.avatarPath(b.id, 'png'));
  });

  test('删除之后标记和文件都没了', () => {
    const u = newUser();
    avatar.saveAvatar(u.id, makePng(5, 5));
    avatar.removeAvatar(u.id);
    assert.equal(avatar.avatarExtOf(u.id), '');
    assert.equal(avatar.avatarExists(u.id), false);
  });

  test('★ 校验不过时不写文件也不写库（不能留半个状态）', () => {
    const u = newUser();
    assert.throws(() => avatar.saveAvatar(u.id, Buffer.from('不是图片')));
    assert.equal(avatar.avatarExtOf(u.id), '');
    assert.equal(avatar.avatarExists(u.id), false);
  });

  test('userId 拼进路径，不会被奇怪的 id 带出目录', () => {
    // 路径是 `Number(userId)` 拼的，所以字符串 id 会被转成 NaN —— 但即使
    // 传进来 '../evil'，结果也只是 `NaN.png`，出不了 avatars 目录。
    const p = avatar.avatarPath('../evil', 'png');
    assert.equal(path.dirname(p), path.join(DATA_DIR, 'avatars'));
  });
});

// ============================================================
// 可见性（这一组是社区的地基）
// ============================================================

describe('★ 同校判断', () => {
  test('同校且都来自名单 → true', () => {
    assert.equal(community.sameSchool(SCHOOL, SCHOOL), true);
  });

  test('★ 不同校 → false', () => {
    assert.equal(community.sameSchool(SCHOOL, '北京大学'), false);
  });

  test('★ 空学校 → false（没填学校的人不参与社区）', () => {
    assert.equal(community.sameSchool('', SCHOOL), false);
    assert.equal(community.sameSchool(SCHOOL, ''), false);
    assert.equal(community.sameSchool('', ''), false);
  });

  test('★ 手填的、不在名单里的学校 → false（两边都算不上同校）', () => {
    // 这一条很关键：把学校填成「家里蹲大学」的人，即使另一个人填了一模一样的
    // 字符串，也不算同校 —— 因为那个名字不在名单里，谁都可以自称。
    assert.equal(community.sameSchool('家里蹲大学', '家里蹲大学'), false);
  });

  test('前后空格不影响判断', () => {
    assert.equal(community.sameSchool(` ${SCHOOL} `, SCHOOL), true);
  });
});

describe('★ 头像可见性：自己 或 同校', () => {
  test('自己看自己永远可以（哪怕没填学校）', () => {
    const u = newUser();
    assert.equal(community.canViewAvatar(u.id, u.id), true);
  });

  test('★ 同校同学可以看', () => {
    const a = newUser({ school: SCHOOL });
    const b = newUser({ school: SCHOOL });
    assert.equal(community.canViewAvatar(a.id, b.id), true);
  });

  test('★ 不同校看不到', () => {
    const a = newUser({ school: SCHOOL });
    const b = newUser({ school: '北京大学' });
    assert.equal(community.canViewAvatar(a.id, b.id), false);
  });

  test('★ 对方手填了同名学校也看不到（没从名单选过）', () => {
    const a = newUser({ school: SCHOOL });
    const b = newUser({ school: '某个不在名单里的学院' });
    assert.equal(community.canViewAvatar(a.id, b.id), false);
  });

  test('目标是自己的账号但自己没填学校 → 仍然可以看自己', () => {
    const u = newUser();
    assert.equal(community.canViewAvatar(u.id, u.id), true);
  });

  test('不存在的用户 → false，不抛异常', () => {
    const u = newUser({ school: SCHOOL });
    assert.equal(community.canViewAvatar(u.id, 999999), false);
    assert.equal(community.canViewAvatar(999999, u.id), false);
  });
});

describe('★ 社区里的资料里不许有用户名', () => {
  test('★ publicProfile 返回的字段里没有 username', () => {
    const u = newUser({
      username: 'secret_login_name', displayName: '小王', school: SCHOOL,
      college: '金融科技学院', major: '金融科技',
    });
    const p = community.publicProfile(u.id);
    assert.equal(p.displayName, '小王');
    assert.equal(p.school, SCHOOL);
    assert.equal(p.college, '金融科技学院');
    assert.equal(p.major, '金融科技');
    // ⚠️ 这条是本项目里最要紧的隐私断言之一：用户名是登录凭据，
    //    泄露给同校陌生人等于把「试密码」的起点送出去。
    assert.equal('username' in p, false, '★ publicProfile 里带出了 username');
    assert.ok(!JSON.stringify(p).includes('secret_login_name'),
      '★ 序列化之后用户名还是漏出来了');
  });

  test('不存在的人返回 null', () => {
    assert.equal(community.publicProfile(999999), null);
  });
});

describe('★ 资料可见性：本人 或（已公开 且 同校）', () => {
  const withSchool = (school) => newUser({ school });

  test('本人永远能看自己的（哪怕没公开）', () => {
    const u = withSchool(SCHOOL);
    assert.equal(community.canViewMaterial(u.id, u.id, { published: 0 }), true);
  });

  test('★ 同校 + 已公开 → 能看', () => {
    const a = withSchool(SCHOOL);
    const b = withSchool(SCHOOL);
    assert.equal(community.canViewMaterial(a.id, b.id, { published: 1 }), true);
  });

  test('★ 同校但没公开 → 看不到（默认就是没公开）', () => {
    const a = withSchool(SCHOOL);
    const b = withSchool(SCHOOL);
    assert.equal(community.canViewMaterial(a.id, b.id, { published: 0 }), false);
    assert.equal(community.canViewMaterial(a.id, b.id, {}), false, '缺字段按没公开处理');
  });

  test('★ 已公开但不同校 → 看不到', () => {
    const a = withSchool(SCHOOL);
    const b = withSchool('北京大学');
    assert.equal(community.canViewMaterial(a.id, b.id, { published: 1 }), false);
  });

  test('★ 没填学校的人：既看不到别人的，别人也看不到他的', () => {
    const a = withSchool(SCHOOL);
    const b = withSchool('');
    assert.equal(community.canViewMaterial(b.id, a.id, { published: 1 }), false);
    assert.equal(community.canViewMaterial(a.id, b.id, { published: 1 }), false);
  });

  test('资料不存在 → false', () => {
    const a = withSchool(SCHOOL);
    assert.equal(community.canViewMaterial(a.id, a.id, null), false);
  });
});
