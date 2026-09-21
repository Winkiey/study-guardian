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

import { get, all } from '../db/index.js';
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

// ============================================================
// 社区列表
// ============================================================

/**
 * 我所在的那所学校（已验证才返回，否则空串）。社区相关的查询都从这里起步。
 *
 * 返回空串意味着「这个人不参与社区」—— 所有列表查询因此返回**空数组**而不是抛错。
 * 理由：没填学校 / 手填了对不上名单的学校是很正常的状态（老账号就是这样），
 * 不该让页面报错，只该让社区是空的，并在页面上说清原因。
 */
function myVerifiedSchool(viewerId) {
  const me = get('SELECT school FROM users WHERE id = ?', viewerId);
  const school = String(me?.school || '').trim();
  return school && schoolIsVerified(school) ? school : '';
}

/**
 * 能不能看某个人的社区页。
 *
 * 自己永远能看；别人要**同校**。回 404 还是 403 由调用方决定 ——
 * 页面那边统一回 404（403 等于确认「这个人存在」）。
 */
export function canViewCommunityUser(viewerId, ownerId) {
  if (Number(viewerId) === Number(ownerId)) return true;
  const school = myVerifiedSchool(viewerId);
  if (!school) return false;
  const owner = get('SELECT school FROM users WHERE id = ?', ownerId);
  return Boolean(owner) && String(owner.school || '').trim() === school;
}

/** 个人资料页用：我公开了多少份 */
export function myPublishedCount(userId) {
  const row = get(
    'SELECT COUNT(*) AS c FROM materials WHERE user_id = ? AND published = 1',
    userId,
  );
  return Number(row?.c) || 0;
}

/**
 * 社区资料流：**同校同学**公开出来的资料。
 *
 * 三条硬约束全部写在 SQL 的 WHERE 里，不在 JS 侧再过滤一遍 ——
 * 多一层过滤就多一处会漏的地方，而漏的方向是"看到了不该看的"。
 *   1. 资料是公开的；
 *   2. 主人和我同校（字符串精确相等）；
 *   3. 而且我的校名**在名单里**（下面单独说明）。
 *
 * ⚠️ 第 3 条最容易漏：只比较 `u.school = ?` 的话，两个都把学校填成
 *    「家里蹲大学」的人会互相看到 —— 而那个名字是他们自己挑的。
 *    所以先把校名送去 isKnownSchool 卡一道，不过就整体返回空。
 *
 * 返回的字段**不含用户名**（见上面 publicProfile 的说明），
 * 也不含别人的 stored_name（磁盘文件名）—— 那个只在文件服务里用。
 */
export function communityFeed(viewerId, opts = {}) {
  const school = myVerifiedSchool(viewerId);
  if (!school) return [];

  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  const params = [school, viewerId];
  let courseFilter = '';
  if (opts.courseId) {
    courseFilter = ' AND m.course_id = ?';
    params.push(Number(opts.courseId));
  }
  params.push(limit);

  return all(
    `SELECT m.id, m.title, m.description, m.kind, m.category,
            m.size, m.created_at, m.updated_at, m.pdf_name,
            u.id AS owner_id, u.display_name, u.college, u.major, u.avatar_ext,
            c.name AS course_name, c.color AS course_color
       FROM materials m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE m.published = 1
        AND u.school = ?
        AND u.id <> ?
        ${courseFilter}
      ORDER BY m.updated_at DESC
      LIMIT ?`,
    ...params,
  ).map((r) => ({
    id: r.id,
    title: r.title || '',
    description: r.description || '',
    kind: r.kind || '',
    category: r.category || '',
    size: r.size,
    // ⚠️ materials 表里**没有** has_pdf 这一列，它是从 pdf_name 派生的。
    //    写成 m.has_pdf 会让这条 SQL 直接报错、整页 500 ——
    //    这是 E2E 抓到的（"社区页能打开 → 状态码 500"）。
    hasPdf: Boolean(r.pdf_name),
    updatedAt: r.updated_at || r.created_at || '',
    course: r.course_name ? { name: r.course_name, color: r.course_color || '' } : null,
    owner: {
      id: r.owner_id,
      displayName: r.display_name || '',
      college: r.college || '',
      major: r.major || '',
      hasAvatar: Boolean(r.avatar_ext),
    },
  }));
}

/**
 * 同校校友：至少公开过一份资料的人。
 *
 * 一份都没公开的人不出现在这里 —— 这是「有东西可看的人」的列表，
 * 不是全校同学名册（那是另一件事，涉及隐私，不该顺手做）。
 */
export function alumniList(viewerId, opts = {}) {
  const school = myVerifiedSchool(viewerId);
  if (!school) return [];

  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  return all(
    `SELECT u.id, u.display_name, u.college, u.major, u.avatar_ext,
            COUNT(m.id) AS shared_count
       FROM users u
       JOIN materials m ON m.user_id = u.id AND m.published = 1
      WHERE u.school = ? AND u.id <> ?
      GROUP BY u.id
      ORDER BY shared_count DESC, u.id ASC
      LIMIT ?`,
    school, viewerId, limit,
  ).map((r) => ({
    id: r.id,
    displayName: r.display_name || '',
    college: r.college || '',
    major: r.major || '',
    hasAvatar: Boolean(r.avatar_ext),
    sharedCount: Number(r.shared_count) || 0,
  }));
}

/**
 * 某个校友公开出来的资料（校友页用）。
 *
 * **不是同校就返回空数组**（而不是抛错）：调用方因此只需要判断"空不空"，
 * 不用再判断"能不能看" —— 少一个地方会写错。
 */
export function alumniMaterials(viewerId, ownerId, opts = {}) {
  const school = myVerifiedSchool(viewerId);
  if (!school) return [];
  const owner = get('SELECT school FROM users WHERE id = ?', ownerId);
  if (!owner || String(owner.school || '').trim() !== school) return [];

  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  return all(
    `SELECT id, title, kind, category, size, pdf_name, updated_at, created_at
       FROM materials
      WHERE user_id = ? AND published = 1
      ORDER BY updated_at DESC
      LIMIT ?`,
    ownerId, limit,
  ).map((r) => ({
    id: r.id,
    title: r.title || '',
    kind: r.kind || '',
    category: r.category || '',
    size: r.size,
    hasPdf: Boolean(r.pdf_name),
    updatedAt: r.updated_at || r.created_at || '',
  }));
}
