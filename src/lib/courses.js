/**
 * 课程相关的领域逻辑：学期、课程、上课时间、成绩构成、调课。
 *
 * 路由层只做参数校验与拼 HTML，真正的计算都在这里，
 * 方便被「今日课表」「周课表」「每日简报」「ICS 导出」等多处复用。
 */

import { all, get, getDb, run, tx } from '../db/index.js';
import { DEFAULT_COURSE_COLOR } from '../db/schema.js';
import { expandCourseSessions, termProgress, weekOfDate } from './weeks.js';
import { addDays, startOfWeek, todayStr } from './datetime.js';

// ============================================================
// 学期
// ============================================================

export function listTerms(userId) {
  return all('SELECT * FROM terms WHERE user_id = ? ORDER BY start_date DESC', userId);
}

/**
 * 取当前生效的学期。
 * 优先返回标记为 active 的；没有标记就挑「今天落在学期区间内」的；
 * 再没有就返回最近的一个。
 */
export function getActiveTerm(userId) {
  const active = get(
    'SELECT * FROM terms WHERE user_id = ? AND is_active = 1 ORDER BY start_date DESC LIMIT 1',
    userId,
  );
  if (active) return active;

  const today = todayStr();
  const inRange = all(
    `SELECT * FROM terms
      WHERE user_id = ?
        AND date(start_date) <= date(?)
        AND date(start_date, '+' || (week_count * 7) || ' days') >= date(?)
      ORDER BY start_date DESC LIMIT 1`,
    userId,
    today,
    today,
  );
  if (inRange[0]) return inRange[0];

  return get('SELECT * FROM terms WHERE user_id = ? ORDER BY start_date DESC LIMIT 1', userId);
}

export function createTerm(userId, { name, startDate, weekCount = 18, isActive = false }) {
  if (isActive) run('UPDATE terms SET is_active = 0 WHERE user_id = ?', userId);
  const { lastInsertRowid } = run(
    `INSERT INTO terms (user_id, name, start_date, week_count, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    userId,
    name,
    startDate,
    weekCount,
    isActive ? 1 : 0,
  );
  return lastInsertRowid;
}

export function updateTerm(userId, id, patch) {
  const term = get('SELECT * FROM terms WHERE id = ? AND user_id = ?', id, userId);
  if (!term) throw new Error('学期不存在');

  if (patch.isActive) run('UPDATE terms SET is_active = 0 WHERE user_id = ?', userId);

  run(
    `UPDATE terms SET name = ?, start_date = ?, week_count = ?, is_active = ?
      WHERE id = ? AND user_id = ?`,
    patch.name ?? term.name,
    patch.startDate ?? term.start_date,
    patch.weekCount ?? term.week_count,
    patch.isActive === undefined ? term.is_active : (patch.isActive ? 1 : 0),
    id,
    userId,
  );
}

export function deleteTerm(userId, id) {
  run('DELETE FROM terms WHERE id = ? AND user_id = ?', id, userId);
}

/** 学期进度信息（第几周 / 共几周） */
export function activeTermProgress(userId) {
  const term = getActiveTerm(userId);
  if (!term) return null;
  return { term, ...termProgress(term) };
}

/**
 * 由「开学第一周的周一」推算学期名称，例如 2025-09-01 -> 2025-2026学年第一学期。
 * 老师在导入 ICS 时通常没有学期信息，用这个自动补一个合理的默认值。
 */
export function guessTermName(startDate) {
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return '当前学期';
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  // 9 月到次年 1 月算第一学期，2 月到 8 月算第二学期
  if (month >= 9) return `${year}-${year + 1}学年第一学期`;
  if (month <= 1) return `${year - 1}-${year}学年第一学期`;
  return `${year - 1}-${year}学年第二学期`;
}

// ============================================================
// 课程
// ============================================================

/** 课程列表（含上课时间、成绩构成统计、资料与待办数量） */
export function listCourses(userId, { includeArchived = false } = {}) {
  const rows = all(
    `SELECT * FROM courses
      WHERE user_id = ?${includeArchived ? '' : ' AND archived = 0'}
      ORDER BY sort_order ASC, name ASC`,
    userId,
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const sessions = all(
    `SELECT * FROM course_sessions WHERE course_id IN (${placeholders}) ORDER BY weekday, start_time`,
    ...ids,
  );
  const grades = all(
    `SELECT * FROM grade_items WHERE course_id IN (${placeholders}) ORDER BY sort_order, id`,
    ...ids,
  );

  // 每门课有多少资料、多少项待办。
  //
  // 必须在这里算：课程列表页每张卡片下面都要显示这两个数，而列表页拿的是
  // 这个函数的结果。以前这两个字段只在 getCourseDetail 里算，列表页的模板
  // 写着 `c.materialCount ?? 0` —— 字段根本不存在，于是**每门课都显示 0**，
  // 和实际数量完全不符，而且不报任何错。
  //
  // 用两条 GROUP BY 一次算完所有课程，不是每门课查一次（那是 N+1）。
  // 按 user_id 一起过滤：这两张表都有 user_id，带上它比只靠 course_id 更稳。
  const materialCounts = new Map(
    all(
      `SELECT course_id, COUNT(*) AS c FROM materials
        WHERE user_id = ? AND course_id IN (${placeholders})
        GROUP BY course_id`,
      userId, ...ids,
    ).map((r) => [r.course_id, Number(r.c) || 0]),
  );
  const assignmentCounts = new Map(
    all(
      `SELECT course_id, COUNT(*) AS c FROM assignments
        WHERE user_id = ? AND status != 'done' AND course_id IN (${placeholders})
        GROUP BY course_id`,
      userId, ...ids,
    ).map((r) => [r.course_id, Number(r.c) || 0]),
  );

  const sessionsByCourse = groupBy(sessions, 'course_id');
  const gradesByCourse = groupBy(grades, 'course_id');

  return rows.map((course) => ({
    ...course,
    sessions: sessionsByCourse.get(course.id) || [],
    gradeItems: gradesByCourse.get(course.id) || [],
    gradeSummary: summarizeGrade(gradesByCourse.get(course.id) || []),
    materialCount: materialCounts.get(course.id) || 0,
    assignmentCount: assignmentCounts.get(course.id) || 0,
  }));
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

/** 单门课程的完整信息 */
export function getCourseDetail(userId, id) {
  const course = get('SELECT * FROM courses WHERE id = ? AND user_id = ?', id, userId);
  if (!course) return null;

  course.sessions = all(
    'SELECT * FROM course_sessions WHERE course_id = ? ORDER BY weekday, start_time',
    id,
  );
  course.exceptions = all(
    'SELECT * FROM course_exceptions WHERE course_id = ? ORDER BY date',
    id,
  );
  course.gradeItems = all(
    'SELECT * FROM grade_items WHERE course_id = ? ORDER BY sort_order, id',
    id,
  );
  course.gradeSummary = summarizeGrade(course.gradeItems);
  course.term = course.term_id ? get('SELECT * FROM terms WHERE id = ?', course.term_id) : null;

  // 课程下的资料与作业数量，详情页要显示。
  // 也带上 user_id：只按 course_id 过滤其实已经够（上面刚验过这门课属于他），
  // 但两张表都有 user_id，多带一个条件是白拿的保险，也免得以后有人把
  // 这段代码搬到别处时漏掉归属校验。
  course.materialCount = Number(
    get('SELECT COUNT(*) AS c FROM materials WHERE course_id = ? AND user_id = ?', id, userId)?.c || 0,
  );
  course.assignmentCount = Number(
    get(
      'SELECT COUNT(*) AS c FROM assignments WHERE course_id = ? AND user_id = ? AND status != ?',
      id, userId, 'done',
    )?.c || 0,
  );

  return course;
}

/** 课程名的模糊查找（导入时用来去重） */
export function findCourseByName(userId, name) {
  return get(
    'SELECT * FROM courses WHERE user_id = ? AND name = ? LIMIT 1',
    userId,
    String(name || '').trim(),
  );
}

export function createCourse(userId, data) {
  const { lastInsertRowid } = run(
    `INSERT INTO courses
       (user_id, term_id, name, code, teacher, teacher_contact, credits, hours,
        category, exam_type, classroom, color, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    data.termId ?? null,
    String(data.name || '').trim(),
    data.code || '',
    data.teacher || '',
    data.teacherContact || '',
    toNumberOrNull(data.credits),
    toNumberOrNull(data.hours),
    data.category || '',
    data.examType || '',
    data.classroom || '',
    data.color || DEFAULT_COURSE_COLOR,
    data.notes || '',
  );
  return lastInsertRowid;
}

export function updateCourse(userId, id, data) {
  const course = get('SELECT * FROM courses WHERE id = ? AND user_id = ?', id, userId);
  if (!course) throw new Error('课程不存在');

  run(
    `UPDATE courses SET
       term_id = ?, name = ?, code = ?, teacher = ?, teacher_contact = ?,
       credits = ?, hours = ?, category = ?, exam_type = ?, classroom = ?,
       color = ?, notes = ?, archived = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ?`,
    data.termId === undefined ? course.term_id : data.termId,
    data.name ?? course.name,
    data.code ?? course.code,
    data.teacher ?? course.teacher,
    data.teacherContact ?? course.teacher_contact,
    data.credits === undefined ? course.credits : toNumberOrNull(data.credits),
    data.hours === undefined ? course.hours : toNumberOrNull(data.hours),
    data.category ?? course.category,
    data.examType ?? course.exam_type,
    data.classroom ?? course.classroom,
    data.color ?? course.color,
    data.notes ?? course.notes,
    data.archived === undefined ? course.archived : (data.archived ? 1 : 0),
    id,
    userId,
  );
}

/**
 * 批量设置多门课程的学分 / 学时。
 *
 * 设计要点（这个功能最容易出 bug，所以刻意做得很保守）：
 *
 * 1. **整个操作在一个事务里**。任何一步出错就全部回滚，
 *    绝不会出现「改了 5 门、第 6 门失败」这种半个结果。
 * 2. **每条 UPDATE 的 WHERE 都带上 user_id**。就算上层校验漏了，
 *    也不可能改到别人的课程。
 * 3. **credits 用直接赋值而不是 COALESCE**。批量场景下，
 *    「提交了什么就存什么」比「只在为空时写入」更好预测；
 *    由调用方决定要不要把这一条提交上来。
 * 4. **hours 是可选的**：不传就保持原值，传 null 才清空。
 *    因为批量填学分时，用户通常不想动学时。
 *
 * @param {number} userId
 * @param {Array<{id:number, credits:number|null, hours?:number|null}>} items
 * @returns {number} 实际被修改的行数
 */
export function batchUpdateCourseAmounts(userId, items) {
  const database = getDb();

  const withHours = database.prepare(
    `UPDATE courses SET
       credits = ?, hours = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ?`,
  );
  const creditsOnly = database.prepare(
    `UPDATE courses SET
       credits = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ?`,
  );

  return tx(() => {
    let changed = 0;
    for (const item of items) {
      const result = item.hours === undefined
        ? creditsOnly.run(item.credits, item.id, userId)
        : withHours.run(item.credits, item.hours, item.id, userId);
      changed += Number(result.changes ?? 0);
    }
    return changed;
  });
}

export function deleteCourse(userId, id) {
  const course = get('SELECT id FROM courses WHERE id = ? AND user_id = ?', id, userId);
  if (!course) return false;
  // 外键 ON DELETE CASCADE 会一并清掉上课时间、成绩构成、调课记录
  run('DELETE FROM courses WHERE id = ? AND user_id = ?', id, userId);
  return true;
}

function toNumberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// 上课时间
// ============================================================

export function listSessions(courseId) {
  return all(
    'SELECT * FROM course_sessions WHERE course_id = ? ORDER BY weekday, start_time',
    courseId,
  );
}

export function replaceSessions(courseId, sessions) {
  return tx(() => {
    run('DELETE FROM course_sessions WHERE course_id = ?', courseId);
    for (const s of sessions) {
      run(
        `INSERT INTO course_sessions (course_id, weekday, start_time, end_time, weeks, location, teacher, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        courseId,
        Number(s.weekday) || 1,
        s.startTime || '08:00',
        s.endTime || '09:40',
        s.weeks || '1-16',
        s.location || '',
        s.teacher || '',
        s.note || '',
      );
    }
  });
}

export function addSession(courseId, s) {
  const { lastInsertRowid } = run(
    `INSERT INTO course_sessions (course_id, weekday, start_time, end_time, weeks, location, teacher, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    courseId,
    Number(s.weekday) || 1,
    s.startTime || '08:00',
    s.endTime || '09:40',
    s.weeks || '1-16',
    s.location || '',
    s.teacher || '',
    s.note || '',
  );
  return lastInsertRowid;
}

export function deleteSession(userId, sessionId) {
  const row = get(
    `SELECT cs.id FROM course_sessions cs
       JOIN courses c ON c.id = cs.course_id
      WHERE cs.id = ? AND c.user_id = ?`,
    sessionId,
    userId,
  );
  if (!row) return false;
  run('DELETE FROM course_sessions WHERE id = ?', sessionId);
  return true;
}

// ============================================================
// 成绩构成
// ============================================================

export function listGradeItems(courseId) {
  return all(
    'SELECT * FROM grade_items WHERE course_id = ? ORDER BY sort_order, id',
    courseId,
  );
}

/**
 * 保存成绩构成（整体替换）。
 *
 * data 形如：
 *   [{ name: '平时成绩', weight: 30, score: 88 },
 *    { name: '期末考试', weight: 70, score: null }]
 */
export function saveGradeItems(courseId, items) {
  return tx(() => {
    run('DELETE FROM grade_items WHERE course_id = ?', courseId);
    let order = 0;
    for (const item of items) {
      const name = String(item.name || '').trim();
      if (!name) continue;
      run(
        `INSERT INTO grade_items (course_id, name, weight, score, full_score, note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        courseId,
        name,
        toNumberOrNull(item.weight) ?? 0,
        toNumberOrNull(item.score),
        toNumberOrNull(item.fullScore) ?? 100,
        item.note || '',
        order,
      );
      order += 1;
    }
  });
}

/**
 * 计算成绩构成的汇总信息。
 *
 * 举个具体例子，假设成绩构成是「平时 30% + 期中 20% + 期末 50%」，
 * 平时考了 88、期中考了 76、期末还没考：
 *
 *   earnedPoints   41.6   已经拿到的分数（百分制口径）: 88×0.3 + 76×0.2
 *   scoredRate     83.2   已出分部分的得分率: 41.6 ÷ 50 × 100
 *   remainingWeight  50   还没出分的权重
 *   bestPossible   91.6   剩下的全拿满分，最终总评: 41.6 + 50
 *   worstPossible  41.6   剩下的全拿 0 分
 *
 * 注意「已得分数」不能除以总权重，否则得到的不是学生理解的分数。
 */
export function summarizeGrade(items) {
  if (!items?.length) {
    return {
      hasItems: false,
      totalWeight: 0,
      baseWeight: 0,
      remainingWeight: 0,
      earnedPoints: null,
      currentScore: null,
      scoredRate: null,
      bestPossible: null,
      worstPossible: null,
      weightsValid: true,
    };
  }

  let totalWeight = 0;
  let scoredWeight = 0;
  let earnedPoints = 0;

  for (const item of items) {
    const weight = Number(item.weight) || 0;
    totalWeight += weight;

    if (item.score !== null && item.score !== undefined && item.score !== '') {
      const full = Number(item.full_score) || 100;
      const score = Number(item.score);
      if (!Number.isFinite(score) || full <= 0) continue;
      scoredWeight += weight;
      earnedPoints += (score / full) * weight;
    }
  }

  const remainingWeight = Math.max(0, totalWeight - scoredWeight);
  const hasScores = scoredWeight > 0;

  return {
    hasItems: true,
    totalWeight: round2(totalWeight),
    baseWeight: round2(scoredWeight),
    remainingWeight: round2(remainingWeight),
    earnedPoints: hasScores ? round2(earnedPoints) : null,
    // 已出分部分的得分率（0-100），学生看这个最直观
    scoredRate: hasScores ? round2((earnedPoints / scoredWeight) * 100) : null,
    bestPossible: hasScores ? round2(earnedPoints + remainingWeight) : round2(totalWeight),
    worstPossible: hasScores ? round2(earnedPoints) : 0,
    currentScore: hasScores ? round2(earnedPoints) : null,
    // 权重之和是否为 100%（不是的话提示用户核对）
    weightsValid: Math.abs(totalWeight - 100) < 0.01,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ============================================================
// 调课 / 停课
// ============================================================

export function listExceptions(courseId) {
  return all(
    'SELECT * FROM course_exceptions WHERE course_id = ? ORDER BY date',
    courseId,
  );
}

export function addException(courseId, data) {
  const { lastInsertRowid } = run(
    `INSERT INTO course_exceptions
       (course_id, date, action, new_date, new_start_time, new_end_time, new_location, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    courseId,
    data.date,
    data.action === 'move' ? 'move' : 'cancel',
    data.newDate || '',
    data.newStartTime || '',
    data.newEndTime || '',
    data.newLocation || '',
    data.note || '',
  );
  return lastInsertRowid;
}

export function deleteException(userId, id) {
  const row = get(
    `SELECT ce.id FROM course_exceptions ce
       JOIN courses c ON c.id = ce.course_id
      WHERE ce.id = ? AND c.user_id = ?`,
    id,
    userId,
  );
  if (!row) return false;
  run('DELETE FROM course_exceptions WHERE id = ?', id);
  return true;
}

// ============================================================
// 课表查询
// ============================================================

/**
 * 取某个日期区间内所有课的安排。
 * 内部先把每门课的上课时间展开成具体日期，再统一排序。
 */
export function occurrencesInRange(userId, rangeStart, rangeEnd, { termId } = {}) {
  const term = termId
    ? get('SELECT * FROM terms WHERE id = ? AND user_id = ?', termId, userId)
    : getActiveTerm(userId);
  if (!term) return { term: null, occurrences: [] };

  const courses = all(
    'SELECT * FROM courses WHERE user_id = ? AND archived = 0',
    userId,
  );
  if (!courses.length) return { term, occurrences: [] };

  const ids = courses.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const sessions = all(
    `SELECT * FROM course_sessions WHERE course_id IN (${placeholders})`,
    ...ids,
  );
  const exceptions = all(
    `SELECT * FROM course_exceptions WHERE course_id IN (${placeholders})`,
    ...ids,
  );

  const sessionsByCourse = groupBy(sessions, 'course_id');
  const exceptionsByCourse = groupBy(exceptions, 'course_id');

  const occurrences = [];
  for (const course of courses) {
    occurrences.push(
      ...expandCourseSessions({
        course,
        sessions: sessionsByCourse.get(course.id) || [],
        exceptions: exceptionsByCourse.get(course.id) || [],
        termStart: term.start_date,
        rangeStart,
        rangeEnd,
      }),
    );
  }

  occurrences.sort((a, b) => (a.date === b.date
    ? a.startTime.localeCompare(b.startTime)
    : a.date.localeCompare(b.date)));

  return { term, occurrences };
}

/** 今天的课 */
export function todayOccurrences(userId) {
  const today = todayStr();
  return occurrencesInRange(userId, today, today);
}

/** 本周的课（周一到周日） */
export function thisWeekOccurrences(userId, baseDate) {
  const base = baseDate || todayStr();
  const monday = startOfWeek(base);
  const sunday = addDays(monday, 6);
  const result = occurrencesInRange(userId, monday, sunday);
  return { ...result, monday, sunday };
}

/** 未来 N 天的课 */
export function upcomingOccurrences(userId, days = 7) {
  const today = todayStr();
  return occurrencesInRange(userId, today, addDays(today, days));
}

/** 某一天是学期第几周 */
export function weekOf(userId, dateStr) {
  const term = getActiveTerm(userId);
  if (!term) return null;
  return { term, week: weekOfDate(term.start_date, dateStr) };
}
