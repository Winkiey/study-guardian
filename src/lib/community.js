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
import { getSetting, setSetting } from './settings.js';

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
 * 社区流的可见性条件 —— **只写一处**，下面三个查询共用：
 * 列表（communityFeed）、总数（countCommunityFeed）、未读数（communityNewCount）。
 *
 * 为什么非要抽出来：这三个数字都是给用户看的，分开写就会出现
 * 「列表里 3 份、底部写共 2 份」或者「角标说有 1 份新的、点进去什么都没有」。
 * 这种错**不会报错**，只会让人不再相信那个数字 —— 而"信不信社区里的东西"
 * 恰好是这个功能唯一的价值。
 *
 * ⚠️ 调用方必须 `JOIN users u ON u.id = m.user_id`（条件里用到了 u.school）。
 * ⚠️ 只比较 `u.school = ?` 还不够：校名必须来自名单，否则两个都把学校填成
 *    「家里蹲大学」的人会互相看到 —— 而那个名字是他们自己挑的。
 *    名单那一道由 myVerifiedSchool 卡住，不过就整体返回 null。
 *
 * @returns {{where: string, params: Array}|null} null = 这个人不参与社区
 */
function feedScope(viewerId, opts = {}) {
  const school = myVerifiedSchool(viewerId);
  if (!school) return null;
  const where = ['m.published = 1', 'u.school = ?', 'u.id <> ?'];
  const params = [school, Number(viewerId)];
  if (opts.courseId) {
    where.push('m.course_id = ?');
    params.push(Number(opts.courseId));
  }
  return { where: where.join(' AND '), params };
}

/**
 * 社区资料流：**同校同学**公开出来的资料。
 *
 * 三条硬约束全在 feedScope 的 WHERE 里，不在 JS 侧再过滤一遍 ——
 * 多一层过滤就多一处会漏的地方，而漏的方向是"看到了不该看的"。
 *
 * 返回的字段**不含用户名**（见上面 publicProfile 的说明），
 * 也不含别人的 stored_name（磁盘文件名）—— 那个只在文件服务里用。
 */
export function communityFeed(viewerId, opts = {}) {
  const scope = feedScope(viewerId, opts);
  if (!scope) return [];

  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 500);
  return all(
    `SELECT m.id, m.title, m.description, m.kind, m.category,
            m.size, m.created_at, m.updated_at, m.pdf_name,
            u.id AS owner_id, u.display_name, u.college, u.major, u.avatar_ext,
            c.name AS course_name, c.color AS course_color
       FROM materials m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE ${scope.where}
      ORDER BY m.updated_at DESC
      LIMIT ?`,
    ...scope.params, limit,
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

/** 社区流一共有多少份（列表只显示最近 N 份，底部要如实写清"还有多少没显示"） */
export function countCommunityFeed(viewerId, opts = {}) {
  const scope = feedScope(viewerId, opts);
  if (!scope) return 0;
  const row = get(
    `SELECT COUNT(*) AS c
       FROM materials m
       JOIN users u ON u.id = m.user_id
      WHERE ${scope.where}`,
    ...scope.params,
  );
  return Number(row?.c) || 0;
}

// ============================================================
// 「有没有新东西」—— 社区导航上的那个角标
// ============================================================

/** 上次看社区的时间，存在 settings 里 */
const COMMUNITY_SEEN_KEY = 'community_seen_at';

/**
 * 同校同学公开出来的资料里，**我上次看过社区之后**更新的有几份。
 *
 * 为什么是"看过就清"而不是"最近 7 天"：时间窗是拍脑袋定的 ——
 * 有人一周没来，回来照样漏掉；天天来的人则永远看见一个差不多的数字。
 * 聊天软件的未读就是这个模型，用户不用学。
 *
 * 条件是 feedScope 那一组**再加一条时间**，所以角标和列表不可能对不上。
 */
export function communityNewCount(viewerId) {
  const scope = feedScope(viewerId);
  if (!scope) return 0;
  const seen = String(getSetting(viewerId, COMMUNITY_SEEN_KEY, '') || '');
  const row = get(
    `SELECT COUNT(*) AS c
       FROM materials m
       JOIN users u ON u.id = m.user_id
      WHERE ${scope.where}
        AND COALESCE(m.updated_at, m.created_at, '') > ?`,
    ...scope.params, seen,
  );
  return Number(row?.c) || 0;
}

/**
 * 进社区页时调一次，把"这一刻我看过了"记下来。
 *
 * 刻意记**服务端的当前时间**，不接受客户端传上来的值 ——
 * 让客户端说自己"什么时候看的"，等于让它自己决定角标清不清零。
 */
export function markCommunitySeen(userId) {
  const row = get("SELECT datetime('now','localtime') AS t");
  if (row?.t) setSetting(userId, COMMUNITY_SEEN_KEY, row.t);
}

/**
 * 公开资料的**前置条件**：得先有个昵称。返回一句中文说明，没问题返回空串。
 *
 * 为什么必须拦：社区里认人靠**昵称 + 头像**（用户名永远不展示，
 * 这是用户拍板的前提）。所以没有昵称的人公开出去的东西，在同学眼里就是
 * 「（没填昵称）」+ 一个问号头像 —— **别人根本不知道这是谁给的**，
 * 也就不敢下载、不敢用。这不是美观问题，是把社区唯一的价值
 * （同校同学之间互相给东西）掐掉了。
 *
 * 和「学校没从名单里选过」那一条的区别是有意为之：
 *   · 学校那条只**警告**不拦 —— 先勾上、以后选好学校立刻生效，
 *     「先整理、后公开」是个合理用法；
 *   · 昵称这条直接**拦** —— 因为它坏掉的是**别人**看到的东西，
 *     而不是"你自己暂时没生效"。而且昵称只要一个字段，不像学校
 *     要从 3000 多所里挑，拦一下不算刁难。
 *
 * 规则只写一处：网页的批量公开和单份编辑都调它。命令行下架不调 ——
 * 下架是"收回"，永远该允许。
 */
export function publishBlocker(userId) {
  const me = get('SELECT display_name FROM users WHERE id = ?', userId);
  if (String(me?.display_name || '').trim()) return '';
  return '先在「设置 → 账号 → 个人资料」里起个昵称再公开 —— '
    + '校友社区里只显示昵称和头像，没有昵称的话同学不知道这份东西是谁给的。';
}

/**
 * 我自己公开出去的那几份 —— 社区页最上面「我公开的」那一栏。
 *
 * 为什么单独有这么一个查询：`communityFeed` 按设计**排除了自己**，
 * 于是「公开」这个动作在社区页上没有任何回显 —— 你公开完一份，
 * 这一页看起来和没公开时一模一样（用户就是这么反馈的：
 * 「我自己上传后社区界面没什么变动」）。
 *
 * ⚠️ 这个查询**不做同校判断**，这是有意的，而且是对的：
 *    看的是自己的东西，本来就该看到。学校还没从名单里选过的人
 *    进不了社区，但没道理连「我自己公开了什么」都看不见。
 *
 *    所以它的边界只剩一条，也正是唯一要守的一条：`m.user_id = ?`。
 *    少写这一条，同校同学**没公开**的资料会从这个口子整片漏出来 ——
 *    这是整个社区里最贵的一个 bug（漏的是别人刻意没公开的东西）。
 */
export function myPublishedMaterials(userId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  return all(
    `SELECT m.id, m.title, m.category, m.kind, m.size, m.pdf_name,
            m.updated_at, m.created_at,
            c.name AS course_name, c.color AS course_color
       FROM materials m
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE m.user_id = ? AND m.published = 1
      ORDER BY m.updated_at DESC
      LIMIT ?`,
    Number(userId), limit,
  ).map((r) => ({
    id: r.id,
    title: r.title || '',
    category: r.category || '',
    kind: r.kind || '',
    size: r.size,
    hasPdf: Boolean(r.pdf_name),
    updatedAt: r.updated_at || r.created_at || '',
    course: r.course_name ? { name: r.course_name, color: r.course_color || '' } : null,
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
 * 同校校友一共几个人（名单只显示前 N 个，底部要如实写清"还有多少没显示"）。
 *
 * ⚠️ 条件必须和 alumniList 完全一致（同校 + 公开过至少一份 + 排除自己），
 *    否则会出现「名单里 5 个人、底部写共 8 位」这种对不上的情况。
 *    这里不能像 feedScope 那样共用一段 SQL —— 因为 alumniList 是 GROUP BY
 *    的聚合，count 不聚合，结构不同；所以靠这段注释和自测里的
 *    "总数 >= 已显示数量" 来兜住两边不跑偏。
 */
export function countAlumni(viewerId) {
  const school = myVerifiedSchool(viewerId);
  if (!school) return 0;
  const row = get(
    `SELECT COUNT(DISTINCT u.id) AS c
       FROM users u
       JOIN materials m ON m.user_id = u.id AND m.published = 1
      WHERE u.school = ? AND u.id <> ?`,
    school, Number(viewerId),
  );
  return Number(row?.c) || 0;
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
