/**
 * 登录鉴权。
 *
 * 用 node:crypto 的 scrypt 做密码哈希、HMAC-SHA256 做签名会话 Cookie，
 * 因此不需要 bcrypt / jsonwebtoken 之类的依赖。
 *
 * 多用户：一个账号一份数据，靠各业务表的 user_id 隔开（见 db/schema.js）。
 * 这里的职责只有「凭用户名密码认出是谁」和「认错人时别泄露信息」。
 */

import crypto from 'node:crypto';
import config from '../config.js';
import { get, run } from '../db/index.js';
import { parseCookies, serializeCookie, unauthorized } from './http.js';
import { isKnownSchool } from '../data/schools.js';

export const SESSION_COOKIE = 'sg_session';
const SESSION_DAYS = 30;

// ============================================================
// 密码哈希（scrypt）
// ============================================================

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/**
 * 生成密码哈希，格式：`scrypt$N$r$p$salt$hash`（全部十六进制）
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

/**
 * 校验密码。使用时间恒定比较，避免时序侧信道。
 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ============================================================
// 会话令牌（无状态签名 Cookie）
// ============================================================

function sign(payload) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');
}

/** 读某个用户的会话计数器（没有这个用户就返回 null） */
function sessionVersionOf(userId) {
  const row = get('SELECT session_version FROM users WHERE id = ?', userId);
  return row ? Number(row.session_version) || 0 : null;
}

/**
 * 生成会话令牌。格式：`v2.<userId>.<会话计数>.<过期时间戳>.<签名>`
 *
 * 中间那个计数是「吊销开关」：把 users.session_version +1，
 * 所有旧令牌立刻失效（见 schema.js 的 v5 迁移）。
 */
export function createToken(userId, days = SESSION_DAYS) {
  const expires = Date.now() + days * 86_400_000;
  const ver = sessionVersionOf(userId) ?? 0;
  const payload = `v2.${userId}.${ver}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验会话令牌，成功返回 payload，失败返回 null。
 *
 * 兼容升级前发出去的 `v1.<userId>.<过期>`：那种令牌没有计数值，
 * 一律按 0 处理。所以**升级本身不会把任何人踢下线**，
 * 而一旦某次「退出其他设备」把计数变成了 1，那些 v1 令牌同样立刻失效。
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;

  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  const expected = sign(payload);

  // 长度不等时 timingSafeEqual 会抛错，先做长度检查
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const parts = payload.split('.');
  let userId;
  let ver;
  let expires;
  if (parts[0] === 'v2' && parts.length === 4) {
    [, userId, ver, expires] = parts;
  } else if (parts[0] === 'v1' && parts.length === 3) {
    // 旧格式：没有计数值，当作 0
    [, userId, expires] = parts;
    ver = '0';
  } else {
    return null;
  }

  if (Number(expires) < Date.now()) return null;

  return { userId: Number(userId), sessionVersion: Number(ver) || 0, expires: Number(expires) };
}

/** 下发会话 Cookie */
export function setSessionCookie(res, userId) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, createToken(userId), {
      maxAge: SESSION_DAYS * 86_400,
      httpOnly: true,
      sameSite: 'Lax',
    }),
  );
}

/** 清除会话 Cookie */
export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' }),
  );
}

// ============================================================
// 请求上下文
// ============================================================

/**
 * 从请求里解析当前登录用户，未登录返回 null。
 * @returns {{id:number, username:string, display_name:string, school:string}|null}
 */
export function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifyToken(cookies[SESSION_COOKIE]);
  if (!payload) return null;

  const user = get(
    `SELECT id, username, display_name, school, college, major, avatar_ext, created_at, session_version
       FROM users WHERE id = ?`,
    payload.userId,
  );
  if (!user) return null;

  // 令牌里的计数和库里对不上 → 这个会话已经被「退出其他设备」或「改密码」作废了。
  // 注意：数据库里读出来的可能是 null（升级前建的行），统一按 0 算 ——
  // 和 verifyToken 里对 v1 旧令牌的处理保持一致，不然升级瞬间所有人都会掉线。
  if ((Number(user.session_version) || 0) !== payload.sessionVersion) return null;

  delete user.session_version;
  return user;
}

/**
 * 把这个人所有**其他**设备的登录作废。
 *
 * 做法是把 session_version +1：库里所有旧令牌的计数立刻对不上，
 * 而调用方要紧接着给自己重新下发一次 Cookie，当前这台设备才不会跟着掉线。
 */
export function revokeOtherSessions(userId) {
  run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', userId);
}

/** 把这个人已经发出去的日历订阅链接全部作废 */
export function revokeCalendarTokens(userId) {
  run('UPDATE users SET calendar_version = calendar_version + 1 WHERE id = ?', userId);
}

/**
 * 必须登录，否则抛 401。
 */
export function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw unauthorized('请先登录');
  return user;
}

// ============================================================
// 用户管理
// ============================================================

/** 是否已有账号（用于首启动引导） */
export function hasAnyUser() {
  const row = get('SELECT COUNT(*) AS c FROM users');
  return Number(row?.c || 0) > 0;
}

/**
 * 用户名规范化：去掉首尾空白。
 *
 * 存储和查询都走这一个函数，保证「同一个名字」在两边是同一个字符串 ——
 * 不做的话，注册时存的「小王 」和登录时输入的「小王」就是两个不同的键，
 * 用户会觉得「密码没错但登不上」。
 */
export function normalizeUsername(raw) {
  return String(raw ?? '').trim();
}

/**
 * 用户名校验。有问题返回一句中文说明，没问题返回空字符串。
 *
 * 抽成纯函数是为了能直接测：这些规则将来在「管理员改名」之类的入口
 * 也要用同一份，写在路由里就会慢慢各写一套、口径不一。
 */
export function usernameProblem(raw) {
  const name = normalizeUsername(raw);
  if (!name) return '请填写用户名';
  if (name.length < 2) return '用户名至少 2 个字符';
  if (name.length > 50) return '用户名太长了（最多 50 个字符）';
  // 控制字符（含换行、制表）会窜进日志、CSV 导出和页面标题里，
  // 正常用途一个都没有，所以直接拒掉，而不是清洗后放行
  if (/[\u0000-\u001f\u007f]/.test(name)) return '用户名里不能有换行或控制字符';
  return '';
}

/**
 * 密码最短长度。
 *
 * 从 6 位提到 8 位，是因为这个站开始给同学用了：以前只有自己一个账号，
 * 密码弱不弱是自己的事；现在**别人注册的密码是别人的风险**，
 * 而 6 位纯数字几秒钟就能枚举完。
 *
 * 导出成常量，是为了让「规则只写一处」：
 * 页面上的 `minlength`、提示文案、命令行脚本都从这里取，
 * 不然改了这里忘了那里，就会出现「页面说要 8 位、服务端只查 6 位」这种
 * 谁都发现不了的错位。
 *
 * 注意：**加长下限不影响已有账号**。登录只校验哈希，不看长度 ——
 * 老密码（哪怕是 6 位）照样能登进来，只是下次改密码时才受新规则约束。
 */
export const PASSWORD_MIN_LENGTH = 8;

/** 密码校验，同样返回错误说明 */
export function passwordProblem(password) {
  const raw = String(password ?? '');
  if (raw.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (raw.length > 200) return '密码太长了（最多 200 位）';
  return '';
}

/**
 * 根据用户名查用户（含密码哈希）。
 *
 * **区分大小写**：`Alice` 和 `alice` 是两个不同的账号，登录必须原样拼对。
 *
 * 这里和 createUser 用的是同一套口径（精确相等），所以「能注册出来」
 * 和「能登进去」永远是同一件事 —— 口径不一致的话会出现
 * 「注册时说这个名字被占了，登录时又登不进任何账号」这种死结。
 *
 * 注意 SQLite 的 TEXT 比较默认就是区分大小写的（BINARY），所以这里
 * 不需要 COLLATE，反而是**故意不要**加 NOCASE / lower()：
 *   · users.username 上的 UNIQUE 也是这个口径，`WHERE username = ?`
 *     正好能吃到它那个隐式索引，查询不会退化成全表扫。
 */
export function findUserByUsername(username) {
  const name = normalizeUsername(username);
  if (!name) return undefined;
  return get('SELECT * FROM users WHERE username = ?', name);
}

/**
 * 这个用户名是不是已经被占了。
 *
 * 同样是**精确相等**：`Winkie` 被占了不影响你注册 `winkie`，
 * 两个名字是两个账号。（v4 曾经禁止这种情况，v9 又放开了 ——
 * 见 schema.js 里 v4 / v9 两段注释。）
 */
export function isUsernameTaken(username) {
  return Boolean(findUserByUsername(username));
}

/** 创建用户 */
export function createUser({
  username, password, displayName = '', school = '', college = '', major = '',
}) {
  const name = normalizeUsername(username);
  const hash = hashPassword(password);
  try {
    const { lastInsertRowid } = run(
      `INSERT INTO users (username, password_hash, display_name, school, college, major)
       VALUES (?, ?, ?, ?, ?, ?)`,
      name,
      hash,
      displayName,
      school,
      college,
      major,
    );
    return get(
      'SELECT id, username, display_name, school, college, major, created_at FROM users WHERE id = ?',
      lastInsertRowid,
    );
  } catch (err) {
    // 撞唯一索引时给一句人话。
    // 上层确实会先查一次重名，但那是「先查再插」：两个人在同一瞬间提交
    // 就会双双通过检查。最终挡住的还是数据库，所以这里必须兜住，
    // 不能把 UNIQUE constraint failed 原样抛给用户看。
    if (/UNIQUE constraint failed/i.test(String(err?.message || ''))) {
      throw new Error(`用户名「${name}」已经有人用了，换一个吧`);
    }
    throw err;
  }
}

/**
 * 修改密码。
 *
 * 顺手把两个吊销计数都 +1：密码泄露是「钥匙丢了」最常见的原因，
 * 所以改密码应该同时做到两件事 ——
 *   · 把别人正拿着的登录状态踢掉（不然改了密码对方照样在线）
 *   · 把已经发出去的日历订阅链接作废（那个链接不需要登录就能看课表）
 * 调用方要紧接着给当前设备重新下发 Cookie，否则自己也会被踢下线。
 */
export function changePassword(userId, newPassword) {
  run(
    `UPDATE users SET password_hash = ?,
       session_version = session_version + 1,
       calendar_version = calendar_version + 1
     WHERE id = ?`,
    hashPassword(newPassword), userId,
  );
}

// ============================================================
// 个人资料（校友社区要用）
// ============================================================

/** 各字段长度上限。这些名字会显示给别人看，不设上限的话有人能拿它刷屏。 */
export const PROFILE_LIMITS = {
  displayName: 24,
  school: 60,
  college: 40,
  major: 40,
};

/**
 * 校验并规范化一份个人资料，返回可以直接写库的值。
 *
 * ⚠️ school 必须**在名单里**。这不是「最好校验一下」：
 *    校友社区里「同校」是唯一的可见性边界，学校字符串就是那个边界的全部依据。
 *    允许手填就等于允许任何人写「北京大学」，然后看到北大同学公开的资料。
 *
 * 空 school 允许（注册时选填），但那样的人不参与社区 ——
 * 前端要把这一点说清楚，而不是让人填完了才发现什么都看不到。
 *
 * @param {{displayName?:string, school?:string, college?:string, major?:string}} input
 * @throws {Error} 带中文、面向用户的原因
 */
export function normalizeProfile(input = {}) {
  const clean = (v, max, label) => {
    // 把连续空白压成一个空格：昵称里塞一堆空格会把别人的列表撑歪
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (s.length > max) throw new Error(`${label}不能超过 ${max} 个字`);
    return s;
  };

  const displayName = clean(input.displayName, PROFILE_LIMITS.displayName, '昵称');
  const school = clean(input.school, PROFILE_LIMITS.school, '学校');
  const college = clean(input.college, PROFILE_LIMITS.college, '学院');
  const major = clean(input.major, PROFILE_LIMITS.major, '专业');

  if (school && !isKnownSchool(school)) {
    throw new Error(`「${school}」不在学校名单里。请从提示里选一个，或者把校名写全 ——`
      + '社区是按学校分的，名字对不上就找不到同学。');
  }

  return { displayName, school, college, major };
}

/** 写个人资料 */
export function updateProfile(userId, data) {
  const p = normalizeProfile(data);
  run(
    'UPDATE users SET display_name = ?, school = ?, college = ?, major = ? WHERE id = ?',
    p.displayName, p.school, p.college, p.major, userId,
  );
  return p;
}

/**
 * 这个人的学校是不是「从名单里选的」。
 *
 * 老账号的 school 是手填的（那时候还没有名单）。**不能因为对不上就把它删掉** ——
 * 那是用户自己填的。所以这里只做标记：页面上显示「未从名单选择」并提示重选一次；
 * 在重选之前这个人不参与社区（同校判断匹配不上，这是名单方案的必然代价）。
 */
export function schoolIsVerified(school) {
  return isKnownSchool(school);
}

/** 首页应该跳去哪里：没账号跳初始化，有账号未登录跳登录页 */
export function bootstrapState() {  return { initialized: hasAnyUser() };
}
