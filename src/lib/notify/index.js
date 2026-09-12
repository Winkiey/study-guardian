/**
 * 通知分发。
 *
 * 职责：把「一条消息」送到「用户配置的所有渠道」，并把结果写进日志，
 * 这样用户在设置页能直接看到「哪条提醒、什么时候、发给了哪个渠道、成功没有」。
 */

import { all, get, run } from '../../db/index.js';
import { CHANNEL_MAP, getChannelDef, channelCatalog } from './channels.js';

export { channelCatalog, getChannelDef };

/** 配置里这些字段是敏感信息，返回给前端时要打码 */
const SECRET_KEYS = new Set(['pass', 'token', 'key', 'sendkey', 'secret', 'botToken']);

/**
 * 把配置里的敏感字段打码，用于页面回显。
 * 保留前 3 位和后 2 位，方便用户确认填的是哪一个，但不泄露完整值。
 */
export function maskConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config || {})) {
    const str = String(v ?? '');
    if (SECRET_KEYS.has(k) && str.length > 6) {
      out[k] = `${str.slice(0, 3)}${'•'.repeat(Math.min(str.length - 5, 12))}${str.slice(-2)}`;
    } else {
      out[k] = str;
    }
  }
  return out;
}

/**
 * 把用户填的配置交给渠道自己的 normalize 过一遍。
 *
 * 用户填的东西往往「人能看懂、机器不能直接用」——比如把 Bark 首页的
 * 完整网址当成 Key 粘贴进来。这类修正在入库前做掉，后面所有地方
 * （发送、测试、回显）拿到的就都是干净的值。
 */
export function normalizeConfig(type, config) {
  const def = getChannelDef(type);
  const raw = config && typeof config === 'object' ? config : {};
  if (!def || typeof def.normalize !== 'function') return { ...raw };
  try {
    const result = def.normalize({ ...raw });
    return result && typeof result === 'object' ? result : { ...raw };
  } catch {
    // normalize 只是「尽力修正」，它自己出错不该让保存失败
    return { ...raw };
  }
}

/** 读取用户的全部渠道配置 */
export function listChannels(userId) {
  const rows = all(
    'SELECT * FROM notify_channels WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    userId,
  );
  return rows.map((row) => ({
    ...row,
    config: safeParseJson(row.config),
    enabled: Number(row.enabled) === 1,
    is_default: Number(row.is_default) === 1,
    def: getChannelDef(row.type),
  }));
}

function safeParseJson(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 新增渠道 */
export function createChannel(userId, { type, name, config, enabled = true, isDefault = false }) {
  if (!getChannelDef(type)) throw new Error(`未知的通知渠道类型：${type}`);

  // 第一个渠道自动设为默认
  const count = Number(get('SELECT COUNT(*) AS c FROM notify_channels WHERE user_id = ?', userId)?.c || 0);
  const makeDefault = isDefault || count === 0;

  if (makeDefault) {
    run('UPDATE notify_channels SET is_default = 0 WHERE user_id = ?', userId);
  }

  const { lastInsertRowid } = run(
    `INSERT INTO notify_channels (user_id, type, name, config, enabled, is_default)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    type,
    name || getChannelDef(type).label,
    JSON.stringify(normalizeConfig(type, config)),
    enabled ? 1 : 0,
    makeDefault ? 1 : 0,
  );
  return lastInsertRowid;
}

/** 更新渠道 */
export function updateChannel(userId, id, patch) {
  const row = get('SELECT * FROM notify_channels WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new Error('渠道不存在');

  const existing = safeParseJson(row.config);
  // 前端回显的是打码值，如果用户没改就原样提交，这里要还原成真实值
  const incoming = { ...(patch.config || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (SECRET_KEYS.has(k) && typeof v === 'string' && v.includes('•')) {
      incoming[k] = existing[k] ?? '';
    }
  }
  const merged = normalizeConfig(patch.type || row.type, { ...existing, ...incoming });

  if (patch.isDefault) {
    run('UPDATE notify_channels SET is_default = 0 WHERE user_id = ?', userId);
  }

  run(
    `UPDATE notify_channels
        SET type = ?, name = ?, config = ?, enabled = ?, is_default = ?
      WHERE id = ? AND user_id = ?`,
    patch.type || row.type,
    patch.name ?? row.name,
    JSON.stringify(merged),
    patch.enabled === undefined ? row.enabled : (patch.enabled ? 1 : 0),
    patch.isDefault === undefined ? row.is_default : (patch.isDefault ? 1 : 0),
    id,
    userId,
  );
}

export function deleteChannel(userId, id) {
  const row = get('SELECT * FROM notify_channels WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return false;
  run('DELETE FROM notify_channels WHERE id = ? AND user_id = ?', id, userId);

  // 删掉的是默认渠道时，把剩下的第一个设为默认，避免「没有默认渠道」
  if (Number(row.is_default) === 1) {
    const next = get('SELECT id FROM notify_channels WHERE user_id = ? ORDER BY id LIMIT 1', userId);
    if (next) run('UPDATE notify_channels SET is_default = 1 WHERE id = ?', next.id);
  }
  return true;
}

/**
 * 决定一条提醒要发给哪些渠道。
 *
 * @param {number} userId
 * @param {string} channelTypes 逗号分隔的渠道名；为空则用所有启用的渠道
 */
export function resolveTargetChannels(userId, channelTypes) {
  const wanted = String(channelTypes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rows = all('SELECT * FROM notify_channels WHERE user_id = ? AND enabled = 1', userId);

  if (!wanted.length) return rows;
  return rows.filter((r) => wanted.includes(r.type) || wanted.includes(String(r.id)));
}

/**
 * 发送到单个渠道。永远不抛错，失败信息放在返回值里，
 * 这样一条通道挂了不会影响其它通道。
 *
 * @returns {Promise<{ok:boolean, detail:string, type:string}>}
 */
export async function sendToChannel(row, message) {
  const def = getChannelDef(row.type);
  if (!def) return { ok: false, detail: `未知渠道类型 ${row.type}`, type: row.type };

  const rawConfig = typeof row.config === 'string' ? safeParseJson(row.config) : row.config || {};
  const config = normalizeConfig(row.type, rawConfig);

  try {
    const result = def.send ? await def.send(config, message) : { ok: true, detail: '无需发送' };
    return { ok: result.ok !== false, detail: result.detail || '', type: def.type };
  } catch (err) {
    return { ok: false, detail: err.message || String(err), type: def.type };
  }
}

/**
 * 向用户发送一条通知，分发到指定渠道（默认全部启用渠道），并写日志。
 *
 * @param {number} userId
 * @param {{title:string, body?:string, url?:string}} message
 * @param {{channels?:string, reminderId?:number}} [opts]
 * @returns {Promise<{ok:boolean, results:Array, targetCount:number}>}
 */
export async function notifyUser(userId, message, opts = {}) {
  const targets = resolveTargetChannels(userId, opts.channels);

  if (!targets.length) {
    logNotify(userId, opts.reminderId, 'none', message.title, false, '没有配置任何启用的通知渠道');
    return {
      ok: false,
      results: [{ ok: false, detail: '没有配置任何启用的通知渠道', type: 'none' }],
      targetCount: 0,
    };
  }

  const results = await Promise.all(
    targets.map(async (row) => {
      const result = await sendToChannel(row, message);
      logNotify(userId, opts.reminderId, result.type, message.title, result.ok, result.detail);
      return { ...result, channelName: row.name || row.type };
    }),
  );

  return { ok: results.some((r) => r.ok), results, targetCount: targets.length };
}

/** 测试某个渠道配置（可能还没入库） */
export async function testChannelConfig(type, config) {
  const def = getChannelDef(type);
  if (!def) throw new Error(`未知的通知渠道类型：${type}`);

  const normalized = normalizeConfig(type, config);

  const message = {
    title: '【测试】学习守护平台连接成功',
    body: '如果你在手机上看到这条消息，说明提醒通道已经配好了。\n\n'
      + `发送时间：${new Date().toLocaleString('zh-CN')}`,
  };

  try {
    // 邮件渠道支持只验证连接不真发，避免测试时刷屏
    if (def.test) {
      const result = await def.test(normalized, message);
      return { ok: result.ok !== false, detail: result.detail || '验证成功', config: normalized };
    }
    const result = await def.send(normalized, message);
    return { ok: result.ok !== false, detail: result.detail || '发送成功', config: normalized };
  } catch (err) {
    return { ok: false, detail: err.message || String(err), config: normalized };
  }
}

/** 写发送日志 */
export function logNotify(userId, reminderId, channelType, title, ok, detail) {
  try {
    run(
      `INSERT INTO notify_log (user_id, reminder_id, channel_type, title, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      reminderId ?? null,
      channelType,
      String(title || '').slice(0, 200),
      ok ? 1 : 0,
      String(detail || '').slice(0, 1000),
    );
  } catch {
    /* 日志失败不应影响主流程 */
  }
}

/** 读最近日志 */
export function recentLogs(userId, limit = 50) {
  return all(
    `SELECT * FROM notify_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    userId,
    Math.min(Number(limit) || 50, 200),
  );
}

/** 日志统计：最近成功/失败数，设置页用 */
export function logStats(userId) {
  const row = get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success
     FROM notify_log
     WHERE user_id = ? AND created_at >= datetime('now','localtime','-7 days')`,
    userId,
  );
  return {
    total: Number(row?.total || 0),
    success: Number(row?.success || 0),
    failed: Number(row?.total || 0) - Number(row?.success || 0),
  };
}

export { CHANNEL_MAP };
