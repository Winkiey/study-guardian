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

/**
 * 生成会话令牌。格式：`v1.<userId>.<过期时间戳>.<签名>`
 */
export function createToken(userId, days = SESSION_DAYS) {
  const expires = Date.now() + days * 86_400_000;
  const payload = `v1.${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验会话令牌，成功返回 payload，失败返回 null。
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

  const [version, userId, expires] = payload.split('.');
  if (version !== 'v1') return null;
  if (Number(expires) < Date.now()) return null;

  return { userId: Number(userId), expires: Number(expires) };
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
    'SELECT id, username, display_name, school, created_at FROM users WHERE id = ?',
    payload.userId,
  );
  return user || null;
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
 * 不区分大小写，而且和 createUser 用的是同一套唯一性口径：
 * 库里不会有只差大小写的两个账号（v4 的唯一索引保证），
 * 所以这里 lower() 一定能命中唯一一行；反过来如果查询区分大小写，
 * 用户注册时填了 Alice、登录时敲 alice 就会「密码正确却登不上」。
 *
 * 注意：SQLite 的 lower() 只折叠 ASCII。中文和多数字符不受影响，
 * 所以这不是个问题 —— 只是别指望它能把 É 和 é 归一。
 */
export function findUserByUsername(username) {
  const name = normalizeUsername(username);
  if (!name) return undefined;
  return get('SELECT * FROM users WHERE lower(username) = lower(?)', name);
}

/** 这个用户名是不是已经被占了（含只差大小写的情况） */
export function isUsernameTaken(username) {
  return Boolean(findUserByUsername(username));
}

/** 创建用户 */
export function createUser({ username, password, displayName = '', school = '' }) {
  const name = normalizeUsername(username);
  const hash = hashPassword(password);
  try {
    const { lastInsertRowid } = run(
      `INSERT INTO users (username, password_hash, display_name, school)
       VALUES (?, ?, ?, ?)`,
      name,
      hash,
      displayName,
      school,
    );
    return get('SELECT id, username, display_name, school, created_at FROM users WHERE id = ?', lastInsertRowid);
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

/** 修改密码 */
export function changePassword(userId, newPassword) {
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
}

/** 首页应该跳去哪里：没账号跳初始化，有账号未登录跳登录页 */
export function bootstrapState() {
  return { initialized: hasAnyUser() };
}
