/**
 * 昵称禁词。
 *
 * 这个文件的重点是**两个方向都要钉**：
 *   1. 该挡的挡住了（不然功能没意义）；
 *   2. **不该挡的没被挡**（不然词表会越收越宽，最后谁的名字都过不了）。
 *
 * 第 2 条不是"顺手加的"：判断用的是**子串匹配**（中文没有词边界，
 * 又不想为零依赖的项目引入分词），所以「姑娘」「师父」「字母」「大哥」
 * 这类词天然处在误伤边缘 —— 它们分别含 `娘/父/母/哥`，
 * 词表里只要有人手滑收进一个单字，它们就全废了。
 * 所以这几条单独列出来，当成"词表的边界"来钉。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-nickname-test-'));
process.env.DATA_DIR = DATA_DIR;

let nick;
let auth;
let db;

before(async () => {
  nick = await import('../src/lib/nickname.js');
  auth = await import('../src/lib/auth.js');
  db = await import('../src/db/index.js');
  db.getDb();
});

after(() => {
  db?.closeDb?.();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('★ 该挡的挡住', () => {
  test('★ 亲属称谓一律拒绝（用户点名要的那几个）', () => {
    for (const bad of ['父亲', '爸爸', '妈妈', '老爹', '爷爷', '奶奶', '哥哥', '姐姐',
      '老公', '老婆', '儿子', '女儿', '叔叔', '阿姨']) {
      assert.ok(nick.isNicknameBanned(bad), `「${bad}」应该被拒绝`);
    }
  });

  test('★ 主仆 / 尊卑词一律拒绝', () => {
    for (const bad of ['主人', '主子', '奴才', '奴婢', '仆人', '少爷', '老爷']) {
      assert.ok(nick.isNicknameBanned(bad), `「${bad}」应该被拒绝`);
    }
  });

  test('★ 夹在长昵称里也算（不是只比整串相等）', () => {
    assert.ok(nick.isNicknameBanned('叫我爸爸'));
    assert.ok(nick.isNicknameBanned('爸爸带你飞'));
    assert.ok(nick.isNicknameBanned('小王的主人'));
    assert.ok(nick.isNicknameBanned(' 爸爸 '));   // 两边有空格也不行
  });

  test('★ 全角 / 大小写绕道没用', () => {
    assert.ok(nick.isNicknameBanned('ＢＡＢＡ爸爸'), '全角数字不影响中文命中');
    assert.ok(nick.isNicknameBanned('My主人'), '英文混中文照样命中');
  });

  test('★ 报错要说清是**哪个词**命中的（不然用户只能一次次试）', () => {
    const msg = nick.nicknameProblem('叫我爸爸');
    assert.ok(msg.includes('爸爸'), `报错里应该点名是哪个词：${msg}`);
    assert.ok(msg.includes('换一个'), '要给出下一步该干什么');
  });

  test('空昵称不算违禁（空昵称是允许的，只是进不了社区）', () => {
    assert.equal(nick.nicknameProblem(''), '');
    assert.equal(nick.nicknameProblem('   '), '');
    assert.equal(nick.nicknameProblem(null), '');
    assert.equal(nick.nicknameProblem(undefined), '');
  });
});

describe('★★ 不该挡的没被挡（词表的边界）', () => {
  test('★★ 含「娘/父/母/哥」的正常词必须能用', () => {
    // 这几条是词表**没有收单字**的证据。收了单字它们就全废。
    // （「姨妈」「阿姨」本来就在禁词表里，所以不放在这一组 —— 它们是该挡的。）
    for (const ok of ['姑娘', '师父', '字母', '大哥', '师兄', '师妹', '母语', '父老']) {
      assert.equal(nick.isNicknameBanned(ok), false,
        `「${ok}」不该被挡 —— 词表里混进了单字？`);
    }
  });

  test('★★ 常见的学生昵称都能用', () => {
    for (const ok of ['小王', '阿伟', '李雷', 'Tom', '夜跑者', '干饭人',
      '统计学徒', '二教常驻', '熬夜冠军', '图书馆钉子户', '爱睡觉的猫',
      '分子生物学', '母校门口']) {
      assert.equal(nick.isNicknameBanned(ok), false, `「${ok}」不该被挡`);
    }
  });

  test('词表里不许出现单字（这一条是给以后加词的人看的）', () => {
    const singles = nick.BANNED_NICKNAME_WORDS.filter((w) => w.length === 1);
    // 「爹」是唯一被允许的单字：它几乎不出现在别的词里（干爹/爹娘也都是它）
    assert.deepEqual(singles, ['爹'],
      '加单字之前先确认它不会出现在正常词里（见本文件上面那两条）');
  });
});

describe('★ safeDisplayName：给别人看的那一份', () => {
  test('★ 违禁昵称对外变成空串（调用方原有的兜底就生效了）', () => {
    assert.equal(nick.safeDisplayName('爸爸'), '');
    assert.equal(nick.safeDisplayName('叫我主人'), '');
  });

  test('正常昵称原样返回，空值安全', () => {
    assert.equal(nick.safeDisplayName('小王'), '小王');
    assert.equal(nick.safeDisplayName(''), '');
    assert.equal(nick.safeDisplayName(null), '');
    assert.equal(nick.safeDisplayName(undefined), '');
  });
});

describe('★★ 写入这一侧：两条路都被挡住', () => {
  test('★★ 注册时不许用违禁昵称（createUser 自己就拦）', () => {
    assert.throws(
      () => auth.createUser({ username: 'banned1', password: 'test123456', displayName: '爸爸' }),
      /爸爸/,
      '★ createUser 没拦住 —— 注册这条路绕过了 normalizeProfile',
    );
    assert.equal(auth.findUserByUsername('banned1'), undefined, '★ 被拒之后不该留下半个账号');
  });

  test('★★ 改资料时也不许（normalizeProfile 拦）', () => {
    assert.throws(() => auth.normalizeProfile({ displayName: '主人' }), /主人/);
  });

  test('★ 空昵称照旧可以（改资料时清空昵称是合法的）', () => {
    assert.equal(auth.normalizeProfile({ displayName: '' }).displayName, '');
  });

  test('★ 两条路用的是同一份词表（不能一边拦一边放）', () => {
    // 随便挑几个词，两条路必须给出同样的结论
    for (const w of ['爸爸', '主人', '少爷']) {
      let byProfile = false;
      try { auth.normalizeProfile({ displayName: w }); } catch { byProfile = true; }
      let byCreate = false;
      try {
        auth.createUser({ username: `t${Math.random().toString(36).slice(2, 9)}`, password: 'test123456', displayName: w });
      } catch { byCreate = true; }
      assert.equal(byProfile, true, `normalizeProfile 放过了「${w}」`);
      assert.equal(byCreate, true, `createUser 放过了「${w}」`);
    }
  });
});
