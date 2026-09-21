/**
 * 校友社区的可见性规则。
 *
 * 整个社区只有一条边界：**同校**。而「同校」= 两个人的 school 字符串
 * **精确相等**，并且**双方都得是从名单里选的**（见 src/data/schools.js）。
 *
 * 为什么双方都要「已验证」：只要求一方的话，一个把学校填成「北京大学」的人
 * 只要和某个北大同学字符串相同就能看见对方 —— 而他的名字是自己挑的。
 * 要求双方都来自名单，等于要求两个人都真的从下拉里选过。
 *
 * ⚠️ 这个文件里的函数是**授权判断的唯一出口**。头像、资料、社区列表
 *    全都走这里，不要在别处再写一遍 `a.school === b.school` ——
 *    那种散落的判断早晚会漏掉「已公开」「已验证」里的某一个条件，
 *    而漏掉的后果是别人能看到本不该看到的东西。
 */

import { get } from '../db/index.js';
import { schoolIsVerified } from './auth.js';

/**
 * 两个人的学校是不是同一所、而且都来自名单。
 *
 * @param {string} aSchool
 * @param {string} bSchool
 */
export function sameSchool(aSchool, bSchool) {
  const a = String(aSchool || '').trim();
  const b = String(bSchool || '').trim();
  if (!a || !b) return false;              // 没填学校的人不参与社区
  if (a !== b) return false;               // 精确相等，不做模糊匹配
  return schoolIsVerified(a);
}

/** 取某人的展示信息（社区里只用这些字段，**不含用户名**） */
export function publicProfile(userId) {
  const row = get(
    `SELECT id, display_name, school, college, major, avatar_ext, created_at
       FROM users WHERE id = ?`,
    userId,
  );
  if (!row) return null;
  // ⚠️ 刻意**不返回 username**。用户名是登录凭据，
  //    同校陌生人看到之后可以拿去试密码；社区里只需要认得出人，
  //    昵称 + 头像就够了。要加字段之前先想清楚这一点。
  return {
    id: row.id,
    displayName: row.display_name || '',
    school: row.school || '',
    college: row.college || '',
    major: row.major || '',
    hasAvatar: Boolean(row.avatar_ext),
    joinedAt: row.created_at || '',
  };
}

/**
 * 甲能不能看乙的头像。
 *
 * 规则：看自己永远可以；看别人要**同校**。
 * 这里只回答「能不能看」，不回答「要不要展示」—— 展示与否由页面决定。
 */
export function canViewAvatar(viewerId, ownerId) {
  if (Number(viewerId) === Number(ownerId)) return true;
  const viewer = get('SELECT school FROM users WHERE id = ?', viewerId);
  const owner = get('SELECT school FROM users WHERE id = ?', ownerId);
  if (!viewer || !owner) return false;
  return sameSchool(viewer.school, owner.school);
}

/**
 * 甲能不能看乙的资料（列表项）。
 *
 * 「乙的资料」= 乙主动勾了「公开给同校」的那些。所以这里要同时满足：
 *   1. 双方同校且都已验证；
 *   2. 那份资料本身是公开的（由调用方查出来传进来 —— 因为它属于 materials 表，
 *      这个模块不该知道材料表长什么样）。
 *
 * @param {number} viewerId
 * @param {number} ownerId
 * @param {{published?: boolean|number}} material
 */
export function canViewMaterial(viewerId, ownerId, material) {
  if (!material) return false;
  if (Number(viewerId) === Number(ownerId)) return true;   // 自己的永远能看
  if (!material.published) return false;                   // 没公开就不给看
  const viewer = get('SELECT school FROM users WHERE id = ?', viewerId);
  const owner = get('SELECT school FROM users WHERE id = ?', ownerId);
  if (!viewer || !owner) return false;
  return sameSchool(viewer.school, owner.school);
}
