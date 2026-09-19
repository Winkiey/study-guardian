/**
 * 提醒调度器。
 *
 * 这是「手机准时收到作业提醒」的引擎。它做三件事：
 *   1. 根据作业的截止时间和提前量，生成一条条待发提醒
 *   2. 每 60 秒扫一次，把到点的提醒发出去
 *   3. 每天早上按设置推送「今日课表 + 待办作业」的播报
 *
 * 注意：调度器跟着服务进程跑。所以「电脑关机了就收不到提醒」——
 * 想 7×24 可靠提醒，需要把服务部署到一台常开的机器上（云服务器 / 树莓派 / 家里的旧电脑）。
 */

import config from '../config.js';
import { all, get, run } from '../db/index.js';
import { notifyUser } from './notify/index.js';
import {
  addMinutes,
  diffMinutes,
  formatDateTimeCn,
  humanizeDistance,
  nowStr,
  todayStr,
  weekdayOf,
} from './datetime.js';
import { getSetting } from './settings.js';

let timer = null;
let running = false;
let lastTickAt = null;
let lastTickResult = null;

// ============================================================
// 提醒生成
// ============================================================

/**
 * 根据作业的 DDL 与提前量，重建它的待发提醒。
 *
 * 每次作业被创建/修改后都调用一次：先删掉所有「还没发出去」的旧提醒，再按当前设置重新生成。
 * 已经发过的提醒保留，这样日志里能看到历史。
 */
export function syncAssignmentReminders(assignmentId) {
  const assignment = get('SELECT * FROM assignments WHERE id = ?', assignmentId);
  if (!assignment) return { created: 0, skipped: 0 };

  // 已完成 / 已提交的作业不再提醒
  const isDone = assignment.status === 'done' || assignment.submitted_at;

  run(
    `DELETE FROM reminders WHERE assignment_id = ? AND status = 'pending'`,
    assignmentId,
  );

  if (isDone || !assignment.due_at) return { created: 0, skipped: 0 };

  const course = assignment.course_id
    ? get('SELECT name FROM courses WHERE id = ?', assignment.course_id)
    : null;

  const offsets = parseOffsets(assignment.remind_offsets);
  const now = nowStr();
  let created = 0;
  let skipped = 0;

  for (const offset of offsets) {
    const fireAt = addMinutes(assignment.due_at, -offset);
    if (!fireAt) continue;

    // 已经过了触发时间（比如作业是昨天建的、提前量是 1 天）就跳过
    if (diffMinutes(now, fireAt) < 0) {
      skipped += 1;
      continue;
    }

    const title = buildReminderTitle(assignment, course, offset);
    const body = buildReminderBody(assignment, course, offset);

    run(
      `INSERT INTO reminders
         (user_id, assignment_id, kind, title, body, fire_at, channels, status)
       VALUES (?, ?, 'assignment', ?, ?, ?, ?, 'pending')`,
      assignment.user_id,
      assignment.id,
      title,
      body,
      fireAt,
      assignment.notify_channels || '',
    );
    created += 1;
  }

  return { created, skipped };
}

/** 解析提前量字符串 '1440,120,30' -> [1440,120,30]，去重降序，非法值丢弃 */
export function parseOffsets(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const set = new Set();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    const n = Number.parseInt(part, 10);
    if (Number.isFinite(n) && n > 0 && n <= 60 * 24 * 365) set.add(n);
  }
  return [...set].sort((a, b) => b - a);
}

/**
 * 提醒标题。用「人话」表达紧迫程度：
 * 提前 1 天 → 「明天截止」；提前 2 小时 → 「2 小时后截止」。
 */
function buildReminderTitle(assignment, course, offsetMinutes) {
  const coursePart = course?.name ? `【${course.name}】` : '';
  let when;
  if (offsetMinutes >= 60 * 24) {
    const days = Math.round(offsetMinutes / (60 * 24));
    when = days === 1 ? '明天截止' : `${days} 天后截止`;
  } else if (offsetMinutes >= 60) {
    const hours = Math.round(offsetMinutes / 60);
    when = `${hours} 小时后截止`;
  } else {
    when = `${offsetMinutes} 分钟后截止`;
  }
  return `${coursePart}作业「${assignment.title}」${when}`;
}

function buildReminderBody(assignment, course, offsetMinutes) {
  const lines = [];
  if (course?.name) lines.push(`课程：${course.name}`);
  lines.push(`作业：${assignment.title}`);
  if (assignment.due_at) {
    lines.push(`截止：${assignment.due_at.replace('T', ' ').slice(0, 16)}（${humanizeDistance(assignment.due_at)}）`);
  }
  if (assignment.priority === 2) lines.push('优先级：高');
  if (Number(assignment.progress) > 0) lines.push(`当前进度：${assignment.progress}%`);
  if (assignment.description) lines.push('', String(assignment.description).slice(0, 500));
  return lines.join('\n');
}

// ============================================================
// 发送
// ============================================================

/**
 * 处理所有到点的提醒。
 *
 * 每条提醒独立处理：失败的重试次数记在 attempts 里，
 * 连续失败超过 3 次就标成 failed，避免坏配置无限重试刷日志。
 */
export async function processDueReminders() {
  const now = nowStr();
  const due = all(
    `SELECT * FROM reminders
      WHERE status = 'pending' AND fire_at <= ?
      ORDER BY fire_at ASC
      LIMIT 50`,
    now,
  );

  const outcome = { picked: due.length, sent: 0, failed: 0, details: [] };

  for (const reminder of due) {
    const assignmentUrl = reminder.assignment_id
      ? `/assignments?highlight=${reminder.assignment_id}`
      : '';

    const result = await notifyUser(
      reminder.user_id,
      {
        title: reminder.title,
        body: reminder.body,
        url: assignmentUrl ? `${baseUrl()}${assignmentUrl}` : undefined,
      },
      { channels: reminder.channels, reminderId: reminder.id },
    );

    if (result.ok) {
      run(
        `UPDATE reminders SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = ''
          WHERE id = ?`,
        nowStr(),
        reminder.id,
      );
      outcome.sent += 1;
      outcome.details.push({ id: reminder.id, title: reminder.title, ok: true });
    } else {
      const attempts = Number(reminder.attempts) + 1;
      const failedPermanently = attempts >= 3;
      const errorText = result.results
        .filter((r) => !r.ok)
        .map((r) => `${r.type}: ${r.detail}`)
        .join('; ')
        .slice(0, 800);

      run(
        `UPDATE reminders
            SET status = ?, attempts = ?, last_error = ?
          WHERE id = ?`,
        failedPermanently ? 'failed' : 'pending',
        attempts,
        errorText,
        reminder.id,
      );
      outcome.failed += 1;
      outcome.details.push({ id: reminder.id, title: reminder.title, ok: false, error: errorText });
    }
  }

  return outcome;
}

/** 服务对外地址，用于消息里的「点击查看」链接 */
function baseUrl() {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  return `http://${host}:${config.port}`;
}

// ============================================================
// 每日播报
// ============================================================

/**
 * 每天早上推送「今日课表 + 最近作业」。
 * 由设置项 daily_digest_enabled / daily_digest_time 控制。
 */
export async function maybeSendDailyDigest(userId = 1) {
  const enabled = getSetting(userId, 'daily_digest_enabled', '0') === '1';
  if (!enabled) return { skipped: true, reason: '未开启每日播报' };

  const time = getSetting(userId, 'daily_digest_time', '07:30');
  const today = todayStr();
  const lastSent = getSetting(userId, 'daily_digest_last_sent', '');

  if (lastSent === today) return { skipped: true, reason: '今天已经播报过' };

  // 还没到播报时间
  const nowHm = nowStr().slice(11, 16);
  if (nowHm < time) return { skipped: true, reason: '还没到播报时间' };

  const message = await buildDailyDigest(userId);
  if (!message) return { skipped: true, reason: '无法生成播报内容' };

  const channels = getSetting(userId, 'daily_digest_channels', '');
  const result = await notifyUser(userId, message, { channels });

  if (result.ok) {
    run(
      `INSERT INTO settings (user_id, key, value) VALUES (?, 'daily_digest_last_sent', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId,
      today,
    );
  }

  return { skipped: false, ok: result.ok, results: result.results };
}

/**
 * 组装今日播报内容：今天有什么课、哪些作业快到了。
 */
export async function buildDailyDigest(userId) {
  const { expandCourseSessions } = await import('./weeks.js');
  const { getActiveTerm } = await import('./courses.js');

  const term = getActiveTerm(userId);
  const today = todayStr();
  const lines = [`今天是 ${formatDateTimeCn(today)}`];

  if (term) {
    const courses = all(
      'SELECT * FROM courses WHERE user_id = ? AND archived = 0',
      userId,
    );
    const sessions = all(
      `SELECT cs.* FROM course_sessions cs
         JOIN courses c ON c.id = cs.course_id
        WHERE c.user_id = ? AND c.archived = 0`,
      userId,
    );
    const exceptions = all(
      `SELECT ce.* FROM course_exceptions ce
         JOIN courses c ON c.id = ce.course_id
        WHERE c.user_id = ?`,
      userId,
    );

    const byCourse = new Map(courses.map((c) => [c.id, { ...c, sessions: [], exceptions: [] }]));
    for (const s of sessions) byCourse.get(s.course_id)?.sessions.push(s);
    for (const e of exceptions) byCourse.get(e.course_id)?.exceptions.push(e);

    const todayOccurrences = [];
    for (const course of byCourse.values()) {
      todayOccurrences.push(
        ...expandCourseSessions({
          course,
          sessions: course.sessions,
          exceptions: course.exceptions,
          termStart: term.start_date,
          rangeStart: today,
          rangeEnd: today,
        }),
      );
    }
    todayOccurrences.sort((a, b) => a.startTime.localeCompare(b.startTime));

    lines.push('');
    if (todayOccurrences.length === 0) {
      lines.push('📚 今天没有课');
    } else {
      lines.push(`📚 今天有 ${todayOccurrences.length} 节课：`);
      for (const o of todayOccurrences) {
        const where = o.location ? ` @ ${o.location}` : '';
        lines.push(`  ${o.startTime}-${o.endTime} ${o.courseName}${where}`);
      }
    }
  }

  // 未来 7 天的作业
  const horizon = addMinutes(`${today} 23:59`, 7 * 24 * 60);
  const assignments = all(
    `SELECT a.*, c.name AS course_name
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = ?
        AND a.status != 'done'
        AND a.submitted_at IS NULL
        AND a.due_at IS NOT NULL
        AND a.due_at <= ?
      ORDER BY a.due_at ASC
      LIMIT 10`,
    userId,
    horizon,
  );

  lines.push('');
  if (assignments.length === 0) {
    lines.push('✅ 未来一周没有待办作业');
  } else {
    lines.push(`✏️ 待办作业 ${assignments.length} 项：`);
    for (const a of assignments) {
      const mark = a.priority === 2 ? '❗' : '·';
      const coursePart = a.course_name ? `【${a.course_name}】` : '';
      lines.push(`  ${mark} ${coursePart}${a.title} —— ${humanizeDistance(a.due_at)}（${a.due_at.slice(5, 16)}）`);
    }
  }

  return {
    title: `学习守护 · ${today} 今日简报`,
    body: lines.join('\n'),
  };
}

// ============================================================
// 调度循环
// ============================================================

/**
 * 一次完整的调度：发到点提醒 + 检查每日播报 + 清理过老的提醒。
 */
export async function tick() {
  if (running) return { skipped: true, reason: '上一次调度还在执行' };
  running = true;
  const startedAt = Date.now();

  try {
    const reminders = await processDueReminders();

    // 每日播报必须**逐个用户**判断：开关、时间、接收渠道都是每个人自己设的。
    //
    // 这里原来写死的是 maybeSendDailyDigest(1)。单用户时看不出问题，
    // 多用户之后就是：除了 1 号，其他人把「每日播报」打开也永远收不到，
    // 而且不报任何错 —— 恰好是最难排查的那一类。
    const digests = [];
    for (const { id } of all('SELECT id FROM users ORDER BY id')) {
      try {
        digests.push({ userId: id, ...(await maybeSendDailyDigest(id)) });
      } catch (err) {
        digests.push({ userId: id, skipped: true, reason: `播报失败：${err.message}` });
      }
    }
    const digest = {
      users: digests.length,
      sent: digests.filter((d) => d.skipped === false).length,
      details: digests,
    };

    cleanupOldReminders();

    lastTickAt = nowStr();
    lastTickResult = {
      at: lastTickAt,
      durationMs: Date.now() - startedAt,
      reminders,
      digest,
    };
    return lastTickResult;
  } finally {
    running = false;
  }
}

/**
 * 清理：已发送超过 30 天的提醒、以及早已过期但从没发出去的提醒。
 * 避免数据库无限增长。
 */
export function cleanupOldReminders() {
  const cutoff = addMinutes(nowStr(), -30 * 24 * 60);
  run(`DELETE FROM reminders WHERE status = 'sent' AND sent_at < ?`, cutoff);
  // 过期超过 7 天还挂着 pending 的（比如关电脑关了很久），标成 skipped
  const staleCutoff = addMinutes(nowStr(), -7 * 24 * 60);
  run(
    `UPDATE reminders SET status = 'skipped', last_error = '过期未发送（服务未运行）'
      WHERE status = 'pending' AND fire_at < ?`,
    staleCutoff,
  );
}

/** 启动定时调度 */
export function startScheduler() {
  if (timer) return;

  const intervalMs = config.schedulerIntervalSec * 1000;

  const safeTick = () => {
    tick().catch((err) => {
      console.error('[调度器] 执行出错：', err.message);
    });
  };

  if (config.schedulerRunOnStart) {
    // 启动后延迟 3 秒跑第一次，避开启动阶段的其它初始化
    setTimeout(safeTick, 3000);
  }

  timer = setInterval(safeTick, intervalMs);
  timer.unref?.(); // 不要让调度器阻止进程退出

  console.log(
    `[调度器] 已启动，每 ${config.schedulerIntervalSec} 秒检查一次提醒`
    + (config.schedulerRunOnStart ? '（启动后立即执行一次）' : ''),
  );
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 调度器状态，用于设置页展示 */
export function schedulerStatus() {
  return {
    running: Boolean(timer),
    intervalSec: config.schedulerIntervalSec,
    lastTickAt,
    lastTickResult,
  };
}

/** 供测试 / 手动触发用的同步入口 */
export async function runOnce() {
  return tick();
}
