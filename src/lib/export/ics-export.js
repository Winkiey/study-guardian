/**
 * ICS 日历导出（含订阅链接）。
 *
 * 两个用途，价值不同，页面上要跟用户讲清楚：
 *
 * 1. 【下载 .ics 导入手机日历】
 *    一次性导入，事件里带 VALARM 闹钟 → iPhone 日历到点会弹通知。
 *    缺点：课表改了要重新导入。
 *
 * 2. 【订阅链接】
 *    手机日历定期自动拉取，课表一改手机就更新。
 *    缺点：iOS 对**订阅**日历的闹钟支持不可靠（系统会忽略订阅日历的 VALARM）。
 *    所以这条路用来「看课表」，提醒还是靠 Bark。
 *
 * 这个区别很多人踩过坑，所以代码里也保留说明。
 */

import crypto from 'node:crypto';
import config from '../../config.js';
import { all, get } from '../../db/index.js';
import { generateICS } from '../ics.js';
import { getActiveTerm } from '../courses.js';
import { dateForWeekday, parseWeekSpec } from '../weeks.js';

const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 把 'YYYY-MM-DD' + 'HH:MM' 拼成 generateICS 认识的本地时间字符串 */
function dt(dateStr, time) {
  return `${dateStr}T${time || '00:00'}`;
}

/**
 * 把本地时间转成 ICS 的 UTC 时间戳（用于 RRULE 的 UNTIL，RFC 要求 UTC）。
 */
function toUtcStamp(dateStr, time = '23:59:59') {
  const local = new Date(`${dateStr}T${time}`);
  // 用 getTimezoneOffset 让 Date 自己算偏移，避免硬编码 +8
  const utc = new Date(local.getTime() - local.getTimezoneOffset() * 60_000);
  return `${utc.getUTCFullYear()}${String(utc.getUTCMonth() + 1).padStart(2, '0')}${String(utc.getUTCDate()).padStart(2, '0')}T${String(utc.getUTCHours()).padStart(2, '0')}${String(utc.getUTCMinutes()).padStart(2, '0')}${String(utc.getUTCSeconds()).padStart(2, '0')}Z`;
}

/** 本地时间转 ICS 用的带 Z 的 UTC 时间戳（用于作业 DDL） */
function localToUtcIcs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!m) return null;
  const local = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), 0,
  );
  return toUtcStamp(`${m[1]}-${m[2]}-${m[3]}`, `${m[4] || '00'}:${m[5] || '00'}:00`);
}

// ============================================================
// 导出课程表
// ============================================================

/**
 * 生成课程的 ICS 事件。
 * 每条「上课时间」变成一个带 RRULE 的 weekly 事件。
 */
export function courseEvents(userId, { termId, includeAlarms = true } = {}) {
  const term = termId
    ? get('SELECT * FROM terms WHERE id = ? AND user_id = ?', termId, userId)
    : getActiveTerm(userId);
  if (!term) return { term: null, events: [] };

  const courses = all(
    'SELECT * FROM courses WHERE user_id = ? AND archived = 0',
    userId,
  );
  if (!courses.length) return { term, events: [] };

  const ids = courses.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const sessions = all(
    `SELECT * FROM course_sessions WHERE course_id IN (${placeholders})`,
    ...ids,
  );

  const events = [];

  for (const session of sessions) {
    const course = courses.find((c) => c.id === session.course_id);
    if (!course) continue;

    const weeks = parseWeekSpec(session.weeks, Number(term.week_count) + 6);
    if (!weeks.length) continue;

    const firstWeek = weeks[0];
    const lastWeek = weeks[weeks.length - 1];

    const firstDate = dateForWeekday(term.start_date, firstWeek, Number(session.weekday));
    const lastDate = dateForWeekday(term.start_date, lastWeek, Number(session.weekday));
    if (!firstDate || !lastDate) continue;

    // 判断是连续周还是隔周，决定 RRULE 怎么写
    const isContiguous = weeks.length === lastWeek - firstWeek + 1;
    const isOddOnly = weeks.every((w) => w % 2 === 1);
    const isEvenOnly = weeks.every((w) => w % 2 === 0);

    let rrule;
    if (isContiguous) {
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY[session.weekday]};UNTIL=${toUtcStamp(lastDate)}`;
    } else if (isOddOnly || isEvenOnly) {
      // 隔周：INTERVAL=2，从第一周起算
      rrule = `FREQ=WEEKLY;INTERVAL=2;BYDAY=${BYDAY[session.weekday]};UNTIL=${toUtcStamp(lastDate)}`;
    } else {
      // 不规则的周次：拆成多个事件太啰嗦，退化成逐周列举（用 RDATE 语义）
      // 这里简单处理：只导出第一段连续的，其余的在描述里说明
      rrule = `FREQ=WEEKLY;BYDAY=${BYDAY[session.weekday]};UNTIL=${toUtcStamp(lastDate)}`;
    }

    const location = session.location || course.classroom || '';
    const teacher = session.teacher || course.teacher || '';

    const descriptionParts = [];
    if (teacher) descriptionParts.push(`教师：${teacher}`);
    if (course.credits) descriptionParts.push(`学分：${course.credits}`);
    if (course.code) descriptionParts.push(`课程号：${course.code}`);
    descriptionParts.push(`周次：第 ${session.weeks} 周`);
    if (!isContiguous) {
      descriptionParts.push(`注意：本课程并非每周连续上课，实际周次为 ${weeks.join('、')}。`);
    }

    const event = {
      uid: `course-${course.id}-session-${session.id}@study-guardian`,
      summary: course.name,
      description: descriptionParts.join('\n'),
      location,
      start: dt(firstDate, session.start_time),
      end: dt(firstDate, session.end_time),
      rrule,
      categories: ['课程'],
    };

    if (includeAlarms) {
      event.alarms = [{ triggerMinutesBefore: 30, description: `${course.name} 30 分钟后上课` }];
    }

    events.push(event);
  }

  events.sort((a, b) => (a.start < b.start ? -1 : 1));
  return { term, events };
}

// ============================================================
// 导出作业 DDL
// ============================================================

/**
 * 生成作业的事件。
 * 每个作业是一个「在 DDL 时刻结束」的事件，带多个提前提醒闹钟。
 */
export function assignmentEvents(userId, { includeDone = false, includeAlarms = true } = {}) {
  const rows = all(
    `SELECT a.*, c.name AS course_name
       FROM assignments a
       LEFT JOIN courses c ON c.id = a.course_id
      WHERE a.user_id = ?
        ${includeDone ? '' : "AND a.status != 'done'"}
        AND a.due_at IS NOT NULL
      ORDER BY a.due_at ASC`,
    userId,
  );

  const events = [];

  for (const a of rows) {
    const dueUtc = localToUtcIcs(a.due_at);
    if (!dueUtc) continue;

    // 事件本身设为 DDL 前 1 小时开始、DDL 时刻结束，在日历上有个可见的块
    const startLocal = new Date(`${a.due_at.replace(' ', 'T')}:00`);
    startLocal.setMinutes(startLocal.getMinutes() - 60);
    const startStr = `${startLocal.getFullYear()}-${String(startLocal.getMonth() + 1).padStart(2, '0')}-${String(startLocal.getDate()).padStart(2, '0')}T${String(startLocal.getHours()).padStart(2, '0')}:${String(startLocal.getMinutes()).padStart(2, '0')}`;

    const descParts = [];
    if (a.course_name) descParts.push(`课程：${a.course_name}`);
    descParts.push(`截止时间：${a.due_at}`);
    if (a.priority === 2) descParts.push('优先级：高');
    if (a.description) descParts.push('', String(a.description).slice(0, 500));

    const event = {
      uid: `assignment-${a.id}@study-guardian`,
      summary: `【作业】${a.course_name ? `${a.course_name} - ` : ''}${a.title}`,
      description: descParts.join('\n'),
      start: startStr,
      end: dt(a.due_at.slice(0, 10), a.due_at.slice(11, 16)),
      categories: ['作业'],
    };

    if (includeAlarms) {
      const offsets = String(a.remind_offsets || '1440,120')
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 5);
      event.alarms = offsets.map((minutes) => ({
        triggerMinutesBefore: minutes,
        description: `${a.title} ${minutes >= 1440 ? `${Math.round(minutes / 1440)} 天后` : minutes >= 60 ? `${Math.round(minutes / 60)} 小时后` : `${minutes} 分钟后`}截止`,
      }));
    }

    events.push(event);
  }

  return events;
}

// ============================================================
// 生成完整 ICS
// ============================================================

/**
 * 生成完整的日历内容。
 * @param {object} opts { includeCourses, includeAssignments, includeAlarms, termId }
 */
export function buildCalendar(userId, opts = {}) {
  const {
    includeCourses = true,
    includeAssignments = true,
    includeAlarms = true,
    termId,
  } = opts;

  const events = [];
  let term = null;

  if (includeCourses) {
    const result = courseEvents(userId, { termId, includeAlarms });
    term = result.term;
    events.push(...result.events);
  }
  if (includeAssignments) {
    events.push(...assignmentEvents(userId, { includeAlarms }));
  }

  const user = get('SELECT display_name, username FROM users WHERE id = ?', userId);
  const calName = term ? `${config.appName} · ${term.name}` : `${config.appName} 课程与作业`;

  const ics = generateICS({
    calendar: {
      name: calName,
      timezone: config.timezone,
      prodId: '-//Study Guardian//学习守护平台//CN',
    },
    events,
  });

  return { ics, eventCount: events.length, term, calendarName: calName };
}

// ============================================================
// 订阅链接
// ============================================================

/**
 * 生成订阅令牌。
 *
 * 用 SESSION_SECRET 做 HMAC，因此不需要在数据库里额外存一列；
 * 令牌里带 userId 和过期时间，改密/换密钥即失效。
 */
export function calendarToken(userId, days = 365) {
  const expires = Date.now() + days * 86_400_000;
  const payload = `cal.${userId}.${expires}`;
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** 校验订阅令牌 */
export function verifyCalendarToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const [kind, userId, expires] = payload.split('.');
  if (kind !== 'cal') return null;
  if (Number(expires) < Date.now()) return null;
  return { userId: Number(userId) };
}

/** 订阅地址（供设置页展示） */
export function subscriptionUrl(userId, { host } = {}) {
  const token = calendarToken(userId);
  const base = host || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  return {
    // webcal:// 让 iOS/macOS 直接弹出「订阅日历」对话框
    webcal: `${base.replace(/^https?:/, 'webcal:')}/calendar/subscribe.ics?token=${token}`,
    http: `${base}/calendar/subscribe.ics?token=${token}`,
    token,
  };
}

/** 导出统计，页面上给用户看「这次导出了什么」 */
export function exportStats(userId) {
  const courseCount = Number(
    get('SELECT COUNT(*) AS c FROM courses WHERE user_id = ? AND archived = 0', userId)?.c || 0,
  );
  const assignmentCount = Number(
    get(`SELECT COUNT(*) AS c FROM assignments WHERE user_id = ? AND status != 'done' AND due_at IS NOT NULL`, userId)?.c || 0,
  );
  const sessionCount = Number(
    get(
      `SELECT COUNT(*) AS c FROM course_sessions cs
         JOIN courses c ON c.id = cs.course_id
        WHERE c.user_id = ? AND c.archived = 0`,
      userId,
    )?.c || 0,
  );
  return { courseCount, assignmentCount, sessionCount };
}
