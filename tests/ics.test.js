/**
 * ics.js 的单元测试（node:test + node:assert/strict）。
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseICS,
  generateICS,
  expandRecurrence,
  unfoldLines,
  escapeText,
  unescapeText,
  formatIcsDate,
  parseIcsDateValue,
} from '../src/lib/ics.js';

const BOM = '\uFEFF';

/** 拼一个最小可用的 VCALENDAR 文本 */
function ics(...lines) {
  return (
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Timetable//CN', ...lines, 'END:VCALENDAR'].join(
      '\r\n',
    ) + '\r\n'
  );
}

/** 解析并断言只有一个事件 */
function onlyEvent(text) {
  const result = parseICS(text);
  assert.equal(result.events.length, 1);
  return result.events[0];
}

/** 用 UTC 字面量构造区间，避免依赖测试机器本机时区 */
function rangeUtc(a, b) {
  return [new Date(`${a}Z`), new Date(`${b}Z`)];
}

// ---------------------------------------------------------------------------
// 折行 / 行尾 / BOM
// ---------------------------------------------------------------------------

test('unfoldLines：展开折行、去 BOM、兼容 CRLF/LF/CR 混用', () => {
  const warnings = [];
  const text = `${BOM}BEGIN:VCALENDAR\r\nSUMMARY:很长很长\r\n 的摘要\nX-A:1\rX-B:2\r\n\r\nEND:VCALENDAR\r\n`;
  const lines = unfoldLines(text, warnings);
  assert.deepEqual(lines, [
    'BEGIN:VCALENDAR',
    'SUMMARY:很长很长的摘要',
    'X-A:1',
    'X-B:2',
    'END:VCALENDAR',
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /BOM/);
});

test('unfoldLines：用 TAB 续行同样有效', () => {
  assert.deepEqual(unfoldLines('SUMMARY:甲\n\t乙'), ['SUMMARY:甲乙']);
});

test('parseICS：BOM + CRLF + 折行 + 中文 + 值内转义', () => {
  const text =
    BOM +
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//School//Timetable//CN',
      'BEGIN:VEVENT',
      'UID:course-1@school.edu',
      'DTSTART;TZID=Asia/Shanghai:20240902T080000',
      'DTEND;TZID=Asia/Shanghai:20240902T094500',
      'SUMMARY:高等数学（上）\\, 第一讲',
      'DESCRIPTION:第一行\\n第二行\\n第三行',
      ' 上课地点见教务处通知',
      'LOCATION:教三-201',
      'ATTENDEE;CN="张三";ROLE=REQ-PARTICIPANT:mailto:zhangsan@example.com',
      'CATEGORIES:课程\\,数学,公共课',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n') +
    '\r\n';

  const result = parseICS(text);
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.uid, 'course-1@school.edu');
  assert.equal(event.summary, '高等数学（上）, 第一讲');
  assert.equal(event.description, '第一行\n第二行\n第三行上课地点见教务处通知');
  assert.equal(event.location, '教三-201');
  assert.equal(event.start, '2024-09-02T08:00:00');
  assert.equal(event.end, '2024-09-02T09:45:00');
  assert.equal(event.allDay, false);
  assert.equal(event.timezone, 'Asia/Shanghai');
  assert.deepEqual(event.categories, ['课程,数学', '公共课']);
  // 参数带引号（含冒号的 CN）不崩，且进入 raw
  assert.equal(event.raw.ATTENDEE, 'mailto:zhangsan@example.com');
  // 只有 BOM 一条提示
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /BOM/);
});

test('parseICS：属性名大小写不敏感，BEGIN/END 必须成对', () => {
  const text = [
    'begin:vcalendar',
    'begin:vevent',
    'uid:lower-1',
    'dtstart:20240902T080000',
    'dtend:20240902T090000',
    'summary:小写属性',
    'end:vevent',
    'end:vcalendar',
  ].join('\n');
  const result = parseICS(text);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].summary, '小写属性');
  assert.equal(result.events[0].start, '2024-09-02T08:00:00');
  assert.deepEqual(result.warnings, []);
});

test('parseICS：BEGIN/END 不匹配与垃圾行只产生 warning，不抛异常', () => {
  const text = [
    'BEGIN:VCALENDAR',
    '这不是一个属性行',
    'BEGIN:VEVENT',
    'DTSTART:20240902T090000',
    'SUMMARY:错配事件',
    'END:VCALENDAR',
    'END:VEVENT',
  ].join('\r\n');
  const result = parseICS(text);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].summary, '错配事件');
  assert.ok(result.warnings.some((w) => w.includes('不是合法的属性行')));
  assert.ok(result.warnings.some((w) => w.includes('不匹配')));
  assert.ok(result.warnings.some((w) => w.includes('多余的 END')));
});

test('parseICS：未闭合组件被强制结束并记 warning', () => {
  const result = parseICS(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20240902T080000', 'SUMMARY:孤儿'].join('\n'));
  assert.ok(result.warnings.some((w) => w.includes('未闭合')));
});

// ---------------------------------------------------------------------------
// 日期与时区
// ---------------------------------------------------------------------------

test('全天事件：VALUE=DATE 与 RFC5545 非包含 DTEND', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:holiday-1@school.edu',
      'DTSTART;VALUE=DATE:20241001',
      'DTEND;VALUE=DATE:20241002',
      'SUMMARY:国庆假期',
      'END:VEVENT',
    ),
  );
  assert.equal(event.allDay, true);
  assert.equal(event.start, '2024-10-01');
  assert.equal(event.end, '2024-10-01'); // DTEND 非包含：10-02 表示到 10-01 结束
  assert.equal(event.timezone, null);
});

test('全天事件：只有 DTSTART 时结束日期等于开始日期', () => {
  const event = onlyEvent(
    ics('BEGIN:VEVENT', 'UID:h-2', 'DTSTART;VALUE=DATE:20241001', 'SUMMARY:假期', 'END:VEVENT'),
  );
  assert.equal(event.allDay, true);
  assert.equal(event.start, '2024-10-01');
  assert.equal(event.end, '2024-10-01');
});

test('UTC（Z 结尾）换算为 Asia/Shanghai 墙上时间', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:utc-1',
      'DTSTART:20240902T000000Z',
      'DTEND:20240902T013000Z',
      'SUMMARY:早课',
      'END:VEVENT',
    ),
  );
  assert.equal(event.start, '2024-09-02T08:00:00');
  assert.equal(event.end, '2024-09-02T09:30:00');
  assert.equal(event.allDay, false);
});

test('UTC 跨日换算正确', () => {
  const event = onlyEvent(
    ics('BEGIN:VEVENT', 'UID:utc-2', 'DTSTART:20240901T160000Z', 'SUMMARY:跨日', 'END:VEVENT'),
  );
  assert.equal(event.start, '2024-09-02T00:00:00');
});

test('parseIcsDateValue：各种值形式', () => {
  assert.deepEqual(parseIcsDateValue('20240902', { VALUE: 'DATE' }), {
    value: '2024-09-02',
    allDay: true,
  });
  assert.deepEqual(parseIcsDateValue('20240902T080000', { TZID: 'Asia/Shanghai' }), {
    value: '2024-09-02T08:00:00',
    allDay: false,
  });
  assert.deepEqual(parseIcsDateValue('20240902T000000Z', {}), {
    value: '2024-09-02T08:00:00',
    allDay: false,
  });
  assert.deepEqual(parseIcsDateValue('20240902T000000Z', { TZID: 'Asia/Tokyo' }), {
    value: '2024-09-02T09:00:00',
    allDay: false,
  });
  // 参数字符串形式也支持
  assert.deepEqual(parseIcsDateValue('20240902T080000', 'TZID=Asia/Shanghai;VALUE=DATE-TIME'), {
    value: '2024-09-02T08:00:00',
    allDay: false,
  });
});

test('未知 TZID 与简化夏令时时区会记 warning', () => {
  const unknown = parseICS(
    ics(
      'BEGIN:VEVENT',
      'UID:tz-1',
      'DTSTART;TZID=Mars/Base:20240902T080000',
      'SUMMARY:火星时间',
      'END:VEVENT',
    ),
  );
  assert.equal(unknown.events[0].start, '2024-09-02T08:00:00'); // 原样保留
  assert.ok(unknown.warnings.some((w) => w.includes('未知时区')));

  const newYork = parseICS(
    ics(
      'BEGIN:VEVENT',
      'UID:tz-2',
      'DTSTART;TZID=America/New_York:20240902T080000',
      'SUMMARY:纽约时间',
      'END:VEVENT',
    ),
  );
  assert.ok(newYork.warnings.some((w) => w.includes('夏令时')));
});

test('parseICS：带 VTIMEZONE 的教务系统文件只保留一条时区告警', () => {
  const text = ics(
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:vtz-1',
    'DTSTART;TZID=Asia/Shanghai:20240902T080000',
    'DTEND;TZID=Asia/Shanghai:20240902T094500',
    'SUMMARY:线代',
    'END:VEVENT',
  );
  const result = parseICS(text);
  assert.equal(result.calendar.timezone, 'Asia/Shanghai');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start, '2024-09-02T08:00:00');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /VTIMEZONE/);
});

test('formatIcsDate：Date 与字符串两种输入', () => {
  assert.equal(formatIcsDate(new Date(2024, 8, 2, 8, 0, 0)), '20240902T080000');
  assert.equal(formatIcsDate(new Date(2024, 8, 2, 8, 0, 0), { allDay: true }), '20240902');
  assert.equal(formatIcsDate('2024-09-02T08:00'), '20240902T080000');
  assert.equal(formatIcsDate('2024-09-02', { allDay: true }), '20240902');
  assert.equal(formatIcsDate(new Date('invalid')), '');
});

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

test('escapeText / unescapeText 往返一致', () => {
  const samples = [
    '高等数学, 上',
    '分号;逗号,反斜杠\\',
    '第一行\n第二行',
    '带\n第二种换行',
    '',
    '普通文本',
    '\\n 不是换行',
    '英文 English & 数字 123',
  ];
  for (const sample of samples) {
    assert.equal(unescapeText(escapeText(sample)), sample, `往返失败：${JSON.stringify(sample)}`);
  }
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  assert.equal(unescapeText('a\\,b\\;c\\\\d\\ne'), 'a,b;c\\d\ne');
  // RFC5545 中换行只有一种表示：CRLF / CR / LF 都规整成 \n
  assert.equal(escapeText('甲\r\n乙'), '甲\\n乙');
  assert.equal(unescapeText(escapeText('甲\r\n乙')), '甲\n乙');
  assert.equal(escapeText(null), '');
  assert.equal(unescapeText(undefined), '');
});

// ---------------------------------------------------------------------------
// RRULE 展开
// ---------------------------------------------------------------------------

const WEEKLY_MO_WE = ics(
  'BEGIN:VEVENT',
  'UID:course-math@school.edu',
  'DTSTART;TZID=Asia/Shanghai:20240902T080000',
  'DTEND;TZID=Asia/Shanghai:20240902T094500',
  'SUMMARY:高等数学',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=16',
  'END:VEVENT',
);

test('WEEKLY BYDAY MO,WE + COUNT=16 展开为 16 次', () => {
  const event = onlyEvent(WEEKLY_MO_WE);
  assert.deepEqual(event.rrule, {
    freq: 'WEEKLY',
    interval: 1,
    count: 16,
    until: null,
    byday: ['MO', 'WE'],
    wkst: null,
  });
  const [rs, re] = rangeUtc('2024-08-31T00:00:00', '2024-12-31T23:59:59');
  const occ = expandRecurrence(event, rs, re);
  assert.equal(occ.length, 16);
  assert.deepEqual(
    occ.map((o) => o.occurrenceDate),
    [
      '2024-09-02', '2024-09-04',
      '2024-09-09', '2024-09-11',
      '2024-09-16', '2024-09-18',
      '2024-09-23', '2024-09-25',
      '2024-09-30', '2024-10-02',
      '2024-10-07', '2024-10-09',
      '2024-10-14', '2024-10-16',
      '2024-10-21', '2024-10-23',
    ],
  );
  assert.equal(occ[0].start, '2024-09-02T08:00:00');
  assert.equal(occ[0].end, '2024-09-02T09:45:00');
  assert.equal(occ[0].allDay, false);
  assert.equal(occ[0].isOverride, undefined);
});

test('INTERVAL=2 表示隔周', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:biweekly',
      'DTSTART;TZID=Asia/Shanghai:20240902T100000',
      'DTEND;TZID=Asia/Shanghai:20240902T115000',
      'SUMMARY:双周班会',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=4',
      'END:VEVENT',
    ),
  );
  assert.equal(event.rrule.interval, 2);
  const [rs, re] = rangeUtc('2024-08-31T00:00:00', '2024-12-31T23:59:59');
  assert.deepEqual(
    expandRecurrence(event, rs, re).map((o) => o.occurrenceDate),
    ['2024-09-02', '2024-09-16', '2024-09-30', '2024-10-14'],
  );
});

test('EXDATE（定时 + VALUE=DATE）排除生效，且被排除的实例仍占用 COUNT', () => {
  const timed = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:exdate-1',
      'DTSTART;TZID=Asia/Shanghai:20240902T080000',
      'DTEND;TZID=Asia/Shanghai:20240902T094500',
      'SUMMARY:体育',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5',
      'EXDATE;TZID=Asia/Shanghai:20240909T080000',
      'END:VEVENT',
    ),
  );
  assert.deepEqual(timed.exdates, ['2024-09-09']);
  const [rs, re] = rangeUtc('2024-08-31T00:00:00', '2024-12-31T23:59:59');
  assert.deepEqual(
    expandRecurrence(timed, rs, re).map((o) => o.occurrenceDate),
    ['2024-09-02', '2024-09-16', '2024-09-23', '2024-09-30'],
  );

  const allDay = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:exdate-2',
      'DTSTART;VALUE=DATE:20240902',
      'SUMMARY:晨读',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5',
      'EXDATE;VALUE=DATE:20240916',
      'END:VEVENT',
    ),
  );
  assert.deepEqual(allDay.exdates, ['2024-09-16']);
  const occ = expandRecurrence(allDay, rs, re);
  assert.equal(occ.length, 4);
  assert.ok(!occ.some((o) => o.occurrenceDate === '2024-09-16'));
  assert.equal(occ[0].allDay, true);
});

test('UNTIL（UTC 上界，含）限制展开', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:until-1',
      'DTSTART;TZID=Asia/Shanghai:20240903T080000',
      'DTEND;TZID=Asia/Shanghai:20240903T094500',
      'SUMMARY:英语',
      'RRULE:FREQ=WEEKLY;INTERVAL=1;UNTIL=20250110T235959Z;BYDAY=TU',
      'END:VEVENT',
    ),
  );
  // UNTIL 换算到 Asia/Shanghai 墙上时间为 2025-01-11T07:59:59
  assert.equal(event.rrule.until, '2025-01-11T07:59:59');
  const [rs, re] = rangeUtc('2024-08-31T00:00:00', '2025-06-30T23:59:59');
  const occ = expandRecurrence(event, rs, re);
  assert.equal(occ.length, 19);
  assert.equal(occ[occ.length - 1].occurrenceDate, '2025-01-07');
});

test('非重复事件：区间内 1 个结果，区间外 0 个', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:once',
      'DTSTART;TZID=Asia/Shanghai:20240902T080000',
      'DTEND;TZID=Asia/Shanghai:20240902T094500',
      'SUMMARY:讲座',
      'END:VEVENT',
    ),
  );
  const [rs, re] = rangeUtc('2024-09-02T00:00:00', '2024-09-02T23:59:59');
  const inside = expandRecurrence(event, rs, re);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].occurrenceDate, '2024-09-02');
  assert.equal(inside[0].start, '2024-09-02T08:00:00');

  const [rs2, re2] = rangeUtc('2024-09-03T00:00:00', '2024-09-03T23:59:59');
  assert.equal(expandRecurrence(event, rs2, re2).length, 0);
});

test('expandRecurrence：全天重复事件与 maxOccurrences 上限', () => {
  const event = onlyEvent(
    ics(
      'BEGIN:VEVENT',
      'UID:allday-recur',
      'DTSTART;VALUE=DATE:20241001',
      'SUMMARY:晨跑',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=100',
      'END:VEVENT',
    ),
  );
  const [rs, re] = rangeUtc('2024-09-30T00:00:00', '2025-12-31T23:59:59');
  const capped = expandRecurrence(event, rs, re, { maxOccurrences: 5 });
  assert.equal(capped.length, 5);
  assert.equal(capped[0].start, '2024-10-01');
  assert.equal(capped[0].end, '2024-10-01');
  assert.equal(capped[0].allDay, true);
  assert.equal(capped[1].occurrenceDate, '2024-10-08');
});

test('expandRecurrence：坏输入返回空数组而不抛异常', () => {
  const [rs, re] = rangeUtc('2024-09-01T00:00:00', '2024-09-30T23:59:59');
  assert.deepEqual(expandRecurrence(null, rs, re), []);
  assert.deepEqual(expandRecurrence({}, rs, re), []);
  assert.deepEqual(expandRecurrence({ start: '不是日期' }, rs, re), []);
  assert.deepEqual(expandRecurrence({ start: '2024-09-02T08:00:00', end: 'x' }, rs, re).length, 1);
});

// ---------------------------------------------------------------------------
// 生成与往返
// ---------------------------------------------------------------------------

test('generateICS：CRLF 行尾、折行不切多字节字符、可被 parseICS 还原', () => {
  const longSummary = '大学物理（含实验）第一学期每周一三五上午八点至九点四十五分于第三教学楼二零一教室'.repeat(
    3,
  );
  const text = generateICS({
    calendar: { name: '学习守护平台', timezone: 'Asia/Shanghai' },
    dtstamp: new Date('2024-09-01T00:00:00Z'),
    events: [
      {
        uid: 'course-1@study-guard.local',
        summary: longSummary,
        description: '第一行\n第二行',
        location: '教三-201',
        start: '2024-09-02T08:00',
        end: '2024-09-02T09:45',
        rrule: { freq: 'WEEKLY', byday: ['MO', 'WE'], count: 16 },
        categories: ['课程', '数学'],
      },
      {
        uid: 'holiday-1@study-guard.local',
        summary: '国庆假期',
        start: '2024-10-01',
        allDay: true,
      },
    ],
  });

  // 行尾与折行
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  const physical = text.split('\r\n');
  assert.ok(physical.length > 5);
  for (const line of physical) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行超过 75 字节：${line}`);
  }
  // 长摘要确实发生了折行（存在以空格开头的续行）
  assert.ok(physical.some((line) => line.startsWith(' ')));
  assert.ok(!text.includes('\uFFFD')); // 没有因为按字符切分产生的乱码
  assert.ok(text.includes('DTSTART;TZID=Asia/Shanghai:20240902T080000'));
  assert.ok(text.includes('RRULE:FREQ=WEEKLY;COUNT=16;BYDAY=MO,WE'));

  // 往返解析
  const { calendar, events, warnings } = parseICS(text);
  assert.equal(calendar.name, '学习守护平台');
  assert.equal(calendar.timezone, 'Asia/Shanghai');
  assert.equal(calendar.prodId, '-//学习守护平台//Study Guard Calendar 1.0//CN');
  assert.deepEqual(warnings, []);
  assert.equal(events.length, 2);

  assert.equal(events[0].summary, longSummary);
  assert.equal(events[0].description, '第一行\n第二行');
  assert.equal(events[0].location, '教三-201');
  assert.equal(events[0].start, '2024-09-02T08:00:00');
  assert.equal(events[0].end, '2024-09-02T09:45:00');
  assert.equal(events[0].timezone, 'Asia/Shanghai');
  assert.equal(events[0].rrule.freq, 'WEEKLY');
  assert.deepEqual(events[0].rrule.byday, ['MO', 'WE']);
  assert.equal(events[0].rrule.count, 16);
  assert.deepEqual(events[0].categories, ['课程', '数学']);
  assert.equal(events[0].allDay, false);

  assert.equal(events[1].summary, '国庆假期');
  assert.equal(events[1].allDay, true);
  assert.equal(events[1].start, '2024-10-01');
  assert.equal(events[1].end, '2024-10-01');

  // 往返后的展开结果与手写 ics 一致
  const [rs, re] = rangeUtc('2024-08-31T00:00:00', '2024-12-31T23:59:59');
  assert.equal(expandRecurrence(events[0], rs, re).length, 16);
});

test('generateICS：end 省略时的默认值', () => {
  const text = generateICS({
    dtstamp: new Date('2024-09-01T00:00:00Z'),
    events: [
      { uid: 'a', summary: '定时默认 1 小时', start: '2024-09-02T08:00' },
      { uid: 'b', summary: '全天默认当天', start: '2024-10-01', allDay: true },
    ],
  });
  assert.ok(text.includes('DTEND:20240902T090000'));
  assert.ok(text.includes('DTSTART;VALUE=DATE:20241001'));
  assert.ok(text.includes('DTEND;VALUE=DATE:20241002')); // 非包含结束日期
  const { events } = parseICS(text);
  assert.equal(events[0].end, '2024-09-02T09:00:00');
  assert.equal(events[1].end, '2024-10-01');
});

test('generateICS：VALARM 提醒使用 DISPLAY 与 -PT30M 形式', () => {
  const text = generateICS({
    calendar: { name: '学习守护平台', timezone: 'Asia/Shanghai' },
    dtstamp: new Date('2024-09-01T00:00:00Z'),
    events: [
      {
        uid: 'ddl-1@study-guard.local',
        summary: '交作业：算法实验二',
        start: '2024-09-10T23:00',
        end: '2024-09-10T23:59',
        alarms: [
          { triggerMinutesBefore: 30, description: '记得交作业' },
          { triggerMinutesBefore: 1440 },
        ],
      },
    ],
  });
  assert.ok(text.includes('BEGIN:VALARM'));
  assert.ok(text.includes('ACTION:DISPLAY'));
  assert.ok(text.includes('TRIGGER:-PT30M'));
  assert.ok(text.includes('TRIGGER:-PT1440M'));
  assert.ok(text.includes('DESCRIPTION:记得交作业'));
  // 提醒不应污染事件属性
  const result = parseICS(text);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].summary, '交作业：算法实验二');
  assert.equal(result.events[0].start, '2024-09-10T23:00:00');
  assert.ok(result.warnings.some((w) => w.includes('VALARM')));
});

test('generateICS：rrule 传字符串时原样输出', () => {
  const text = generateICS({
    events: [{ uid: 's', summary: '原样规则', start: '2024-09-02T08:00', rrule: 'FREQ=DAILY;INTERVAL=3;COUNT=5' }],
  });
  assert.ok(text.includes('RRULE:FREQ=DAILY;INTERVAL=3;COUNT=5'));
  const { events } = parseICS(text);
  assert.equal(events[0].rrule.freq, 'DAILY');
  assert.equal(events[0].rrule.interval, 3);
  assert.equal(events[0].rrule.count, 5);
});

test('generateICS：事件缺 start 时跳过而不抛异常', () => {
  const text = generateICS({ events: [{ summary: '没有时间' }, null, { start: '2024-09-02T08:00', summary: '正常' }] });
  const { events } = parseICS(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, '正常');
});

test('端到端：导入课表 -> 展开某天课程 -> 导出 DDL', () => {
  const school = ics(
    'X-WR-CALNAME:2024秋课表',
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VEVENT',
    'UID:c1',
    'DTSTART;TZID=Asia/Shanghai:20240902T080000',
    'DTEND;TZID=Asia/Shanghai:20240902T094500',
    'SUMMARY:高等数学',
    'LOCATION:教三-201',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=32',
    'EXDATE;TZID=Asia/Shanghai:20241002T080000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c2',
    'DTSTART;TZID=Asia/Shanghai:20240903T140000',
    'DTEND;TZID=Asia/Shanghai:20240903T154500',
    'SUMMARY:大学物理',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=16',
    'END:VEVENT',
  );
  const parsed = parseICS(school);
  assert.equal(parsed.calendar.name, '2024秋课表');
  assert.equal(parsed.events.length, 2);

  // 「今天有什么课」：2024-10-02 是周三，但被 EXDATE 排除
  const [rs, re] = rangeUtc('2024-10-01T16:00:00', '2024-10-02T16:00:00');
  const today = parsed.events.flatMap((e) => expandRecurrence(e, rs, re));
  assert.deepEqual(today.map((o) => o.occurrenceDate), []);
  assert.equal(today.length, 0);

  // 2024-10-07 是周一，有高等数学
  const [rs2, re2] = rangeUtc('2024-10-06T16:00:00', '2024-10-07T16:00:00');
  const monday = parsed.events.flatMap((e) => expandRecurrence(e, rs2, re2));
  assert.deepEqual(monday.map((o) => o.start), ['2024-10-07T08:00:00']);

  // 导出作业 DDL 并回读
  const exported = generateICS({
    calendar: { name: '学习守护平台-DDL', timezone: 'Asia/Shanghai' },
    dtstamp: new Date('2024-09-01T00:00:00Z'),
    events: [
      {
        uid: 'ddl-algo@study-guard.local',
        summary: '截止：算法实验二',
        description: '提交到教学平台',
        start: '2024-09-15T23:59',
        alarms: [{ triggerMinutesBefore: 60 }],
      },
    ],
  });
  const back = parseICS(exported);
  assert.equal(back.events[0].summary, '截止：算法实验二');
  assert.equal(back.events[0].start, '2024-09-15T23:59:00');
  assert.equal(back.events[0].end, '2024-09-16T00:59:00'); // 缺省 +1 小时
});
