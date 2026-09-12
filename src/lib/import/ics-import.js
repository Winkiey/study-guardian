/**
 * ICS 课表导入。
 *
 * 这是「从教务处导入课表」的通用方案：不管哪个学校、哪个教务系统，
 * 只要能导出 .ics（很多系统能导出到手机日历），就能导进来。
 *
 * 导入的核心难点是**格式归一化**：
 *   教务系统的 ics 里，一门课一学期可能有 16 个独立的 VEVENT（每周一个），
 *   也可能是一个带 RRULE 的 VEVENT。
 *   我们的数据模型是「课程 + 若干条每周重复的上课时间 + 周次表达式」，
 *   所以这里要把两种形式都还原成同一个模型。
 */

import { parseICS, expandRecurrence } from '../ics.js';
import { addDays, startOfWeek, toDateStr, weekdayOf } from '../datetime.js';
import { all, get, run, tx } from '../../db/index.js';
import { DEFAULT_COURSE_COLOR } from '../../db/schema.js';

// ============================================================
// 教室 / 教师 / 节次 的识别
//
// 教务系统导出的 ICS 里，教室和教师经常**挤在同一个字段**：
//
//   LOCATION:校本部之远楼716 孙艳霞
//   LOCATION:校本部笃行楼603 王玺
//   DESCRIPTION:第5 - 7节\n校本部之远楼716\n孙艳霞
//
// 如果整串当成教室，教师字段就永远是空的，而教室会变成
// 「校本部之远楼716 孙艳霞」这种一眼就不对的值——这是真实踩过的坑。
//
// 所以这里做的不是「关键词匹配」，而是**字段切分**：
// 把文本切成片段，逐个判断它更像教室还是更像人名。
// 关键词写法（「教师：张三」）仍然优先，因为那是最明确的信号。
// ============================================================

/** 教室的常见字眼：楼宇、房间、场地、线上平台 */
const ROOM_HINT_RE = /(楼|室|馆|区|号|座|栋|层|房|阶|教|校区|园|院|中心|平台|实验|机房|操场|球场|体育馆|礼堂|报告厅|会议室|线上|网络|网课|直播|学习通|雨课堂|智慧树|腾讯会议|钉钉|room|hall|lab|online|campus)/i;

/** 人名后面常见的称呼，判断时先剥掉 */
const NAME_SUFFIX_RE = /(老师|教师|教授|副教授|讲师|助教|先生|女士)$/;

/**
 * 常见姓氏。只在「课程名-张三」这种写法里用来提高准确率，
 * 避免把「大学英语-读写」的「读写」当成人名。
 */
const COMMON_SURNAMES = new Set(
  Array.from(
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师和仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩明麻',
  ),
);

/**
 * 判断一段文本像不像「教室 / 上课地点」。
 *
 * 依据：含数字（门牌号），或含上面那些场地字眼。
 * 「之远楼」虽然只有 3 个汉字、看着像人名，但含「楼」，会在这里被正确拦下。
 */
export function looksLikeClassroom(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/\d/.test(s)) return true;
  return ROOM_HINT_RE.test(s);
}

/**
 * 判断一段文本像不像「人名」。
 *
 * 规则：剥掉「老师／教授」之类后缀后，剩下 2-4 个纯汉字，且不含场地字眼。
 */
export function looksLikePersonName(text) {
  const s = String(text || '').trim().replace(NAME_SUFFIX_RE, '').trim();
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(s)) return false;
  // 「之远楼」「博学楼」也是 3 个汉字，但它们是场地，不是人名
  if (ROOM_HINT_RE.test(s)) return false;
  return true;
}

/** 更严格的判断：还要求姓氏常见。用于「课程名-张三」这种容易误判的写法。 */
function looksLikeNameSuffix(text) {
  const s = String(text || '').trim().replace(NAME_SUFFIX_RE, '').trim();
  if (!looksLikePersonName(s)) return false;
  return COMMON_SURNAMES.has(s[0]);
}

/** 节次写法：'第5 - 7节' / '第5-7节' / '5-7节' / '第5节' / '第5节次' */
const PERIOD_RE = /第?\s*(\d{1,2})\s*(?:[-~—－至到]\s*(\d{1,2})\s*)?节\s*次?/;

/** 明确带「教师」字样的写法 */
const TEACHER_KEYWORD_RE = /(?:任课教师|授课教师|主讲教师|上课教师|教师|老师|Teacher|Instructor)\s*[:：]?\s*(.+)$/i;

/** 明确带「教室」字样的写法 */
const ROOM_KEYWORD_RE = /(?:上课地点|上课教室|授课地点|上课场地|教室|地点|场地|Location|Room)\s*[:：]?\s*(.+)$/i;

/**
 * 纯元信息行，不含教室/教师，直接跳过。
 *
 * 必须跳过而不是「认不出来就归到教室」——因为「学分：4」「课程号：MATH101」
 * 里都带数字，会被门牌号规则误判成教室。
 * 注意这一步要放在教师/教室关键词检查**之后**，否则「教师：张三」会被误跳过。
 */
const META_LINE_RE = /^(学分|学时|总学时|周学时|课程号|课程代码|课程编号|教学班|班级|周次|上课周次|起止周|学期|学年|考核方式|考试方式|考核类型|课程性质|课程类别|修读性质|备注|教师工号|开课学院|开课单位|选课人数|校区)\s*[:：]/;

/**
 * 把一段「教室 / 教师 / 节次」混在一起的文本拆成三个字段。
 *
 * 同时兼容两种真实格式：
 *   多行：'第5 - 7节\n校本部之远楼716\n孙艳霞'
 *   单行：'校本部之远楼716 孙艳霞'
 *
 * @param {string} rawText
 * @returns {{teacher:string, classroom:string, periods:string, leftover:string, raw:string}}
 *          leftover 是既不像教室也不像人名的剩余文字，调用方可以留作备注
 */
export function parsePlacement(rawText) {
  const raw = String(rawText || '').trim();
  const out = { teacher: '', classroom: '', periods: '', leftover: '', raw };
  if (!raw) return out;

  const leftovers = [];

  // 先按行拆、再按竖线拆，两类格式都覆盖
  const chunks = raw
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(/[|｜]/))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    // 1. 先把节次摘出去，剩下的内容继续参与判断
    let rest = chunk;
    const pm = PERIOD_RE.exec(rest);
    if (pm) {
      if (!out.periods) out.periods = pm[2] ? `${pm[1]}-${pm[2]}` : String(pm[1]);
      rest = rest.replace(pm[0], ' ').trim();
    }
    if (!rest) continue;

    // 2. 带关键词的优先，那是最明确的信号
    const tk = TEACHER_KEYWORD_RE.exec(rest);
    if (tk) {
      const v = cleanValue(tk[1]);
      if (v && !out.teacher) out.teacher = v;
      continue;
    }

    const rk = ROOM_KEYWORD_RE.exec(rest);
    if (rk) {
      const v = cleanValue(rk[1]);
      if (v && !out.classroom) out.classroom = v;
      continue;
    }

    // 3. 纯元信息行（学分、课程号、周次…）直接跳过。
    //    这些行里带数字，不拦住的话会被门牌号规则误判成教室。
    if (META_LINE_RE.test(rest)) continue;

    // 4. 没有关键词时，按分隔符切块逐个判断。
    //    顺序很重要：先判教室再判人名。
    //    「之远楼」看着像人名，但含「楼」，必须先被教室规则拦下。
    const tokens = rest.split(/[\s,，、;；\/]+/).map((s) => s.trim()).filter(Boolean);

    for (const token of tokens) {
      if (!out.classroom && looksLikeClassroom(token)) {
        out.classroom = token;
        continue;
      }
      if (!out.teacher && looksLikePersonName(token)) {
        out.teacher = token;
        continue;
      }
      // 认不出来的：优先补进教室（宁可显示在教室，也不要凭空丢掉信息）
      if (!out.classroom) {
        out.classroom = token;
      } else if (!looksLikeClassroom(token)) {
        leftovers.push(token);
      }
    }
  }

  out.leftover = leftovers.join(' ').trim();
  return out;
}

/** 去掉值末尾的分隔符与空白 */
function cleanValue(value) {
  return String(value || '').replace(/[\s,，;；|]+$/, '').trim();
}

// ============================================================
// 学分 / 学时 的提取
//
// 教务系统把这两个数放在哪儿都有可能：
//   - 自定义属性：CREDITS:3  /  X-CREDITS:3.0  /  学分:3  /  X-学分:4
//   - 描述里：  「学分：3」「3学分」「学分 3」
//   - 课程名里：「金融市场与金融机构(3学分)」「金融学[3.0学分]」
// 所以这里做成「多来源 + 多写法」的提取，逐个试，取第一个成功的。
// ============================================================

/** 学分/学时可能出现的属性名 */
const CREDIT_PROP_RE = /^(X[-_])?(CREDITS?|XF|KCXF|XFZ|学分|课程学分|学分值)$/i;
const HOURS_PROP_RE = /^(X[-_])?(HOURS?|XS|KCXS|学时|总学时|计划学时|学时数)$/i;

/**
 * 把一段文本解析成数字，并做合理性检查。
 *
 * 上限检查很重要：像「毕业总学分：160」这种也含「学分」，
 * 但它显然不是某一门课的学分。课程学分正常在 0.5 ~ 20 之间。
 */
function parseAmount(value, { max = 30 } = {}) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

/**
 * 从自由文本里抽学分。覆盖面最广的一层。
 * @returns {number|null}
 */
export function extractCreditFromText(text) {
  const s = String(text ?? '');
  if (!s) return null;

  const patterns = [
    /学分\s*[:：=]?\s*(\d+(?:\.\d+)?)/,           // 学分：3 / 学分3 / 学分=3
    /(\d+(?:\.\d+)?)\s*学分/,                     // 3学分 / 3.0 学分
    /(?:credits?)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i,  // CREDITS:3
  ];

  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const n = parseAmount(m[1]);
    if (n !== null) return n;
  }
  return null;
}

/** 从自由文本里抽学时 */
export function extractHoursFromText(text) {
  const s = String(text ?? '');
  if (!s) return null;

  const patterns = [
    /学时\s*[:：=]?\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*学时/,
    /(?:hours?)\s*[:：=]?\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    // 学时可以很大（比如 160 学时），上限放宽到 1000
    const n = parseAmount(m[1], { max: 1000 });
    if (n !== null) return n;
  }
  return null;
}

/**
 * 从 VEVENT 的原始属性里抽学分（X-CREDITS / CREDITS / 学分…）。
 * @param {Record<string,string>} raw ics.js 解析出来的未识别属性
 */
export function extractCreditFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const [name, value] of Object.entries(raw)) {
    if (!CREDIT_PROP_RE.test(String(name).trim())) continue;
    const n = parseAmount(value);
    if (n !== null) return n;
  }
  return null;
}

/** 从 VEVENT 的原始属性里抽学时 */
export function extractHoursFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const [name, value] of Object.entries(raw)) {
    if (!HOURS_PROP_RE.test(String(name).trim())) continue;
    const n = parseAmount(value, { max: 1000 });
    if (n !== null) return n;
  }
  return null;
}

/**
 * 清洗课程名，顺便把「课程名-教师名」里的教师、
 * 以及「课程名(3学分)」里的学分摘出来。
 *
 * 教务系统常见的标题写法：
 *   【必修】高等数学(上)         →  高等数学(上)
 *   高等数学-张三                →  高等数学        + 教师：张三
 *   金融市场与金融机构(3学分)      →  金融市场与金融机构 + 学分：3
 *   高等数学(2024-2025-1)        →  高等数学
 *
 * @returns {{name:string, teacher:string, credits:number|null, hours:number|null}}
 */
export function parseCourseTitle(summary) {
  const original = String(summary || '').trim();
  let name = original;
  let teacher = '';
  let credits = null;
  let hours = null;

  // ---- 学分 / 学时：放在最前面 ----
  // 必须早于「去掉方括号标签」那一步，否则开头的「[3学分]金融学」会被整块丢掉。
  //
  // 括号里可能不止一项（「会计学原理(4学分, 64学时)」），所以先看整个括号内容：
  // 只要里面除了学分/学时没有别的东西，就整块摘掉；
  // 一旦还夹着别的信息（比如「高等数学(上)」），就原样保留，宁可少摘也不要改坏课程名。
  name = name.replace(/[（(\[【]([^）)\]】]{1,60})[）)\]】]/g, (full, inner) => {
    const hasCredit = /学分/.test(inner);
    const hasHours = /学时/.test(inner);
    if (!hasCredit && !hasHours) return full;

    const leftover = inner
      .replace(/\d+(?:\.\d+)?\s*学分/g, '')
      .replace(/\d+(?:\.\d+)?\s*学时/g, '')
      .replace(/[:：=,，、;；\s]+/g, '');

    if (leftover) return full;

    if (credits === null && hasCredit) credits = extractCreditFromText(inner);
    if (hours === null && hasHours) hours = extractHoursFromText(inner);
    return '';
  });

  // 去掉开头/结尾的方括号标签（【必修】这类）
  name = name.replace(/^[【\[][^】\]]{1,10}[】\]]\s*/, '');
  name = name.replace(/\s*[【\[][^】\]]{1,10}[】\]]$/, '');

  // 「课程名-教师名」。原实现会把后缀直接丢掉，教师信息也跟着没了，
  // 现在改成摘出来放进 teacher。
  const dashSplit = name.split(/\s*[-—－]\s*/);
  if (dashSplit.length === 2) {
    const head = dashSplit[0].trim();
    const tail = dashSplit[1].trim();
    if (head.length >= 3 && looksLikeNameSuffix(tail)) {
      teacher = tail.replace(NAME_SUFFIX_RE, '').trim();
      name = head;
    }
  }

  // 去掉学年学期后缀
  name = name.replace(/[（(]\s*\d{4}\s*[-—]\s*\d{4}\s*[-—]?\s*[12]?\s*[）)]\s*$/, '');

  // 括号里没写、但标题里有「3学分」「学分：3」这种裸写法的，兜底再试一次
  if (credits === null) credits = extractCreditFromText(original);
  if (hours === null) hours = extractHoursFromText(original);

  return {
    name: name.trim() || original,
    teacher,
    credits,
    hours,
  };
}

/**
 * 把周次数字数组压缩成表达式。
 *   [1..16]        -> '1-16'
 *   [1,3,5,7]      -> '1-16单'
 *   [2,4,6]        -> '1-16双'
 *   [1,2,3,5,6,7]  -> '1-3,5-7'
 */
export function compressWeeks(weeks) {
  const sorted = [...new Set(weeks.filter((w) => Number.isFinite(w) && w > 0))].sort((a, b) => a - b);
  if (!sorted.length) return '1-16';
  if (sorted.length === 1) return String(sorted[0]);

  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // 全是奇数且连续 → '单'
  const allOdd = sorted.every((w) => w % 2 === 1);
  const allEven = sorted.every((w) => w % 2 === 0);
  const contiguous = sorted.length === max - min + 1;

  if (contiguous && allOdd && min === 1) return `1-${max}单`;
  if (contiguous && allEven) return `1-${max}双`;
  if (contiguous) return `${min}-${max}`;

  // 判定「等间隔 2」的奇偶序列
  const isParitySequence = sorted.length > 2
    && sorted.every((w, i) => i === 0 || w - sorted[i - 1] === 2)
    && ((allOdd && min === 1) || allEven);

  if (isParitySequence) return `${min}-${max}${allOdd ? '单' : '双'}`;

  // 退化为逐段合并的列举
  const parts = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i += 1) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      parts.push(runStart === prev ? String(runStart) : `${runStart}-${prev}`);
      runStart = cur;
    }
    prev = cur;
  }
  return parts.join(',');
}

/**
 * 解析 ICS 文本，还原成课程结构。
 *
 * @param {string} text ics 文件内容
 * @param {object} [opts]
 * @param {string} [opts.termStart] 学期第 1 周周一；不传则从最早的一节课推断
 * @returns {{
 *   courses: Array<{name, teacher, classroom, credits, sessions: Array<{weekday,startTime,endTime,weeks,location}>}>,
 *   termStart: string|null,
 *   warnings: string[],
 *   eventCount: number
 * }}
 */
export function parseIcsTimetable(text, opts = {}) {
  const parsed = parseICS(text);
  const warnings = [...(parsed.warnings || [])];

  const events = (parsed.events || []).filter((e) => e.summary && e.start);
  if (!events.length) {
    warnings.push('这个 ICS 文件里没有找到任何日程。可能导出的是「作业」而不是「课表」，或者文件格式不受支持。');
    return { courses: [], termStart: null, warnings, eventCount: 0 };
  }

  // ----------------------------------------------------------
  // 第 1 步：把所有事件展开成具体发生的「课次」
  // ----------------------------------------------------------
  const allStarts = events.map((e) => String(e.start).slice(0, 10)).filter(Boolean).sort();
  const earliest = allStarts[0];
  const latest = allStarts[allStarts.length - 1];

  // 展开区间要比事件本身宽一些，RRULE 的 COUNT/UNTIL 会自然截断
  const rangeStart = new Date(`${addDays(earliest, -7)}T00:00:00`);
  const rangeEnd = new Date(`${addDays(latest, 400)}T23:59:59`);

  const occurrences = [];
  for (const event of events) {
    try {
      const expanded = expandRecurrence(event, rangeStart, rangeEnd, { maxOccurrences: 2000 });
      if (!expanded.length) {
        // 展开失败时至少把原始单次事件用上
        occurrences.push(toOccurrence(event, event.start, event.end));
        continue;
      }
      for (const occ of expanded) {
        occurrences.push(toOccurrence(event, occ.start, occ.end));
      }
    } catch (err) {
      warnings.push(`事件「${event.summary}」展开失败：${err.message}`);
    }
  }

  if (!occurrences.length) {
    warnings.push('事件存在，但没能展开出任何课次。');
    return { courses: [], termStart: null, warnings, eventCount: events.length };
  }

  // ----------------------------------------------------------
  // 第 2 步：确定学期起点，算出每个课次属于第几周
  // ----------------------------------------------------------
  occurrences.sort((a, b) => a.date.localeCompare(b.date));
  const termStart = opts.termStart || startOfWeek(occurrences[0].date);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)) {
    warnings.push('无法确定学期起始日期，周次信息可能不准确。');
  }

  const baseMonday = startOfWeek(termStart);
  for (const occ of occurrences) {
    const monday = startOfWeek(occ.date);
    const diffDays = Math.round(
      (new Date(`${monday}T00:00:00`) - new Date(`${baseMonday}T00:00:00`)) / 86_400_000,
    );
    occ.week = Math.floor(diffDays / 7) + 1;
  }

  // 丢掉算出负数或超大周次的异常记录
  const valid = occurrences.filter((o) => o.week >= 1 && o.week <= 40);
  if (valid.length < occurrences.length) {
    warnings.push(`有 ${occurrences.length - valid.length} 个课次不在合理的学期范围内，已忽略。`);
  }

  // ----------------------------------------------------------
  // 第 3 步：按「课程名 + 星期 + 时间 + 地点」分组，收集周次
  // ----------------------------------------------------------
  const coursesMap = new Map();

  for (const occ of valid) {
    const title = parseCourseTitle(occ.summary);
    const name = title.name;
    if (!name) continue;

    if (!coursesMap.has(name)) {
      coursesMap.set(name, {
        name,
        teacher: occ.teacher || title.teacher || '',
        classroom: occ.location || '',
        credits: occ.credits ?? title.credits ?? null,
        hours: occ.hours ?? title.hours ?? null,
        periods: occ.periods || '',
        leftover: occ.leftover || '',
        sessionMap: new Map(),
      });
    }

    const course = coursesMap.get(name);
    if (!course.teacher && (occ.teacher || title.teacher)) {
      course.teacher = occ.teacher || title.teacher;
    }
    if (!course.classroom && occ.location) course.classroom = occ.location;
    if (course.credits === null && occ.credits !== null) course.credits = occ.credits;
    if (course.credits === null && title.credits !== null) course.credits = title.credits;
    if (course.hours === null && occ.hours !== null) course.hours = occ.hours;
    if (course.hours === null && title.hours !== null) course.hours = title.hours;
    if (!course.periods && occ.periods) course.periods = occ.periods;
    if (!course.leftover && occ.leftover) course.leftover = occ.leftover;

    const key = `${occ.weekday}|${occ.startTime}|${occ.endTime}|${occ.location}`;
    if (!course.sessionMap.has(key)) {
      course.sessionMap.set(key, {
        weekday: occ.weekday,
        startTime: occ.startTime,
        endTime: occ.endTime,
        location: occ.location,
        teacher: occ.teacher,
        periods: occ.periods,
        weeks: new Set(),
      });
    }
    course.sessionMap.get(key).weeks.add(occ.week);
  }

  // ----------------------------------------------------------
  // 第 4 步：整理成最终结构
  // ----------------------------------------------------------
  const courses = [];
  for (const course of coursesMap.values()) {
    const sessions = [...course.sessionMap.values()].map((s) => ({
      weekday: s.weekday,
      startTime: s.startTime,
      endTime: s.endTime,
      location: s.location || course.classroom,
      teacher: s.teacher || course.teacher,
      // 教务系统原话里的节次，显示在课表上方便交叉核对
      periodLabel: s.periods ? `第 ${s.periods} 节` : '',
      weeks: compressWeeks([...s.weeks]),
      weekCount: s.weeks.size,
    }));

    sessions.sort((a, b) => (a.weekday - b.weekday) || a.startTime.localeCompare(b.startTime));

    courses.push({
      name: course.name,
      teacher: course.teacher,
      classroom: course.classroom,
      credits: course.credits,
      hours: course.hours,
      // 导入备注只保留有用的信息（节次、剩下的散碎文字），
      // 不再把整段原始描述塞进去——那里面有教室和教师，现在已经在各自的字段里了
      note: buildImportNote(course),
      sessions,
      // 用于给用户展示「这门课一共多少次」
      occurrenceCount: sessions.reduce((sum, s) => sum + s.weekCount, 0),
    });
  }

  courses.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  if (!courses.length) {
    warnings.push('解析后没有得到任何课程。请确认这个 ICS 文件确实是课程表。');
  }

  // ----------------------------------------------------------
  // 诊断信息：这个文件里到底有哪些字段
  //
  // 加这个的原因：用户反馈「学分没导进来」，但光看结果是没法判断
  // 「文件里本来就没有」还是「解析漏了」。把原始属性摊开就能一眼看出来。
  // ----------------------------------------------------------
  const rawPropertyNames = new Set();
  for (const event of events) {
    for (const key of Object.keys(event.raw || {})) rawPropertyNames.add(key);
  }

  const sampleEvent = events[0]
    ? {
      summary: events[0].summary || '',
      location: events[0].location || '',
      description: events[0].description || '',
      custom: { ...(events[0].raw || {}) },
    }
    : null;

  // 各类信息在文件里的可识别情况
  const found = {
    credits: courses.filter((c) => c.credits !== null).length,
    hours: courses.filter((c) => c.hours !== null).length,
    teacher: courses.filter((c) => c.teacher).length,
    classroom: courses.filter((c) => c.classroom).length,
  };

  return {
    courses,
    termStart: baseMonday,
    termEnd: addDays(baseMonday, 20 * 7),
    warnings,
    eventCount: events.length,
    occurrenceCount: valid.length,
    diagnostics: {
      rawPropertyNames: [...rawPropertyNames].sort(),
      sampleEvent,
      found,
      courseCount: courses.length,
    },
  };
}

/** 把一次具体发生整理成统一结构 */
function toOccurrence(event, start, end) {
  const date = String(start).slice(0, 10);
  const description = String(event.description || '');
  const location = String(event.location || '');

  // 教室和教师两处都可能带。DESCRIPTION 里通常有更完整的结构化信息，以它为主；
  // 缺哪个字段就从 LOCATION 里补哪个。
  const fromDescription = parsePlacement(description);
  const fromLocation = parsePlacement(location);

  return {
    summary: event.summary,
    date,
    weekday: weekdayOf(date),
    startTime: String(start).slice(11, 16) || '08:00',
    endTime: String(end).slice(11, 16) || '09:40',

    // 这两个是拆分后的干净值，不再是「教室 + 人名」粘在一起的整串
    location: fromDescription.classroom || fromLocation.classroom,
    teacher: fromDescription.teacher || fromLocation.teacher,

    // 教务系统在描述里写的原始节次，用于交叉核对（课表页会显示）
    periods: fromDescription.periods || fromLocation.periods,

    // 原始值留着，方便排查和回退
    rawLocation: location,
    description,

    // 描述里既不是教室也不是人名的剩余文字
    leftover: [fromDescription.leftover, fromLocation.leftover].filter(Boolean).join(' '),

    // 学分 / 学时：从四个来源依次找，取第一个有结果的。
    // 顺序上把「自定义属性」放最前，因为那是最明确的信号；
    // 文本启发式放在后面兜底。
    credits: extractCreditFromRaw(event.raw)
      ?? extractCreditFromText(description)
      ?? extractCreditFromText(event.summary)
      ?? extractCreditFromText(location),

    hours: extractHoursFromRaw(event.raw)
      ?? extractHoursFromText(description)
      ?? extractHoursFromText(event.summary)
      ?? extractHoursFromText(location),

    // 原始属性留一份，方便排查「为什么这个字段没解析出来」
    rawKeys: Object.keys(event.raw || {}),
  };
}

/**
 * 生成课程的导入备注。
 * 只保留「节次」和解析不出来的剩余文字，不再重复教室与教师。
 */
function buildImportNote(course) {
  const parts = [];
  if (course.periods) parts.push(`第 ${course.periods} 节`);
  if (course.leftover) parts.push(course.leftover);
  return parts.join(' · ');
}

/**
 * 把解析结果写进数据库。
 *
 * 冲突策略：
 *   skip   同名的课程直接跳过（默认，避免重复导入把课表搞乱）
 *   merge  同名课程的周次取并集
 *   rename 同名课程加后缀「(2)」
 *
 * @returns {{created:number, merged:number, skipped:number, details:string[]}}
 */
export function importCourses(userId, parsed, termId, { onConflict = 'skip' } = {}) {
  const result = { created: 0, merged: 0, skipped: 0, details: [] };

  tx(() => {
    for (const course of parsed.courses) {
      const existing = get(
        'SELECT * FROM courses WHERE user_id = ? AND name = ? LIMIT 1',
        userId,
        course.name,
      );

      // 组装成上课时间
      const sessions = course.sessions.map((s) => ({
        weekday: s.weekday,
        startTime: s.startTime,
        endTime: s.endTime,
        weeks: s.weeks,
        location: s.location || '',
        teacher: s.teacher || '',
        // 教务系统原话里的节次，存下来在课表页显示，方便核对
        periodLabel: s.periodLabel || '',
      }));

      if (existing) {
        if (onConflict === 'skip') {
          result.skipped += 1;
          result.details.push(`跳过已存在的课程：${course.name}`);
          continue;
        }
        if (onConflict === 'merge') {
          // 只补上原来没有的时间段
          const current = all('SELECT * FROM course_sessions WHERE course_id = ?', existing.id);
          let added = 0;
          for (const s of sessions) {
            const dup = current.some(
              (c) => c.weekday === s.weekday && c.start_time === s.startTime && c.weeks === s.weeks,
            );
            if (dup) continue;
            run(
              `INSERT INTO course_sessions (course_id, weekday, start_time, end_time, weeks, location, teacher, note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              existing.id,
              s.weekday,
              s.startTime,
              s.endTime,
              s.weeks,
              s.location,
              s.teacher,
              s.periodLabel,
            );
            added += 1;
          }
          // 顺手补上原来为空的元信息。
          // credits / hours 用 COALESCE —— 已经填过的值不覆盖，
          // 只把空的补上，这样「先导入后再补一份带学分的 ICS」也能生效。
          run(
            `UPDATE courses SET
               teacher = CASE WHEN teacher = '' THEN ? ELSE teacher END,
               classroom = CASE WHEN classroom = '' THEN ? ELSE classroom END,
               credits = COALESCE(credits, ?),
               hours = COALESCE(hours, ?)
             WHERE id = ?`,
            course.teacher || '',
            course.classroom || '',
            course.credits ?? null,
            course.hours ?? null,
            existing.id,
          );
          result.merged += 1;
          result.details.push(`合并到已有课程：${course.name}（新增 ${added} 个时间段）`);
          continue;
        }
        // rename
        let suffix = 2;
        let newName = `${course.name}(${suffix})`;
        while (get('SELECT id FROM courses WHERE user_id = ? AND name = ?', userId, newName)) {
          suffix += 1;
          newName = `${course.name}(${suffix})`;
        }
        course.name = newName;
      }

      // 颜色必须显式给：建表时的列默认值只对「当时新建的表」生效，
      // 老库改了默认值也不会跟着变，靠默认值就会出现
      // 「老课程是新蓝、刚导入的是旧蓝」这种一眼能看出来的错位。
      const { lastInsertRowid } = run(
        `INSERT INTO courses
           (user_id, term_id, name, teacher, credits, hours, classroom, category, color, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
        userId,
        termId ?? null,
        course.name,
        course.teacher || '',
        course.credits ?? null,
        course.hours ?? null,
        course.classroom || '',
        DEFAULT_COURSE_COLOR,
        course.note ? `导入自 ICS：${String(course.note).slice(0, 300)}` : '',
      );

      for (const s of sessions) {
        run(
          `INSERT INTO course_sessions (course_id, weekday, start_time, end_time, weeks, location, teacher, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          lastInsertRowid,
          s.weekday,
          s.startTime,
          s.endTime,
          s.weeks,
          s.location,
          s.teacher,
          s.periodLabel,
        );
      }

      result.created += 1;
      result.details.push(`新建课程：${course.name}（${sessions.length} 个时间段）`);
    }
  });

  return result;
}

/** 生成导入预览用的一行摘要文本 */
export function describeSession(session) {
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const where = session.location ? ` @ ${session.location}` : '';
  return `${weekdayNames[session.weekday]} ${session.startTime}-${session.endTime} 第 ${session.weeks} 周${where}`;
}

export { toDateStr };
