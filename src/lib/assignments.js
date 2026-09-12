/**
 * 作业管理。
 *
 * 与提醒的联动：任何一次对作业的增删改，都会顺带重建它的待发提醒
 * （见 syncAssignmentReminders），保证「改了 DDL，提醒也跟着改」。
 */

import { all, get, run } from '../db/index.js';
import { humanizeDistance, nowStr, todayStr, urgencyOf } from './datetime.js';
import { syncAssignmentReminders } from './scheduler.js';

export const STATUS_LABELS = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
};

export const PRIORITY_LABELS = {
  0: '低',
  1: '中',
  2: '高',
};

const URGENCY_LABELS = {
  overdue: '已过期',
  urgent: '紧急',
  soon: '临近',
  normal: '正常',
  none: '无期限',
};

export { URGENCY_LABELS };

/**
 * 作业列表。
 * @param {object} opts { courseId, status, keyword, includeDone, limit }
 */
export function listAssignments(userId, opts = {}) {
  const where = ['a.user_id = ?'];
  const params = [userId];

  if (opts.courseId) {
    where.push('a.course_id = ?');
    params.push(Number(opts.courseId));
  }
  if (opts.status) {
    where.push('a.status = ?');
    params.push(opts.status);
  } else if (!opts.includeDone) {
    where.push("a.status != 'done'");
  }
  if (opts.keyword) {
    where.push('(a.title LIKE ? OR a.description LIKE ?)');
    const like = `%${opts.keyword}%`;
    params.push(like, like);
  }

  const rows = all(
    `SELECT a.*, c.name AS course_name, c.color AS course_color,
            m.title AS material_title, m.kind AS material_kind
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN materials m ON m.id = a.material_id
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END,
        a.due_at ASC,
        a.priority DESC`,
    ...params,
  );

  return rows.map(decorateAssignment);
}

/** 补上展示字段 */
export function decorateAssignment(row) {
  if (!row) return row;
  const urgency = urgencyOf(row.due_at);
  return {
    ...row,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    priorityLabel: PRIORITY_LABELS[row.priority] ?? '中',
    urgency,
    urgencyLabel: URGENCY_LABELS[urgency] || '',
    dueLabel: row.due_at ? row.due_at.slice(0, 16).replace('T', ' ') : '无截止时间',
    dueDistance: row.due_at ? humanizeDistance(row.due_at) : '',
    isOverdue: urgency === 'overdue' && row.status !== 'done',
    offsetsList: String(row.remind_offsets || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function getAssignment(userId, id) {
  const row = get(
    `SELECT a.*, c.name AS course_name, c.color AS course_color,
            m.title AS material_title, m.kind AS material_kind
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN materials m ON m.id = a.material_id
      WHERE a.id = ? AND a.user_id = ?`,
    id,
    userId,
  );
  if (!row) return null;

  const decorated = decorateAssignment(row);
  decorated.reminders = all(
    'SELECT * FROM reminders WHERE assignment_id = ? ORDER BY fire_at',
    id,
  );
  return decorated;
}

export function createAssignment(userId, data) {
  const { lastInsertRowid } = run(
    `INSERT INTO assignments
       (user_id, course_id, title, description, due_at, status, priority, progress,
        full_score, weight, material_id, remind_offsets, notify_channels)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    data.courseId ? Number(data.courseId) : null,
    String(data.title || '').trim(),
    data.description || '',
    normalizeDueAt(data.dueAt),
    data.status || 'todo',
    Number(data.priority ?? 1),
    Number(data.progress ?? 0),
    toNumberOrNull(data.fullScore) ?? 100,
    toNumberOrNull(data.weight),
    data.materialId ? Number(data.materialId) : null,
    data.remindOffsets ?? '1440,120',
    data.notifyChannels || '',
  );

  syncAssignmentReminders(lastInsertRowid);
  return lastInsertRowid;
}

export function updateAssignment(userId, id, data) {
  const row = get('SELECT * FROM assignments WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new Error('作业不存在');

  const nextStatus = data.status ?? row.status;
  // 状态变成 done 时记录完成时间，改回 todo 时清掉
  let submittedAt = row.submitted_at;
  if (data.submittedAt !== undefined) submittedAt = data.submittedAt || null;
  else if (nextStatus === 'done' && row.status !== 'done') submittedAt = nowStr();
  else if (nextStatus !== 'done' && row.status === 'done') submittedAt = null;

  const progress = data.progress !== undefined
    ? Number(data.progress)
    : (nextStatus === 'done' ? 100 : row.progress);

  run(
    `UPDATE assignments SET
       course_id = ?, title = ?, description = ?, due_at = ?, status = ?, priority = ?,
       progress = ?, submitted_at = ?, score = ?, full_score = ?, weight = ?,
       material_id = ?, remind_offsets = ?, notify_channels = ?,
       updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ?`,
    data.courseId === undefined ? row.course_id : (data.courseId ? Number(data.courseId) : null),
    data.title ?? row.title,
    data.description ?? row.description,
    data.dueAt === undefined ? row.due_at : normalizeDueAt(data.dueAt),
    nextStatus,
    data.priority === undefined ? row.priority : Number(data.priority),
    Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : row.progress)),
    submittedAt,
    data.score === undefined ? row.score : toNumberOrNull(data.score),
    data.fullScore === undefined ? row.full_score : toNumberOrNull(data.fullScore),
    data.weight === undefined ? row.weight : toNumberOrNull(data.weight),
    data.materialId === undefined ? row.material_id : (data.materialId ? Number(data.materialId) : null),
    data.remindOffsets ?? row.remind_offsets,
    data.notifyChannels ?? row.notify_channels,
    id,
    userId,
  );

  syncAssignmentReminders(id);
  return getAssignment(userId, id);
}

export function deleteAssignment(userId, id) {
  const row = get('SELECT id FROM assignments WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return false;
  // reminders 表有 ON DELETE CASCADE
  run('DELETE FROM assignments WHERE id = ? AND user_id = ?', id, userId);
  return true;
}

/** 快捷切换状态 */
export function setAssignmentStatus(userId, id, status) {
  if (!STATUS_LABELS[status]) throw new Error('未知的作业状态');
  return updateAssignment(userId, id, { status });
}

/** 把 'YYYY-MM-DDTHH:MM' 或 'YYYY-MM-DD HH:MM' 统一成存储格式 */
function normalizeDueAt(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  // datetime-local 输入框给的是 'YYYY-MM-DDTHH:MM'
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]} ${m[2]}`;
  // 只给了日期，默认当天 23:59 截止（更符合「当天交」的直觉）
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 23:59`;
  return null;
}

function toNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// 视图分组
// ============================================================

/**
 * 按紧急程度分成四组，作业页用分组展示，一眼看到该先做哪个。
 */
export function groupByUrgency(list) {
  const groups = {
    overdue: [],
    urgent: [],
    soon: [],
    normal: [],
    none: [],
  };
  for (const item of list) {
    const key = groups[item.urgency] ? item.urgency : 'none';
    groups[key].push(item);
  }
  return groups;
}

/** 仪表盘用的统计 */
export function assignmentStats(userId) {
  const today = todayStr();
  const row = get(
    `SELECT
       SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status != 'done' AND due_at IS NOT NULL AND date(due_at) < date(?) THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN status != 'done' AND date(due_at) = date(?) THEN 1 ELSE 0 END) AS dueToday,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM assignments WHERE user_id = ?`,
    today,
    today,
    userId,
  );

  return {
    pending: Number(row?.pending || 0),
    overdue: Number(row?.overdue || 0),
    dueToday: Number(row?.dueToday || 0),
    done: Number(row?.done || 0),
  };
}

/** 未来 N 天内到期的作业，仪表盘和每日简报都用 */
export function upcomingAssignments(userId, days = 7, limit = 20) {
  const horizon = `${todayStr()} 23:59`;
  const rows = all(
    `SELECT a.*, c.name AS course_name, c.color AS course_color
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = ?
        AND a.status != 'done'
        AND a.due_at IS NOT NULL
        AND date(a.due_at) <= date(?, '+' || ? || ' days')
        AND date(a.due_at) >= date('now','localtime','-30 days')
      ORDER BY a.due_at ASC
      LIMIT ?`,
    userId,
    horizon,
    Number(days) || 7,
    Number(limit) || 20,
  );
  return rows.map(decorateAssignment);
}

/**
 * 把「成绩构成」和「作业得分」关联起来：
 * 作业若填了 weight（占总评比例）和 score，就能算进平时成绩的参考值。
 */
export function assignmentScoreSummary(userId, courseId) {
  const row = get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
       SUM(CASE WHEN score IS NOT NULL AND full_score > 0 THEN score / full_score * 100 ELSE 0 END) AS sumRatio
     FROM assignments WHERE user_id = ? AND course_id = ?`,
    userId,
    courseId,
  );
  const scored = Number(row?.scored || 0);
  return {
    total: Number(row?.total || 0),
    scored,
    average: scored > 0 ? Math.round((Number(row.sumRatio) / scored) * 100) / 100 : null,
  };
}
