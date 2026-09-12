/**
 * ICS 课表导入的单元测试。
 *
 * 重点是「教室 / 教师」的拆分——真实踩过的坑：
 * 教务系统把教室和教师塞在同一个字段里（`校本部之远楼716 孙艳霞`），
 * 结果整串被当成教室，教师字段永远是空的。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 导入被测模块会连带加载 config.js，它会创建 data 目录和密钥。
// 测试里把 DATA_DIR 指到临时目录，避免污染项目的真实数据。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-ics-test-'));

let parsePlacement;
let looksLikeClassroom;
let looksLikePersonName;
let parseCourseTitle;
let parseIcsTimetable;
let compressWeeks;
let extractCreditFromText;
let extractHoursFromText;
let extractCreditFromRaw;
let extractHoursFromRaw;

before(async () => {
  const mod = await import('../src/lib/import/ics-import.js');
  ({
    parsePlacement,
    looksLikeClassroom,
    looksLikePersonName,
    parseCourseTitle,
    parseIcsTimetable,
    compressWeeks,
    extractCreditFromText,
    extractHoursFromText,
    extractCreditFromRaw,
    extractHoursFromRaw,
  } = mod);
});

// ============================================================
// 学分 / 学时
// ============================================================

describe('extractCreditFromText', () => {
  const cases = [
    ['学分：4', 4],
    ['学分:3', 3],
    ['学分 3', 3],
    ['学分=3', 3],
    ['3学分', 3],
    ['3.0学分', 3],
    ['3.0 学分', 3],
    ['0.5学分', 0.5],
    ['CREDITS:3', 3],
    ['credits: 2.5', 2.5],
    ['学分：4\n校本部之远楼401', 4],
  ];
  for (const [input, expected] of cases) {
    test(`「${JSON.stringify(input)}」→ ${expected}`, () => {
      assert.equal(extractCreditFromText(input), expected);
    });
  }

  test('没有学分信息时返回 null', () => {
    assert.equal(extractCreditFromText('第5 - 7节\n校本部之远楼716\n孙艳霞'), null);
    assert.equal(extractCreditFromText(''), null);
    assert.equal(extractCreditFromText(null), null);
  });

  test('毕业总学分这种大数字不会被当成课程学分', () => {
    assert.equal(extractCreditFromText('毕业总学分：160'), null);
  });

  test('学分为 0 或负数不采信', () => {
    assert.equal(extractCreditFromText('学分：0'), null);
  });
});

describe('extractHoursFromText', () => {
  test('各种写法', () => {
    assert.equal(extractHoursFromText('学时：48'), 48);
    assert.equal(extractHoursFromText('48学时'), 48);
    assert.equal(extractHoursFromText('HOURS: 64'), 64);
    assert.equal(extractHoursFromText('总学时：160'), 160);
  });

  test('没有学时信息时返回 null', () => {
    assert.equal(extractHoursFromText('学分：3'), null);
  });
});

describe('extractCreditFromRaw / extractHoursFromRaw', () => {
  test('认常见的自定义属性名', () => {
    assert.equal(extractCreditFromRaw({ 'X-CREDITS': '3' }), 3);
    assert.equal(extractCreditFromRaw({ CREDITS: '2.5' }), 2.5);
    assert.equal(extractCreditFromRaw({ 学分: '4' }), 4);
    assert.equal(extractCreditFromRaw({ 'X-学分': '3' }), 3);
    assert.equal(extractHoursFromRaw({ 'X-HOURS': '48' }), 48);
    assert.equal(extractHoursFromRaw({ 学时: '64' }), 64);
  });

  test('无关属性不会误命中', () => {
    assert.equal(extractCreditFromRaw({ 'X-TEACHER': '张三', LOCATION: '之远楼301' }), null);
    assert.equal(extractCreditFromRaw({}), null);
    assert.equal(extractCreditFromRaw(null), null);
  });
});

describe('parseCourseTitle 里的学分', () => {
  test('括号里的学分被摘出来，名字里不再残留', () => {
    const r = parseCourseTitle('金融市场与金融机构(3学分)');
    assert.equal(r.name, '金融市场与金融机构');
    assert.equal(r.credits, 3);
  });

  test('小数点与全角括号都认', () => {
    assert.equal(parseCourseTitle('金融学（3.0学分）').credits, 3);
    assert.equal(parseCourseTitle('金融学[2.5学分]').credits, 2.5);
    assert.equal(parseCourseTitle('金融学[2.5学分]').name, '金融学');
  });

  test('方括号写在开头也能摘出来', () => {
    const r = parseCourseTitle('[3学分]金融学');
    assert.equal(r.credits, 3);
    assert.equal(r.name, '金融学');
  });

  test('学时同样处理', () => {
    const r = parseCourseTitle('会计学原理(4学分, 64学时)');
    assert.equal(r.credits, 4);
    assert.equal(r.hours, 64);
    assert.equal(r.name, '会计学原理');
  });

  test('没有学分信息时返回 null，名字原样保留', () => {
    const r = parseCourseTitle('数学分析 Ⅲ');
    assert.equal(r.name, '数学分析 Ⅲ');
    assert.equal(r.credits, null);
    assert.equal(r.hours, null);
  });

  test('学分和教师后缀能同时摘出来', () => {
    const r = parseCourseTitle('高等数学(5学分)-张三');
    assert.equal(r.name, '高等数学');
    assert.equal(r.credits, 5);
    assert.equal(r.teacher, '张三');
  });
});

// ============================================================
// 教室 / 人名的判断
// ============================================================

describe('looksLikeClassroom', () => {
  const yes = [
    '校本部之远楼716',
    '校本部笃行楼603',
    '之远楼W201',
    '博学楼108',
    '之远楼301',
    '1-301',
    '线上教学',
    '校本部网络教学平台超星学习通线上自学',
    '腾讯会议',
    'A区实验楼',
  ];
  for (const s of yes) {
    test(`「${s}」是教室`, () => assert.equal(looksLikeClassroom(s), true));
  }

  const no = ['孙艳霞', '王玺', '王艳', '梁修博', '于晓宇', ''];
  for (const s of no) {
    test(`「${s}」不是教室`, () => assert.equal(looksLikeClassroom(s), false));
  }
});

describe('looksLikePersonName', () => {
  const yes = ['孙艳霞', '王玺', '王艳', '梁修博', '于晓宇', '张三老师', '张三教授'];
  for (const s of yes) {
    test(`「${s}」是人名`, () => assert.equal(looksLikePersonName(s), true));
  }

  // 关键回归：「之远楼」也是 3 个汉字，很容易被误判成人名
  const no = ['之远楼', '博学楼', '笃行楼', '校本部之远楼716', 'Z', '张三丰真人', ''];
  for (const s of no) {
    test(`「${s}」不是人名`, () => assert.equal(looksLikePersonName(s), false));
  }
});

// ============================================================
// parsePlacement：核心的字段切分
// ============================================================

describe('parsePlacement', () => {
  test('多行格式：节次 / 教室 / 教师 各占一行', () => {
    const r = parsePlacement('第5 - 7节\n校本部之远楼716\n孙艳霞');
    assert.equal(r.periods, '5-7');
    assert.equal(r.classroom, '校本部之远楼716');
    assert.equal(r.teacher, '孙艳霞');
  });

  test('单行格式：教室和教师用空格连在一起', () => {
    const r = parsePlacement('校本部之远楼716 孙艳霞');
    assert.equal(r.classroom, '校本部之远楼716');
    assert.equal(r.teacher, '孙艳霞');
  });

  test('单行格式：两字姓名', () => {
    const r = parsePlacement('校本部笃行楼603 王玺');
    assert.equal(r.classroom, '校本部笃行楼603');
    assert.equal(r.teacher, '王玺');
  });

  test('单行格式：线上课程的场地名很长', () => {
    const r = parsePlacement('校本部网络教学平台超星学习通线上自学 于晓宇');
    assert.equal(r.classroom, '校本部网络教学平台超星学习通线上自学');
    assert.equal(r.teacher, '于晓宇');
  });

  test('三种真实写法都能拆对', () => {
    const cases = [
      ['校本部之远楼716 孙艳霞', '校本部之远楼716', '孙艳霞'],
      ['校本部笃行楼603 王玺', '校本部笃行楼603', '王玺'],
      ['校本部之远楼309 王泽群', '校本部之远楼309', '王泽群'],
      ['校本部之远楼412 王丹丹', '校本部之远楼412', '王丹丹'],
      ['校本部笃行楼510 梁修博', '校本部笃行楼510', '梁修博'],
      ['校本部之远楼802 胡鑫', '校本部之远楼802', '胡鑫'],
    ];
    for (const [input, classroom, teacher] of cases) {
      const r = parsePlacement(input);
      assert.equal(r.classroom, classroom, `教室识别错误：${input}`);
      assert.equal(r.teacher, teacher, `教师识别错误：${input}`);
    }
  });

  test('只有教室时不硬塞教师', () => {
    const r = parsePlacement('之远楼301');
    assert.equal(r.classroom, '之远楼301');
    assert.equal(r.teacher, '');
  });

  test('带关键词的写法优先', () => {
    const r = parsePlacement('任课教师：张三\n上课地点：之远楼301');
    assert.equal(r.teacher, '张三');
    assert.equal(r.classroom, '之远楼301');
  });

  test('关键词和裸值混在一起也能拆', () => {
    const r = parsePlacement('教师：李四\n之远楼502');
    assert.equal(r.teacher, '李四');
    assert.equal(r.classroom, '之远楼502');
  });

  test('竖线分隔的写法', () => {
    const r = parsePlacement('校本部之远楼716 | 孙艳霞');
    assert.equal(r.classroom, '校本部之远楼716');
    assert.equal(r.teacher, '孙艳霞');
  });

  test('只有节次时不产生教室或教师', () => {
    const r = parsePlacement('第3 - 4节');
    assert.equal(r.periods, '3-4');
    assert.equal(r.classroom, '');
    assert.equal(r.teacher, '');
  });

  test('节次写法兼容多种形式', () => {
    assert.equal(parsePlacement('第5-7节').periods, '5-7');
    assert.equal(parsePlacement('第5 - 7节').periods, '5-7');
    assert.equal(parsePlacement('5-7节').periods, '5-7');
    assert.equal(parsePlacement('第5节').periods, '5');
    assert.equal(parsePlacement('第1 - 2节').periods, '1-2');
  });

  test('空输入返回全空', () => {
    const r = parsePlacement('');
    assert.deepEqual(
      { t: r.teacher, c: r.classroom, p: r.periods },
      { t: '', c: '', p: '' },
    );
  });

  test('含数字的元信息行不会被当成门牌号', () => {
    const r = parsePlacement('校本部之远楼716\n学分：4\n课程号：FIN301');
    assert.equal(r.classroom, '校本部之远楼716', '「学分：4」里的数字不该被当成教室');
    assert.equal(r.teacher, '');
  });

  test('元信息行排在教室前面也不影响', () => {
    const r = parsePlacement('学分：4\n校本部之远楼716 孙艳霞');
    assert.equal(r.classroom, '校本部之远楼716');
    assert.equal(r.teacher, '孙艳霞');
  });

  test('教师关键词行不会被当成元信息跳过', () => {
    const r = parsePlacement('教师：张三\n学分：3');
    assert.equal(r.teacher, '张三');
    assert.equal(r.classroom, '', '「学分：3」不该变成教室');
  });

  test('教师名不会跑进教室字段（核心回归）', () => {
    const r = parsePlacement('校本部之远楼716 孙艳霞');
    assert.ok(!r.classroom.includes('孙艳霞'), `教室字段里混进了人名：${r.classroom}`);
  });
});

// ============================================================
// parseCourseTitle
// ============================================================

describe('parseCourseTitle', () => {
  test('去掉方括号标签', () => {
    assert.equal(parseCourseTitle('【必修】高等数学(上)').name, '高等数学(上)');
  });

  test('去掉学年学期后缀', () => {
    assert.equal(parseCourseTitle('高等数学(2024-2025-1)').name, '高等数学');
  });

  test('「课程名-教师名」把教师摘出来', () => {
    const r = parseCourseTitle('高等数学-张三');
    assert.equal(r.name, '高等数学');
    assert.equal(r.teacher, '张三');
  });

  test('后缀不像人名时，课程名完整保留（不再无条件截断）', () => {
    // 旧实现会把任何 2-4 汉字的「-后缀」都当成教师名剥掉，
    // 于是「大学英语-读写」被截成「大学英语」——课程名被改坏了。
    const r = parseCourseTitle('大学英语-读写');
    assert.equal(r.name, '大学英语-读写', '后缀不像人名时应完整保留');
    assert.equal(r.teacher, '');
  });

  test('其它非人名的后缀也保留', () => {
    assert.equal(parseCourseTitle('体育-篮球').name, '体育-篮球');
    assert.equal(parseCourseTitle('高等数学-习题课').name, '高等数学-习题课');
  });

  test('真的人名后缀仍然会被摘出来', () => {
    const cases = [
      ['高等数学-张三', '高等数学', '张三'],
      ['线性代数-李四', '线性代数', '李四'],
      ['大学物理-王艳', '大学物理', '王艳'],
      ['数据结构-梁修博', '数据结构', '梁修博'],
    ];
    for (const [input, name, teacher] of cases) {
      const r = parseCourseTitle(input);
      assert.equal(r.name, name, `课程名解析错误：${input}`);
      assert.equal(r.teacher, teacher, `教师解析错误：${input}`);
    }
  });

  test('带空格的正常课程名不受影响', () => {
    assert.equal(parseCourseTitle('数学分析 Ⅲ').name, '数学分析 Ⅲ');
    assert.equal(parseCourseTitle('Python程序设计与数据分析').name, 'Python程序设计与数据分析');
    assert.equal(parseCourseTitle('形势与政策3').name, '形势与政策3');
  });

  test('空标题不抛异常', () => {
    const r = parseCourseTitle('');
    assert.equal(r.name, '');
    assert.equal(r.teacher, '');
    assert.equal(r.credits, null);
    assert.equal(r.hours, null);
  });

  test('括号里夹着别的信息时，整块保留不动', () => {
    // 「(上)」是课程名的一部分，不能因为括号处理逻辑就吃掉
    assert.equal(parseCourseTitle('高等数学(上)').name, '高等数学(上)');
    assert.equal(parseCourseTitle('高等数学(上)').credits, null);
  });
});

// ============================================================
// compressWeeks（顺带回归）
// ============================================================

describe('compressWeeks', () => {
  test('连续周', () => assert.equal(compressWeeks([1, 2, 3, 4, 5]), '1-5'));
  test('单周', () => assert.equal(compressWeeks([1, 3, 5, 7]), '1-7单'));
  test('多段', () => assert.equal(compressWeeks([1, 2, 3, 8, 9]), '1-3,8-9'));
  test('单周次', () => assert.equal(compressWeeks([3]), '3'));
  test('空数组退回默认', () => assert.equal(compressWeeks([]), '1-16'));
});

// ============================================================
// 端到端：教务系统真实格式的 ICS
// ============================================================

describe('parseIcsTimetable 处理教室教师粘连的 ICS', () => {
  /** 复刻用户学校教务系统导出的格式 */
  const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JWC//CN',
    'BEGIN:VEVENT',
    'UID:c1@jwc',
    'SUMMARY:金融市场与金融机构',
    'DTSTART;TZID=Asia/Shanghai:20260907T130000',
    'DTEND;TZID=Asia/Shanghai:20260907T152500',
    'LOCATION:校本部之远楼716 孙艳霞',
    'DESCRIPTION:第5 - 7节\\n校本部之远楼716\\n孙艳霞',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=18',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c2@jwc',
    'SUMMARY:公司金融',
    'DTSTART;TZID=Asia/Shanghai:20260910T130000',
    'DTEND;TZID=Asia/Shanghai:20260910T143500',
    'LOCATION:校本部笃行楼603 王玺',
    'DESCRIPTION:第5 - 6节\\n校本部笃行楼603\\n王玺',
    'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=18',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c3@jwc',
    'SUMMARY:国家安全教育',
    'DTSTART;TZID=Asia/Shanghai:20260913T181500',
    'DTEND;TZID=Asia/Shanghai:20260913T204000',
    'LOCATION:校本部网络教学平台超星学习通线上自学 于晓宇',
    'DESCRIPTION:第8 - 10节\\n校本部网络教学平台超星学习通线上自学\\n于晓宇',
    'RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=6',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  let parsed;

  before(() => {
    parsed = parseIcsTimetable(ICS);
  });

  test('解析出 3 门课程', () => {
    assert.equal(parsed.courses.length, 3);
  });

  test('教师被正确识别，不再混进教室', () => {
    const byName = Object.fromEntries(parsed.courses.map((c) => [c.name, c]));
    assert.equal(byName['金融市场与金融机构'].teacher, '孙艳霞');
    assert.equal(byName['公司金融'].teacher, '王玺');
    assert.equal(byName['国家安全教育'].teacher, '于晓宇');
  });

  test('教室字段是干净的教室名', () => {
    const byName = Object.fromEntries(parsed.courses.map((c) => [c.name, c]));
    assert.equal(byName['金融市场与金融机构'].classroom, '校本部之远楼716');
    assert.equal(byName['公司金融'].classroom, '校本部笃行楼603');
    assert.equal(
      byName['国家安全教育'].classroom,
      '校本部网络教学平台超星学习通线上自学',
    );
  });

  test('教室字段里不含任何人名', () => {
    for (const c of parsed.courses) {
      assert.ok(!c.classroom.includes(c.teacher), `${c.name} 的教室字段混进了教师名`);
    }
  });

  test('课程名没有被污染', () => {
    const names = parsed.courses.map((c) => c.name).sort();
    assert.deepEqual(names, ['公司金融', '国家安全教育', '金融市场与金融机构']);
  });

  test('时间段带上了教务系统原话的节次', () => {
    const finance = parsed.courses.find((c) => c.name === '金融市场与金融机构');
    assert.equal(finance.sessions[0].periodLabel, '第 5-7 节');
  });

  test('时间段上也有教师和教室', () => {
    const finance = parsed.courses.find((c) => c.name === '金融市场与金融机构');
    assert.equal(finance.sessions[0].teacher, '孙艳霞');
    assert.equal(finance.sessions[0].location, '校本部之远楼716');
  });

  test('备注只留节次，不再重复教室和教师', () => {
    const finance = parsed.courses.find((c) => c.name === '金融市场与金融机构');
    assert.equal(finance.note, '第 5-7 节');
  });

  test('周次仍然正确', () => {
    const finance = parsed.courses.find((c) => c.name === '金融市场与金融机构');
    assert.equal(finance.sessions[0].weeks, '1-18');
  });

  test('上课时间仍然正确', () => {
    const finance = parsed.courses.find((c) => c.name === '金融市场与金融机构');
    assert.equal(finance.sessions[0].startTime, '13:00');
    assert.equal(finance.sessions[0].endTime, '15:25');
  });
});

// ============================================================
// 端到端：学分写在三个不同的地方
// ============================================================

describe('parseIcsTimetable 提取学分', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // ① 学分在自定义属性里
    'BEGIN:VEVENT',
    'UID:c1@jwc',
    'SUMMARY:金融市场与金融机构',
    'DTSTART;TZID=Asia/Shanghai:20260907T130000',
    'DTEND;TZID=Asia/Shanghai:20260907T152500',
    'LOCATION:校本部之远楼716 孙艳霞',
    'DESCRIPTION:第5 - 7节\\n校本部之远楼716\\n孙艳霞',
    'X-CREDITS:3',
    'X-HOURS:48',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=18',
    'END:VEVENT',
    // ② 学分写在课程名里
    'BEGIN:VEVENT',
    'UID:c2@jwc',
    'SUMMARY:公司金融(2.5学分)',
    'DTSTART;TZID=Asia/Shanghai:20260910T130000',
    'DTEND;TZID=Asia/Shanghai:20260910T143500',
    'LOCATION:校本部笃行楼603 王玺',
    'DESCRIPTION:第5 - 6节\\n校本部笃行楼603\\n王玺',
    'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=18',
    'END:VEVENT',
    // ③ 学分写在描述里
    'BEGIN:VEVENT',
    'UID:c3@jwc',
    'SUMMARY:宏观经济学',
    'DTSTART;TZID=Asia/Shanghai:20260909T130000',
    'DTEND;TZID=Asia/Shanghai:20260909T152500',
    'LOCATION:校本部之远楼412 王丹丹',
    'DESCRIPTION:第5 - 7节\\n校本部之远楼412\\n王丹丹\\n学分：4',
    'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=18',
    'END:VEVENT',
    // ④ 完全没有学分信息
    'BEGIN:VEVENT',
    'UID:c4@jwc',
    'SUMMARY:形势与政策3',
    'DTSTART;TZID=Asia/Shanghai:20260909T080000',
    'DTEND;TZID=Asia/Shanghai:20260909T093500',
    'LOCATION:校本部之远楼W201 丁涛',
    'DESCRIPTION:第1 - 2节\\n校本部之远楼W201\\n丁涛',
    'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  let parsed;
  before(() => { parsed = parseIcsTimetable(ICS); });

  const byName = (name) => parsed.courses.find((c) => c.name === name);

  test('解析出 4 门课程', () => {
    assert.equal(parsed.courses.length, 4, JSON.stringify(parsed.courses.map((c) => c.name)));
  });

  test('① 自定义属性里的学分被识别', () => {
    const c = byName('金融市场与金融机构');
    assert.equal(c.credits, 3);
    assert.equal(c.hours, 48);
  });

  test('② 课程名里的学分被识别，且名字里不残留「(2.5学分)」', () => {
    const c = byName('公司金融');
    assert.ok(c, `没找到「公司金融」，实际有：${parsed.courses.map((x) => x.name).join('、')}`);
    assert.equal(c.credits, 2.5);
  });

  test('③ 描述里的学分被识别', () => {
    assert.equal(byName('宏观经济学').credits, 4);
  });

  test('④ 没有学分信息时留空，不瞎猜', () => {
    assert.equal(byName('形势与政策3').credits, null);
  });

  test('学分提取不影响教师和教室的拆分', () => {
    const c = byName('宏观经济学');
    assert.equal(c.teacher, '王丹丹');
    assert.equal(c.classroom, '校本部之远楼412');
  });

  test('备注里不会重复学分（学分有自己的字段）', () => {
    assert.equal(byName('宏观经济学').note, '第 5-7 节');
  });
});

// ============================================================
// 端到端：换一份带学分的 ICS 重新导入时，能把空的学分补上
// ============================================================

describe('importCourses 的合并策略会补上学分', () => {
  test('credits 用 COALESCE，不覆盖已有值', async () => {
    const fs2 = await import('node:fs');
    const src = fs2.readFileSync(new URL('../src/lib/import/ics-import.js', import.meta.url), 'utf8');
    // 合并分支里必须用 COALESCE(credits, ?)，否则「先导入再补一份带学分的 ICS」补不上
    assert.match(src, /credits\s*=\s*COALESCE\(credits,\s*\?\)/);
    assert.match(src, /hours\s*=\s*COALESCE\(hours,\s*\?\)/);
  });
});

// ============================================================
// 真的写一次库：新建课程的颜色
//
// 这一条是被自己坑出来的。课程的 color 列在建表语句里带 DEFAULT，
// 而 SQLite 的 ALTER/CREATE IF NOT EXISTS 改不动**已有表**的默认值：
// 迁移把老库那 14 门课刷成新主色之后，列默认值还停在旧色上，
// 而 ICS 导入的 INSERT 恰好没写 color —— 结果就是
// 「老课程是新蓝、刚导入的是旧蓝」，一眼就能看出来的错位。
// 所以颜色必须由代码显式给，不能指望列默认值。
// ============================================================

describe('importCourses 真正写库后的颜色', () => {
  const USERNAME = 'ics-import-color-test';

  /** 造一个用户，导入一门课，跑完把数据清干净（共用测试库，别留垃圾） */
  async function withImportedCourse(fn) {
    const { getDb } = await import('../src/db/index.js');
    const db = getDb();

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME);
    const userId = existing
      ? existing.id
      : Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(USERNAME, 'x').lastInsertRowid);

    try {
      const { importCourses } = await import('../src/lib/import/ics-import.js');
      const parsed = parseIcsTimetable([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:color-test@jwc',
        'SUMMARY:颜色测试课',
        'DTSTART;TZID=Asia/Shanghai:20260907T080000',
        'DTEND;TZID=Asia/Shanghai:20260907T093500',
        'LOCATION:之远楼301 张三',
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=18',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'));

      const result = importCourses(userId, parsed, null, { onConflict: 'rename' });
      return await fn(db, result, userId);
    } finally {
      db.prepare('DELETE FROM course_sessions WHERE course_id IN (SELECT id FROM courses WHERE user_id = ?)').run(userId);
      db.prepare('DELETE FROM courses WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
  }

  test('★ 导入出来的课程带的是当前主色，不是建表时的旧默认值', async () => {
    const schema = await import('../src/db/schema.js');
    await withImportedCourse((db, result) => {
      assert.equal(result.created, 1, '这门课应该被新建出来');
      const row = db.prepare('SELECT name, color FROM courses WHERE name = ?').get('颜色测试课');
      assert.ok(row, '课程应该真的写进库里了');
      assert.equal(row.color, schema.DEFAULT_COURSE_COLOR,
        '导入的课必须是新主色，否则新旧课程在课表里是两种蓝');
    });
  });

  test('★ 不靠列默认值：INSERT 里必须显式写 color（静态守卫）', async () => {
    // 为什么这条必须做成静态检查：
    // 全新数据库的列默认值就是新主色，所以「漏写 color」在全新库上
    // 照样能导出正确颜色，上面那条动态测试抓不到它。
    // 只有「从 v2 升级上来的库」列默认值才是旧的 —— 也就是用户手上那个库。
    const src = fs.readFileSync(new URL('../src/lib/import/ics-import.js', import.meta.url), 'utf8');
    // 连参数一起抓出来，只看 SQL 模板会漏掉「列清单里有 color、但没传值」这种半吊子改法
    const call = src.match(/run\(\s*`INSERT INTO courses[\s\S]*?\n\s*\);/);
    assert.ok(call, '应该能定位到导入用的 INSERT 语句');
    const cols = call[0].match(/\(([^)]*)\)/);
    assert.ok(cols && /\bcolor\b/.test(cols[1]),
      '列清单里必须有 color，否则会回落到建表时的列默认值');
    assert.match(call[0], /DEFAULT_COURSE_COLOR/,
      '值必须来自代码里的常量，不能是硬编码或省略');
  });
});
