/**
 * 「照着课表录入」：把表格拼成 CSV 的那一段。
 *
 * 这一批的路线是「上传 PDF → 看原图 → 照着填 → 拼成 CSV → 走现有的
 * 解析/预览/写库链路」。所以 CSV 这一层是**唯一的接缝**：
 *   · 列顺序或表头对不上 → 服务端认不出列名 → 不报错，只是"导入 0 门课程"
 *   · 转义漏了 → 课程名里的逗号把整行列数顶错位 → 字段串到别的列里去
 * 两种都是**静默错**，所以才要在这里钉死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appRaw = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');
const app = appRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { ENTRY_CSV_HEADER: SERVER_HEADER } = await import('../src/web/pages/import.js');
const { parseCourseCsv } = await import('../src/lib/import/csv.js');
const { DEFAULT_PERIOD_SCHEDULE } = await import('../src/lib/periods.js');

function fnSource(name) {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(app);
  assert.ok(m, `app.js 里应该有 ${name}()`);
  return m[0];
}
function loadFn(name, deps = {}) {
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${fnSource(name)}\nreturn ${name};`)(...names.map((n) => deps[n]));
}

const csvCell = loadFn('csvCell');
const entryRowsToCsv = loadFn('entryRowsToCsv', { csvCell });

/** 客户端那份表头（从源码里抠出来，不是抄一遍） */
function clientHeader() {
  const m = /const ENTRY_CSV_HEADER = '([^']+)'/.exec(app);
  assert.ok(m, 'app.js 里应该有 ENTRY_CSV_HEADER');
  return m[1];
}

// ============================================================
// 接缝：两边的表头必须一字不差
// ============================================================

describe('★ 客户端拼的 CSV 和服务端认的表头必须一致', () => {
  test('★ 两边表头完全相同', () => {
    // 对不上的后果是静默的：服务端 mapHeaders 匹配不上任何一列，
    // 于是返回「没能识别出表头」→ 用户看到导入 0 门课程，
    // 而错误信息指向的是"你的表格不对"，其实是代码两边不一致。
    assert.equal(clientHeader(), SERVER_HEADER,
      'app.js 的 ENTRY_CSV_HEADER 和 import.js 的 ENTRY_CSV_HEADER 不一致');
  });

  test('★ 拼出来的 CSV 真的能被服务端解析器认出来', () => {
    // 这是端到端的接缝测试：不 mock 任何东西，直接喂给真正的解析器。
    const csv = entryRowsToCsv([{
      name: '高等数学(上)', teacher: '张三', weekday: '星期一',
      periods: '1-2', weeks: '1-16', place: '之远楼301',
    }], SERVER_HEADER);

    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses.length, 1, `没解析出课程，warnings=${JSON.stringify(parsed.warnings)}`);
    const course = parsed.courses[0];
    assert.equal(course.name, '高等数学(上)');
    assert.equal(course.teacher, '张三');
    assert.equal(course.sessions.length, 1);
    assert.equal(course.sessions[0].weekday, 1);
    assert.equal(course.sessions[0].weeks, '1-16');
    assert.equal(course.sessions[0].location, '之远楼301');
  });

  test('★ 节次交给服务端换算，用的是那套作息表的时间', () => {
    // 客户端**不做**时间计算，只把 `5-7` 填进「上课时间」列。
    // 这样口径只可能有一处，不会出现"前端算出一套时间、后端算出另一套"。
    const csv = entryRowsToCsv([{
      name: '金融市场与金融机构_01', teacher: '孙艳霞', weekday: '星期一',
      periods: '5-7', weeks: '1-18', place: '之远楼716',
    }], SERVER_HEADER);
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    const s = parsed.courses[0]?.sessions?.[0];
    assert.ok(s, '没解析出上课时间');
    assert.equal(s.startTime, '13:30', '第 5 节的开始时间应该来自内置作息表');
    assert.equal(s.endTime, '16:10', '第 7 节的结束时间应该来自内置作息表');
    assert.equal(s.weekday, 1);
    assert.equal(s.location, '之远楼716');
    // ⚠️ 原始节次 `5-7` 这里**拿不到** —— 解析器内部的 parseTimeRange 会返回
    //    periods，但调用处只解构了 startTime/endTime，把它丢了。
    //    设计方案里想要的「预览时显示 第5-7节 → 13:30-15:25」因此实现不了。
    //    这条断言把现状钉住：等以后真做了这个透传，它会红，提醒把上面那条
    //    一起补上（而不是让一个已经实现的功能看起来"没测过"）。
    assert.equal(s.periods, undefined, '原始节次居然透传出来了 —— 说明这个缺口补上了，把这条断言改成断言它等于 5-7');
  });
});

// ============================================================
// 转义
// ============================================================

describe('★ CSV 转义（漏了会静默错列）', () => {
  test('普通值不加引号', () => {
    assert.equal(csvCell('高等数学'), '高等数学');
    assert.equal(csvCell(' 前后有空格 '), '前后有空格');
    assert.equal(csvCell(''), '');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  test('★ 值里有逗号时整体加引号（否则整行列数错位）', () => {
    assert.equal(csvCell('高等数学(上), 实验'), '"高等数学(上), 实验"');
    const csv = entryRowsToCsv([{
      name: '高等数学(上), 实验', teacher: '张三', weekday: '星期二',
      periods: '3-4', weeks: '1-8', place: 'A101',
    }], SERVER_HEADER);
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses[0]?.name, '高等数学(上), 实验',
      '逗号没转义 → 课程名被截断，后面的字段全串位');
  });

  test('★ 值里有引号时转成两个引号', () => {
    assert.equal(csvCell('之远楼"东"301'), '"之远楼""东""301"');
    const csv = entryRowsToCsv([{
      name: '体育', teacher: '', weekday: '星期三',
      periods: '5-6', weeks: '1-16', place: '体育馆"东"门',
    }], SERVER_HEADER);
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses[0]?.sessions?.[0]?.location, '体育馆"东"门');
  });

  test('值里有换行也不会把一行拆成两行', () => {
    assert.equal(csvCell('第一行\n第二行'), '"第一行\n第二行"');
  });
});

// ============================================================
// 行的取舍
// ============================================================

describe('★ 哪些行会被写进去', () => {
  const blank = { name: '', teacher: '', weekday: '', periods: '', weeks: '', place: '' };

  test('★ 课程名为空的行整行跳过（表格默认给 4 行空行）', () => {
    const csv = entryRowsToCsv([blank, blank, blank, blank], SERVER_HEADER);
    assert.equal(csv.split('\n').length, 1, '只应该剩表头');
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses.length, 0);
  });

  test('★ 只填了课程名也算一行，但不会因为少填别的列就崩', () => {
    const csv = entryRowsToCsv([{ ...blank, name: '形势与政策3_18' }], SERVER_HEADER);
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses.length, 1);
    assert.equal(parsed.courses[0].name, '形势与政策3_18');
  });

  test('★ 只有空白的课程名也算空行（不能靠打空格混过去）', () => {
    const csv = entryRowsToCsv([{ ...blank, name: '   ' }], SERVER_HEADER);
    assert.equal(csv.split('\n').length, 1);
  });

  test('学分列必须是空的（PDF 里没有学分，不猜）', () => {
    const csv = entryRowsToCsv([{ ...blank, name: '体育' }], SERVER_HEADER);
    const cols = csv.split('\n')[1].split(',');
    assert.equal(cols[2], '', '学分列应该是空的，猜一个数字会静默写进库里');
  });

  test('同一门课填两行（不同周次/地点）→ 两条 session，不被合并', () => {
    const csv = entryRowsToCsv([
      { name: '大数据计量与因果推断_01', teacher: '胡鑫', weekday: '星期五', periods: '8-9', weeks: '1,4-18', place: '之远楼402' },
      { name: '大数据计量与因果推断_01', teacher: '胡鑫', weekday: '星期五', periods: '8-9', weeks: '2-3', place: '之远楼802' },
    ], SERVER_HEADER);
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.equal(parsed.courses.length, 1, '同名课程应该聚合成一门');
    assert.equal(parsed.courses[0].sessions.length, 2, '两段不同周次/地点都要保留');
    const weeks = parsed.courses[0].sessions.map((s) => s.weeks).sort();
    assert.deepEqual(weeks, ['1,4-18', '2-3']);
  });

  test('多行多门课，顺序和条数都对', () => {
    const rows = [
      { name: 'A', teacher: 't1', weekday: '星期一', periods: '1-2', weeks: '1-16', place: 'p1' },
      { name: 'B', teacher: 't2', weekday: '星期三', periods: '3-4', weeks: '1-16', place: 'p2' },
      { name: 'C', teacher: 't3', weekday: '星期五', periods: '5-6', weeks: '1-16', place: 'p3' },
    ];
    const csv = entryRowsToCsv(rows, SERVER_HEADER);
    assert.equal(csv.split('\n').length, 4, '表头 + 3 行');
    const parsed = parseCourseCsv(csv, { periods: DEFAULT_PERIOD_SCHEDULE });
    assert.deepEqual(parsed.courses.map((c) => c.name), ['A', 'B', 'C']);
  });
});

// ============================================================
// 界面接线
// ============================================================

describe('★ 接线（写好了得真接上）', () => {
  test('★ initManualImport 被 boot() 调用了', () => {
    const bootBody = /function boot\(\)\s*\{([\s\S]*?)\n\}/.exec(app)?.[1] || '';
    assert.match(bootBody, /initManualImport\(\)/, 'boot() 里没有调用它，表格就是死的');
  });

  test('★ 提交前把 CSV 写进隐藏字段（不然服务端收到空内容）', () => {
    const src = fnSource('initManualImport');
    assert.match(src, /querySelector\('\[name=text\]'\)\.value/, '没有把拼好的 CSV 塞回去');
  });

  test('★ 一门课都没填时挡住提交，并把错误挂在第一行的课程名上', () => {
    const src = fnSource('initManualImport');
    assert.match(src, /e\.preventDefault\(\)/, '不挡住的话会带着空内容提交，用户白等一圈');
    assert.match(src, /setFieldError\(first,/, '应该用字段级错误，而不是一个会飘走的 toast');
  });

  test('★ 删到最后一行时清空而不是删掉它（表格不能变成空的）', () => {
    const src = fnSource('initManualImport');
    assert.match(src, /rows\.length <= 1/);
    assert.match(src, /input\.value = ''/, '最后一行应该是清空内容，不是删掉');
  });

  test('★ 加行之后把光标送过去（省得用户再点一下）', () => {
    assert.match(fnSource('initManualImport'), /row\.querySelector\('input'\)\?\.focus\(\)/);
  });
});
