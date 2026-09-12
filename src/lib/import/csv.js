/**
 * CSV / 粘贴文本的课表解析。
 *
 * 教务处导出的课表常常是 Excel/CSV，格式五花八门。
 * 这个模块做两件事：
 *   1. 解析 CSV（自己实现，正确支持引号包裹的字段、字段内换行、BOM）
 *   2. 把「表头 + 数据行」映射成课程对象（表头别名匹配，容错优先）
 */

import { periodsToClock } from '../periods.js';

// ============================================================
// CSV 解析
// ============================================================

/**
 * 解析 CSV 文本为二维数组。
 *
 * 正确处理：
 *   - 双引号包裹的字段，字段内的逗号、换行、双引号（"" 转义）
 *   - CRLF / LF / CR 三种换行
 *   - UTF-8 BOM
 *   - 分隔符自动嗅探（逗号 / 制表符 / 分号）
 *
 * @param {string} text
 * @param {string} [delimiter] 不传则自动嗅探
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter) {
  let src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (!src.trim()) return [];

  const delim = delimiter || sniffDelimiter(src);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === delim) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      // 把 \r\n 当作一个换行
      if (ch === '\r' && src[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // 最后一行可能没有换行结尾
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 丢掉全空行
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/** 嗅探分隔符：统计第一行里各候选符号出现次数，取最多的 */
function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

// ============================================================
// 表头映射
// ============================================================

/**
 * 表头别名表。
 * 不同学校的教务处用词不同，这里把所有见过的写法都列上，
 * 匹配时先做「去空格 + 去标点 + 小写」归一化。
 */
const HEADER_ALIASES = {
  name: ['课程名称', '课程名', '课程', '科目', '教学班名称', '课名', '名称', 'coursename', 'course'],
  code: ['课程号', '课程代码', '课程编号', '课程代码/课程号', 'code', 'courseid', 'courseid号'],
  teacher: ['教师', '任课教师', '授课教师', '老师', '教师姓名', '主讲教师', 'teacher'],
  credits: ['学分', '学分数', 'credits', 'credit'],
  hours: ['学时', '总学时', '计划学时', 'hours'],
  category: ['课程性质', '课程类别', '课程属性', '修读性质', '类别', '性质'],
  examType: ['考核方式', '考试方式', '考核类型', '考试类型'],
  classroom: ['教室', '上课地点', '地点', '上课教室', '场地', 'location', 'room'],
  weekday: ['星期', '周几', '上课星期', 'weekday', 'day'],
  startTime: ['开始节次', '起始节次', '开始时间', '上课时间', '节次', 'starttime', 'start'],
  endTime: ['结束节次', '结束时间', 'endtime', 'end'],
  weeks: ['周次', '上课周次', '起止周', '周数', 'weeks', 'week'],
  term: ['学期', '学年学期', 'term'],
};

/** 归一化表头文本：去掉空格、括号内容、标点，转小写 */
function normalizeHeader(text) {
  return String(text || '')
    .replace(/\ufeff/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s:：*]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 根据表头行，返回「列索引 -> 字段名」的映射。
 * @returns {{ map: Object<number,string>, matched: string[], unmatched: string[] }}
 */
export function mapHeaders(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const map = {};
  const matched = new Set();

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasSet = aliases.map(normalizeHeader);
    for (let i = 0; i < normalized.length; i += 1) {
      if (map[i]) continue;
      if (aliasSet.includes(normalized[i])) {
        map[i] = field;
        matched.add(field);
        break;
      }
    }
  }

  const unmatched = normalized.filter((h, i) => h && !map[i]);
  return { map, matched: [...matched], unmatched };
}

// ============================================================
// 时间与节次解析
// ============================================================

/** 中文数字与常见写法 -> 星期序号 */
const WEEKDAY_WORDS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

/** 解析星期字段：'星期一' / '周一' / '周三' / '3' / 'Wednesday' */
export function parseWeekday(value) {
  const s = String(value || '').trim().replace(/[星期周]/g, '').toLowerCase();
  if (!s) return 0;
  if (WEEKDAY_WORDS[s] !== undefined) return WEEKDAY_WORDS[s];
  // '一,三' 这种多天，取第一个
  const first = s[0];
  return WEEKDAY_WORDS[first] ?? 0;
}

/**
 * 解析时间字段，支持：
 *   '08:00'、'8:00-9:40'、'08:00~09:40'
 *   '第1-2节'、'1-2'、'1,2'、'3-4节'
 *
 * 节次要按「作息时间表」换算——每个学校不一样，
 * 所以这张表由用户在设置页配置，通过 schedule 参数传进来。
 *
 * @param {string} value 时间字段原文
 * @param {Array} [schedule] 作息时间表；不传则用内置默认值
 * @returns {{ startTime: string, endTime: string, periods?: string }}
 */
export function parseTimeRange(value, schedule) {
  const s = String(value || '').trim();
  if (!s) {
    return periodsToClock(schedule, 1, 2) || { startTime: '08:00', endTime: '09:40' };
  }

  // 已经是 'HH:MM-HH:MM' 形式
  const clock = /(\d{1,2}):(\d{2})\s*[-~—至到]\s*(\d{1,2}):(\d{2})/.exec(s);
  if (clock) {
    return {
      startTime: `${pad2(clock[1])}:${clock[2]}`,
      endTime: `${pad2(clock[3])}:${clock[4]}`,
    };
  }

  // 单个时间点：默认按一节课 100 分钟算结束时间
  const single = /(\d{1,2}):(\d{2})/.exec(s);
  if (single) {
    const start = `${pad2(single[1])}:${single[2]}`;
    return { startTime: start, endTime: addMinutesToClock(start, 100) };
  }

  // 节次：'第3-4节' / '3-4' / '3,4' / '第5节'
  const periodMatch = /(\d{1,2})\s*(?:[-~—至到,，]\s*(\d{1,2}))?/.exec(s.replace(/[第节次]/g, ''));
  if (periodMatch) {
    const from = Number(periodMatch[1]);
    const to = Number(periodMatch[2] || periodMatch[1]);
    const resolved = periodsToClock(schedule, from, to);
    if (resolved) return { ...resolved, periods: `${from}-${to}` };
  }

  return periodsToClock(schedule, 1, 2) || { startTime: '08:00', endTime: '09:40' };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMinutesToClock(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
}

/**
 * 解析学分：'3' / '3.0' / '3学分' / '3.0 学分'
 */
export function parseCredits(value) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(value || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 解析周次：把各种写法归一化成 weeks.js 认识的形式。
 *   '1-16周'        -> '1-16'
 *   '第1-16周'      -> '1-16'
 *   '1-16周(单)'    -> '1-16单'
 *   '1,3,5,7周'     -> '1,3,5,7'
 *   '1-8,10-16周'   -> '1-8,10-16'
 */
export function parseWeeksText(value) {
  let s = String(value || '').trim();
  if (!s) return '1-16';

  s = s
    .replace(/\ufeff/g, '')
    .replace(/[第]/g, '')
    .replace(/周(?:次|数)?/g, '')
    .replace(/[（(]\s*单\s*[）)]/g, '单')
    .replace(/[（(]\s*双\s*[）)]/g, '双')
    .replace(/[，、；;]/g, ',')
    .replace(/[～—－~]/g, '-')
    .replace(/\s+/g, '');

  // '单周' / '双周' 这种整体标记
  if (/^单周?$/.test(s)) return '1-16单';
  if (/^双周?$/.test(s)) return '1-16双';

  if (!/[\d]/.test(s)) return '1-16';

  // 去掉仍然残留的非「数字/逗号/减号/单双」字符
  s = s.replace(/[^\d,\-单双]/g, '');
  return s || '1-16';
}

// ============================================================
// 组装课程
// ============================================================

/**
 * 把 CSV 文本解析成课程数组。
 *
 * 支持两种布局：
 *   A. 一行一门课（含星期、时间、周次列）—— 最常见
 *   B. 一行一门课但有多个时间段（同课程出现多行）—— 按课程名合并
 *
 * @param {string} text CSV 原文
 * @param {object} [opts]
 * @param {Array} [opts.periods] 作息时间表，用于把「第 3-4 节」换算成具体时间
 * @returns {{ courses: Array, warnings: string[], headerMatched: string[], headerUnmatched: string[], rowCount: number }}
 */
export function parseCourseCsv(text, opts = {}) {
  const schedule = opts.periods;
  const rows = parseCsv(text);
  const warnings = [];

  if (rows.length === 0) {
    return { courses: [], warnings: ['文件内容为空'], headerMatched: [], headerUnmatched: [], rowCount: 0 };
  }

  // 找到表头行：取前 5 行里「能匹配到字段最多」的那一行
  let headerIndex = 0;
  let bestMatch = { map: {}, matched: [], unmatched: [] };
  for (let i = 0; i < Math.min(5, rows.length); i += 1) {
    const m = mapHeaders(rows[i]);
    if (m.matched.length > bestMatch.matched.length) {
      bestMatch = m;
      headerIndex = i;
    }
  }

  if (bestMatch.matched.length === 0) {
    warnings.push(
      '没能识别出表头。请确保第一行包含「课程名称」「教师」「学分」等列名，'
      + '或者先在 Excel 里整理好再导出 CSV。',
    );
    return { courses: [], warnings, headerMatched: [], headerUnmatched: [], rowCount: rows.length - 1 };
  }

  if (!bestMatch.matched.includes('name')) {
    warnings.push('表头里缺少「课程名称」列，无法导入。');
    return { courses: [], warnings, headerMatched: bestMatch.matched, headerUnmatched: bestMatch.unmatched, rowCount: rows.length - 1 };
  }

  const byName = new Map();
  let dataRows = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const record = {};
    for (const [indexStr, field] of Object.entries(bestMatch.map)) {
      record[field] = String(row[Number(indexStr)] ?? '').trim();
    }

    const name = record.name;
    if (!name) continue;
    dataRows += 1;

    let course = byName.get(name);
    if (!course) {
      course = {
        name,
        code: record.code || '',
        teacher: record.teacher || '',
        credits: parseCredits(record.credits),
        hours: parseCredits(record.hours),
        category: record.category || '',
        examType: record.examType || '',
        classroom: record.classroom || '',
        termName: record.term || '',
        sessions: [],
      };
      byName.set(name, course);
    }

    // 有星期列的才生成上课时间
    if (record.weekday) {
      const weekday = parseWeekday(record.weekday);
      if (!weekday) {
        warnings.push(`第 ${i + 1} 行：无法识别星期「${record.weekday}」，已跳过该行的时间。`);
        continue;
      }

      const timeText = [record.startTime, record.endTime].filter(Boolean).join('-');
      const { startTime, endTime } = parseTimeRange(timeText || record.startTime, schedule);

      const session = {
        weekday,
        startTime,
        endTime,
        weeks: parseWeeksText(record.weeks),
        location: record.classroom || '',
        teacher: record.teacher || '',
      };
      // 合并完全重复的时间段
      const duplicate = course.sessions.some(
        (s) => s.weekday === session.weekday && s.startTime === session.startTime && s.weeks === session.weeks,
      );
      if (!duplicate) course.sessions.push(session);
    }
  }

  if (dataRows === 0) warnings.push('没有解析出任何数据行。');

  return {
    courses: [...byName.values()],
    warnings,
    headerMatched: bestMatch.matched,
    headerUnmatched: bestMatch.unmatched,
    rowCount: dataRows,
  };
}

// ============================================================
// 生成导入模板
// ============================================================

/** 下载用的 CSV 模板（带 BOM，Excel 打开不乱码） */
export function csvTemplate() {
  const header = '课程名称,课程号,教师,学分,学时,课程性质,考核方式,星期,上课时间,周次,上课地点';
  const sample = [
    '高等数学(上),MATH101,张三,5,80,必修,考试,星期一,08:00-09:40,1-16,之远楼301',
    '高等数学(上),MATH101,张三,5,80,必修,考试,星期三,10:00-11:40,1-16,之远楼301',
    '微观经济学,ECON201,李四,3,48,必修,考试,星期二,13:30-15:10,1-16单,博学楼205',
  ].join('\n');
  return `\ufeff${header}\n${sample}\n`;
}
