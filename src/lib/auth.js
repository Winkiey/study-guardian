/**
 * 登录鉴权。
 *
 * 用 node:crypto 的 scrypt 做密码哈希、HMAC-SHA256 做签名会话 Cookie，
 * 因此不需要 bcrypt / jsonwebtoken 之类的依赖。
 *
 * 设计上是「单用户自用」，但数据表带 user_id，
 * 未来开源成多用户版本时只需放开注册接口。
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

/** 根据用户名查用户（含密码哈希） */
export function findUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', String(username || '').trim());
}

/** 创建用户 */
export function createUser({ username, password, displayName = '', school = '' }) {
  const hash = hashPassword(password);
  const { lastInsertRowid } = run(
    `INSERT INTO users (username, password_hash, display_name, school)
     VALUES (?, ?, ?, ?)`,
    String(username).trim(),
    hash,
    displayName,
    school,
  );
  return get('SELECT id, username, display_name, school, created_at FROM users WHERE id = ?', lastInsertRowid);
}

/** 修改密码 */
export function changePassword(userId, newPassword) {
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), userId);
}

/** 首页应该跳去哪里：没账号跳初始化，有账号未登录跳登录页 */
export function bootstrapState() {
  return { initialized: hasAnyUser() };
}
