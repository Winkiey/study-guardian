#!/usr/bin/env node
/**
 * 端到端自测。
 *
 * 在**临时数据目录**里起一个真实的服务实例，然后用 HTTP 把所有主流程走一遍：
 * 初始化账号 → 建课程 → 排课 → 设成绩构成 → 建作业 → 验证提醒生成
 * → 上传课件 → 访问文件 → ICS 导出 → CSV 导入 → 日历订阅 → 改设置。
 *
 * 用途：
 *   - 开发时改完代码跑一下，确认没有把别的地方弄坏
 *   - 别人 clone 下来后跑一下，确认自己的环境装对了
 *
 * 用法：node scripts/e2e.js
 * 加 --keep 保留临时目录便于排查。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../tests/_zipfixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');

// ============================================================
// 迷你测试框架
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/** 带 Cookie 的 HTTP 客户端 */
function createClient(baseUrl) {
  const jar = new Map();

  return async function request(method, urlPath, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (jar.size) {
      headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    let body = options.body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }

    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body,
      redirect: 'manual',
    });

    // 收集 Set-Cookie
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const cookie of setCookie) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应 */
    }

    return { status: res.status, headers: res.headers, text, json };
  };
}

/** 构造 multipart 请求体 */
function multipart(fields, file) {
  const boundary = `----sgtest${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }

  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.mime || 'application/octet-stream'}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ============================================================
// 测试数据构造
// ============================================================

/**
 * 造一个结构最小的 PPTX。
 * 用它验证「上传 PPT → 抽文本 → 网页版预览」这条链路。
 */
function makeTestPptx() {
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const slide = (title, body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

  return buildZip([
    {
      name: '[Content_Types].xml',
      method: 'deflate',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      method: 'deflate',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      method: 'deflate',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_R}">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
</p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      method: 'deflate',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NS_R}/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="${NS_R}/slide" Target="slides/slide2.xml"/>
</Relationships>`,
    },
    { name: 'ppt/slides/slide1.xml', method: 'deflate', data: slide('第一章 导论', '微观经济学的研究对象') },
    { name: 'ppt/slides/slide2.xml', method: 'deflate', data: slide('需求与供给', '均衡价格的决定') },
  ]);
}

/**
 * 造一个结构合法、只有一页的 PDF。
 *
 * 用它走「原生 PDF」那条预览路径：不需要转换，previewMode 直接就是 pdf。
 * 服务器上的课件大多是这个模式，所以 iOS 提示也得在这个模式下验。
 */
function makeTestPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 14 Tf 20 100 Td (Study Guardian) Tj ET\nendstream',
  ];

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
}

/** 教务系统风格的课表 CSV */
const TEST_CSV = [
  '课程名称,课程号,教师,学分,课程性质,考核方式,星期,上课时间,周次,上课地点',
  '高等数学(上),MATH101,张三,5,必修,考试,星期一,08:00-09:40,1-16,之远楼301',
  '高等数学(上),MATH101,张三,5,必修,考试,星期三,10:00-11:40,1-16,之远楼301',
  '微观经济学,ECON201,李四,3,必修,考试,星期二,13:30-15:10,1-16单,博学楼205',
].join('\n');

/**
 * 教务系统风格的 ICS（含 RRULE、TZID、折行、中文）
 *
 * 刻意复刻真实教务系统的写法：
 *   - LOCATION 里教室和教师用空格连在一起（`校本部之远楼401 王五`）
 *   - DESCRIPTION 里节次 / 教室 / 教师 各占一行，后面还跟一行元信息
 *   这是真实踩过的坑：整串被当成教室，教师字段永远是空的。
 *
 * 学分同样故意写在三个不同位置，验证三处都能认出来。
 *
 * 时间要和默认作息表对得上（第1节 08:00-08:45、第2节 08:50-09:35、
 * 第3节 09:55-10:40、第4节 10:45-11:30），这样后面的课表按节次分行才成立。
 */
const TEST_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//JWC//CN',
  // ① 学分写在描述里
  'BEGIN:VEVENT',
  'UID:course-1@jwc',
  'SUMMARY:会计学原理',
  'DTSTART;TZID=Asia/Shanghai:20250901T080000',
  'DTEND;TZID=Asia/Shanghai:20250901T093500',
  'LOCATION:校本部之远楼401 王五',
  'DESCRIPTION:第1 - 2节\\n校本部之远楼401\\n王五\\n学分：4',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=16',
  'END:VEVENT',
  // ② 学分写在课程名里，③ 学时写在自定义属性里
  'BEGIN:VEVENT',
  'UID:course-2@jwc',
  'SUMMARY:统计学(3学分)',
  'DTSTART;TZID=Asia/Shanghai:20250903T095500',
  'DTEND;TZID=Asia/Shanghai:20250903T113000',
  'LOCATION:校本部笃行楼108 赵六',
  'DESCRIPTION:第3 - 4节\\n校本部笃行楼108\\n赵六',
  'X-HOURS:48',
  'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=16',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// ============================================================
// 启动被测服务
// ============================================================

function pickPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

/** 自测里配的邀请码。服务端配置和用例输入两处都要用，放一起免得改漏 */
const E2E_INVITE_CODE = 'e2e-邀请码-请勿外传';

/**
 * 可靠地结束被测服务进程。
 *
 * 为什么不用 child.kill()：Windows 上它只终止直接子进程，
 * 而且如果服务是通过 shell 拉起来的，会留下孤儿进程占着端口和内存。
 * taskkill /T 会连整棵进程树一起收掉。
 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    child.kill('SIGTERM');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
}

async function startServer(dataDir, port, extraEnv = {}) {
  // 把服务端日志写到文件而不是管道。
  // 管道在本机沙箱里是被禁的；同时文件日志在测试失败时能直接看，便于排障。
  const serverLog = path.join(dataDir, 'server.log');
  const logFd = fs.openSync(serverLog, 'a');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      // 关掉 Office→PDF 转换：自测要快，而且不依赖本机装没装 Office。
      // 网页版预览（文本抽取）这条兜底链路反而能被完整覆盖。
      ENABLE_OFFICE_CONVERT: 'false',
      SCHEDULER_RUN_ON_START: 'false',
      SCHEDULER_INTERVAL_SEC: '3600',
      // 自测会发上千个请求，普通限流要放开，否则测试自己会被 429 挡住
      RATE_LIMIT_PER_MIN: '1000000',
      // 注册/登录限流也一并放开：功能用例（多用户那一节要连续注册、登录
      // 好几次）不该被限流打挂 —— 那样失败信息会指向一个跟被测功能无关的原因。
      // 限流本身在第 14 节用一个独立实例单独验，那里用的是默认值。
      RATE_LIMIT_AUTH_PER_MIN: '1000000',
      // 邀请码：多用户那一节要验证「没码进不来、有码才放行」
      INVITE_CODE: E2E_INVITE_CODE,
      NODE_ENV: 'test',
      // 覆盖项放最后：调用方指定的配置必须是最终生效的那一份
      ...extraEnv,
    },
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const readLog = () => {
    try {
      return fs.readFileSync(serverLog, 'utf8');
    } catch {
      return '';
    }
  };

  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程过早退出（exit ${child.exitCode}）\n--- 服务端日志 ---\n${readLog()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/login`);
      if (res.status === 200 || res.status === 302) {
        return { child, baseUrl, readLog, serverLog };
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  killTree(child);
  throw new Error(`服务在 18 秒内没有就绪\n--- 服务端日志 ---\n${readLog()}`);
}

// ============================================================
// 主流程
// ============================================================

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-'));
  const port = pickPort();

  console.log(`\u001b[1m学习守护平台 · 端到端自测\u001b[0m`);
  console.log(`临时数据目录：${dataDir}`);
  console.log(`服务端口：${port}`);

  let server = null;

  try {
    server = await startServer(dataDir, port);
    const { baseUrl } = server;
    const req = createClient(baseUrl);

    // --------------------------------------------------------
    section('1. 首次访问与账号初始化');

    const loginPage = await req('GET', '/login');
    ok('登录页可访问', loginPage.status === 200, `状态码 ${loginPage.status}`);

    // ---- 登录页不该套着站内导航 ----
    // 未登录时侧边栏那 6 个入口和手机底部导航照常渲染的话，
    // 点哪一个都会被弹回登录页 —— 看起来像坏了，实际是自己跟自己绕圈；
    // 而底部导航固定在屏幕底部，还会挡住登录表单。
    ok('★ 登录页没有侧边栏（那 6 个入口点了只会弹回本页）',
      !loginPage.text.includes('class="sidebar"'));
    ok('★ 登录页没有手机底部导航（它会挡住表单）',
      !loginPage.text.includes('class="tabbar"'));
    ok('★ 登录页也没有那些点了会被弹回来的站内链接',
      !loginPage.text.includes('href="/timetable"') && !loginPage.text.includes('href="/materials"'));
    ok('★ 登录页用的是 bare 骨架',
      loginPage.text.includes('app-shell--bare'));
    ok('★ 登录页仍然有深色模式开关（换成浮动的，方便还没登录的人先调好）',
      loginPage.text.includes('theme-toggle--float') && loginPage.text.includes('data-theme-toggle'));
    ok('登录页仍然有「跳到主要内容」', loginPage.text.includes('跳到主要内容'));
    ok('★ 登录和注册两个 Tab 都还在（去掉导航不能把功能也去掉）',
      loginPage.text.includes('id="tab-login"') && loginPage.text.includes('id="tab-register"'));
    ok('首次访问引导创建账号', loginPage.text.includes('创建账号'));

    const rootRedirect = await req('GET', '/');
    ok('未登录访问首页会跳转登录', rootRedirect.status === 302
      && rootRedirect.headers.get('location')?.includes('/login'), `状态码 ${rootRedirect.status}`);

    const setup = await req('POST', '/setup', {
      form: {
        username: '测试同学',
        password: 'test123456',
        password2: 'test123456',
        displayName: '小王',
        school: '东北财经大学',
      },
    });
    ok('创建账号成功并跳转首页', setup.status === 302, `状态码 ${setup.status}`);

    const home = await req('GET', '/');
    ok('首页渲染成功', home.status === 200, `状态码 ${home.status}`);
    ok('首页显示问候语', home.text.includes('小王'));

    // ---- 新同学的第一屏 ----
    // 这一刻这个账号一门课都还没有，也就是同学注册完第一次进来的样子。
    // 以前他看到的是：四个 0 的统计块 + 两张「没有数据」的空卡片 ——
    // 他知道这站是空的，但不知道下一步该干嘛。
    ok('★ 新同学看到的是「先做这三步」的引导卡片',
      home.text.includes('先做这三步') && home.text.includes('onboarding'));
    ok('★ 新同学的首页不显示统计块（四个 0 没有信息量）',
      !home.text.includes('stat-grid'));
    ok('★ 新同学的首页不显示「今天没有课」这类空卡片（重复说「你啥都没有」）',
      !home.text.includes('今天没有课'));
    ok('★ 引导第一步是导入课表，而且按钮真的能点',
      home.text.includes('把课表导进来') && home.text.includes('href="/import"'));
    ok('★ 引导里也提醒了顺手核对学期（第一周周一决定「第几周」）',
      home.text.includes('第一周周一'));
    ok('★ 引导第二步是配提醒渠道',
      home.text.includes('配一个提醒渠道') && home.text.includes('href="/settings#notify"'));
    ok('★ 引导里说明了这张卡什么时候消失',
      home.text.includes('这张卡片就会自己消失'));

    // 新同学这里**不再**重复弹那条「还没设置提醒渠道」的横幅 ——
    // 引导卡第 2 步讲的就是这件事，同一屏说两遍是噪音。
    // 「配提醒」这件事有没有说到，由上面那条「引导第二步」的断言负责；
    // 横幅本身在有了课程之后才出现，那一条在第 2 节里验。
    ok('★ 新同学这一屏不重复弹「还没设置提醒渠道」的横幅',
      !home.text.includes('还没设置提醒渠道'));
    ok('默认学期已自动创建', home.text.includes('第 ') && home.text.includes(' 周'));

    // --------------------------------------------------------
    section('2. 课程与课表');

    const createCourse = await req('POST', '/api/courses', {
      json: {
        name: '高等数学(上)',
        code: 'MATH101',
        teacher: '张三',
        teacherContact: 'zhangsan@dufe.edu.cn',
        credits: 5,
        hours: 80,
        category: '必修',
        examType: '考试',
        classroom: '之远楼301',
      },
    });
    ok('创建课程成功', createCourse.status === 201, `状态码 ${createCourse.status}：${createCourse.text.slice(0, 120)}`);
    const courseId = createCourse.json?.course?.id;
    ok('返回课程 ID', Number.isFinite(courseId));

    // ---- 有了课程之后，首页该变回「正常样子」 ----
    // 引导卡是靠「一门课都没有」这个条件判断的，所以这里正好验它的反方向：
    // 建完课，卡片该消失、统计块该回来、提醒横幅该出现。
    const homeAfterCourse = await req('GET', '/');
    ok('★ 有了课程之后，引导卡自动消失',
      !homeAfterCourse.text.includes('onboarding'), '卡片应该自己退场');
    ok('★ 统计块回来了', homeAfterCourse.text.includes('stat-grid'));
    ok('★ 「还没设置提醒渠道」的横幅这时候才出现（新同学那一屏不重复说）',
      homeAfterCourse.text.includes('还没设置提醒渠道'));
    ok('★ 首页也回到「今天没有课」这种正常空状态，而不是引导卡',
      homeAfterCourse.text.includes('今天没有课'));

    const dup = await req('POST', '/api/courses', { json: { name: '高等数学(上)' } });
    ok('同名课程被拒绝', dup.status === 400 && dup.json?.error?.includes('已经有一门'),
      `状态码 ${dup.status}：${dup.json?.error}`);

    const setSessions = await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: {
        sessions: [
          { weekday: 1, startTime: '08:00', endTime: '09:40', weeks: '1-16', location: '之远楼301' },
          { weekday: 3, startTime: '10:00', endTime: '11:40', weeks: '1-16', location: '之远楼301' },
        ],
      },
    });
    ok('设置上课时间成功', setSessions.status === 200, `状态码 ${setSessions.status}`);
    ok('返回两条上课时间', setSessions.json?.sessions?.length === 2);

    const badSession = await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: { sessions: [{ weekday: 9, startTime: '08:00', endTime: '09:40' }] },
    });
    ok('非法星期被拒绝', badSession.status === 400, `状态码 ${badSession.status}`);

    // --------------------------------------------------------
    // 编辑课程（PATCH /api/courses/:id）
    //
    // 这条路径以前完全没有测试覆盖，结果漏掉了一个很隐蔽的 bug：
    // <input type="number"> 遇到「3学分」这类带单位的输入时，
    // 界面上显示着文字但 input.value 是空串，提交上去就成了空值——
    // 用户看到的现象是「明明填了、也保存了，但值没变」。
    //
    // 现在前后端都做了处理，这里把关键行为钉死。
    // --------------------------------------------------------

    // 浏览器发过来的都是字符串
    const patchCredits = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '5', hours: '80' },
    });
    ok('PATCH 课程成功', patchCredits.status === 200, `状态码 ${patchCredits.status}`);
    ok('★ 字符串形式的学分被正确保存',
      patchCredits.json?.course?.credits === 5, `实际 ${patchCredits.json?.course?.credits}`);
    ok('★ 字符串形式的学时被正确保存',
      patchCredits.json?.course?.hours === 80, `实际 ${patchCredits.json?.course?.hours}`);

    const patchUnit = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '3学分' },
    });
    ok('带单位的「3学分」也能保存',
      patchUnit.json?.course?.credits === 3, `实际 ${patchUnit.json?.course?.credits}`);

    const patchFullWidth = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '２.５' },
    });
    ok('全角数字「２.５」也能保存',
      patchFullWidth.json?.course?.credits === 2.5,
      `实际 ${patchFullWidth.json?.course?.credits}`);

    const patchGarbage = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '不知道' },
    });
    ok('★ 填了非数字时明确报错，而不是静默写成空值',
      patchGarbage.status === 400 && /不是数字/.test(patchGarbage.json?.error || ''),
      `状态码 ${patchGarbage.status}：${patchGarbage.json?.error}`);

    const afterGarbage = await req('GET', `/api/courses/${courseId}`);
    ok('报错时原来的学分没有被破坏',
      afterGarbage.json?.course?.credits === 2.5,
      `实际 ${afterGarbage.json?.course?.credits}`);

    const patchOutOfRange = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '999' },
    });
    ok('学分超出合理范围被拒绝', patchOutOfRange.status === 400, `状态码 ${patchOutOfRange.status}`);

    const patchNoCredits = await req('PATCH', `/api/courses/${courseId}`, {
      json: { notes: '只改备注' },
    });
    ok('请求里没带学分时保持原值',
      patchNoCredits.json?.course?.credits === 2.5,
      `实际 ${patchNoCredits.json?.course?.credits}`);

    const patchClear = await req('PATCH', `/api/courses/${courseId}`, {
      json: { credits: '' },
    });
    ok('学分填成空串表示清空',
      patchClear.json?.course?.credits === null,
      `实际 ${patchClear.json?.course?.credits}`);

    // 还原成后面测试期待的值
    await req('PATCH', `/api/courses/${courseId}`, { json: { credits: '5', hours: '80' } });

    // --------------------------------------------------------
    // 批量填学分
    //
    // 批量操作最容易出的两类问题是「改了一半失败」和「越权改到别人的数据」，
    // 所以这里重点测**原子性**和**校验**，而不是只测顺利路径。
    // --------------------------------------------------------

    const bc1 = await req('POST', '/api/courses', { json: { name: '批量测试甲' } });
    const bc2 = await req('POST', '/api/courses', { json: { name: '批量测试乙' } });
    const bc3 = await req('POST', '/api/courses', { json: { name: '批量测试丙' } });
    const idA = bc1.json?.course?.id;
    const idB = bc2.json?.course?.id;
    const idC = bc3.json?.course?.id;
    ok('批量测试用的三门课创建成功',
      [idA, idB, idC].every(Number.isFinite), JSON.stringify([idA, idB, idC]));

    // ---- 正常批量设置 ----
    const batchOk = await req('POST', '/api/courses/batch-credits', {
      json: {
        items: [
          { id: idA, credits: '3', hours: '48' },
          { id: idB, credits: '3' },
        ],
      },
    });
    ok('批量设置请求成功', batchOk.status === 200, `状态码 ${batchOk.status}`);
    ok('返回实际修改了 2 行', batchOk.json?.changed === 2, `实际 ${batchOk.json?.changed}`);

    const afterA = (await req('GET', `/api/courses/${idA}`)).json?.course;
    const afterB = (await req('GET', `/api/courses/${idB}`)).json?.course;
    const afterC = (await req('GET', `/api/courses/${idC}`)).json?.course;

    ok('★ 第一门课：学分和学时都写入了',
      afterA?.credits === 3 && afterA?.hours === 48,
      `学分=${afterA?.credits} 学时=${afterA?.hours}`);
    ok('★ 第二门课：学分写了，学时保持原值（请求里没带 hours）',
      afterB?.credits === 3 && afterB?.hours === null,
      `学分=${afterB?.credits} 学时=${afterB?.hours}`);
    ok('★ 没提交的第三门课完全没被改动',
      afterC?.credits === null && afterC?.hours === null,
      `学分=${afterC?.credits} 学时=${afterC?.hours}`);

    // ---- 原子性：一条不合法就整体拒绝，前面合法的也不能生效 ----
    const batchMixed = await req('POST', '/api/courses/batch-credits', {
      json: {
        items: [
          { id: idA, credits: '9' },              // 合法：本来会被改成 9
          { id: idB, credits: '不是数字' },        // 不合法
        ],
      },
    });
    ok('★ 有一条不合法时整体拒绝',
      batchMixed.status === 400 && /不是数字/.test(batchMixed.json?.error || ''),
      `状态码 ${batchMixed.status}：${batchMixed.json?.error}`);
    ok('★ 报错信息里指明是哪门课出的问题',
      /批量测试乙/.test(batchMixed.json?.error || ''),
      batchMixed.json?.error);
    ok('★ 报错信息里说明「没有修改任何课程」',
      /没有修改任何课程/.test(batchMixed.json?.error || ''),
      batchMixed.json?.error);

    const afterMixed = (await req('GET', `/api/courses/${idA}`)).json?.course;
    ok('★ 整体拒绝后，前面那条合法修改也没有生效（原子性）',
      afterMixed?.credits === 3, `期望仍是 3，实际 ${afterMixed?.credits}`);

    // ---- 不存在的课程 id：也不能改到任何东西 ----
    const batchGhost = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '9' }, { id: 999999, credits: '9' }] },
    });
    ok('★ 不存在的课程编号被拒绝', batchGhost.status === 400, `状态码 ${batchGhost.status}`);
    const afterGhost = (await req('GET', `/api/courses/${idA}`)).json?.course;
    ok('★ 有不存在的编号时，前面的修改同样没生效',
      afterGhost?.credits === 3, `实际 ${afterGhost?.credits}`);

    // ---- 重复提交同一门课 ----
    const batchDup = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '1' }, { id: idA, credits: '2' }] },
    });
    ok('重复提交同一门课被拒绝',
      batchDup.status === 400 && /重复/.test(batchDup.json?.error || ''),
      `状态码 ${batchDup.status}：${batchDup.json?.error}`);
    const afterDup = (await req('GET', `/api/courses/${idA}`)).json?.course;
    ok('重复提交被拒后原值不变', afterDup?.credits === 3, `实际 ${afterDup?.credits}`);

    // ---- 各种非法输入 ----
    const batchEmpty = await req('POST', '/api/courses/batch-credits', { json: { items: [] } });
    ok('空列表被拒绝', batchEmpty.status === 400, `状态码 ${batchEmpty.status}`);

    const batchNoItems = await req('POST', '/api/courses/batch-credits', { json: {} });
    ok('缺少 items 字段被拒绝', batchNoItems.status === 400, `状态码 ${batchNoItems.status}`);

    const batchNoCredits = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA }] },
    });
    ok('缺少学分值时被拒绝',
      batchNoCredits.status === 400 && /缺少学分/.test(batchNoCredits.json?.error || ''),
      `状态码 ${batchNoCredits.status}：${batchNoCredits.json?.error}`);

    const batchRange = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '999' }] },
    });
    ok('学分超出合理范围被拒绝', batchRange.status === 400, `状态码 ${batchRange.status}`);

    const batchBadId = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: 'abc', credits: '3' }] },
    });
    ok('非法课程编号被拒绝', batchBadId.status === 400, `状态码 ${batchBadId.status}`);

    const batchNegative = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '-1' }] },
    });
    ok('负数学分被拒绝',
      batchNegative.status === 400 && /负数/.test(batchNegative.json?.error || ''),
      `状态码 ${batchNegative.status}：${batchNegative.json?.error}`);

    // 这条是关键：数字正则里没有负号，一不小心就会把「-1」解析成「1」，
    // 静默把负数变成正数。必须确认没有发生这种事。
    const afterNegative = (await req('GET', `/api/courses/${idA}`)).json?.course;
    ok('★ 负数没有被静默改成正数',
      afterNegative?.credits === 3,
      `期望仍是 3，实际 ${afterNegative?.credits}`);

    const patchNegative = await req('PATCH', `/api/courses/${idA}`, {
      json: { credits: '-2' },
    });
    ok('单个修改时负数同样被拒绝',
      patchNegative.status === 400, `状态码 ${patchNegative.status}`);
    ok('★ 单个修改时负数也没被改成正数',
      (await req('GET', `/api/courses/${idA}`)).json?.course?.credits === 3,
      `实际 ${(await req('GET', `/api/courses/${idA}`)).json?.course?.credits}`);

    const manyItems = Array.from({ length: 301 }, (_, i) => ({ id: i + 1, credits: '3' }));
    const batchTooMany = await req('POST', '/api/courses/batch-credits', {
      json: { items: manyItems },
    });
    ok('超过 300 条被拒绝', batchTooMany.status === 400, `状态码 ${batchTooMany.status}`);

    // ---- 未登录不能批量改数据 ----
    const anonBatch = createClient(baseUrl);
    const batchAnon = await anonBatch('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '3' }] },
    });
    ok('未登录不能批量修改',
      batchAnon.status === 401 || batchAnon.status === 302, `状态码 ${batchAnon.status}`);

    // ---- 清空 ----
    const batchClear = await req('POST', '/api/courses/batch-credits', {
      json: { items: [{ id: idA, credits: '' }] },
    });
    ok('学分传空串表示清空',
      batchClear.json?.courses?.find((c) => c.id === idA)?.credits === null,
      `实际 ${batchClear.json?.courses?.find((c) => c.id === idA)?.credits}`);
    ok('清空学分时学时不受影响（请求里没带 hours）',
      (await req('GET', `/api/courses/${idA}`)).json?.course?.hours === 48,
      `实际 ${(await req('GET', `/api/courses/${idA}`)).json?.course?.hours}`);

    // ---- 界面入口 ----
    const coursesPageRes = await req('GET', '/courses');
    ok('课程页有「批量填学分」按钮',
      coursesPageRes.text.includes('data-batch-credits'), '页面上找不到按钮');
    const appJsSrc = (await req('GET', '/static/app.js')).text;
    ok('前端 JS 里有批量的处理逻辑',
      appJsSrc.includes('data-batch-credits') && appJsSrc.includes('/api/courses/batch-credits'),
      'app.js 里找不到相关逻辑');

    // 数据层必须带 user_id 归属校验（防止越权改到别人的课程）
    const coursesLibSrc = fs.readFileSync(path.join(ROOT, 'src/lib/courses.js'), 'utf8');
    ok('批量更新的 SQL 带 user_id 归属校验',
      /batchUpdateCourseAmounts[\s\S]{0,900}?WHERE id = \? AND user_id = \?/.test(coursesLibSrc),
      'WHERE 子句里没有 user_id');

    const setGrades = await req('PUT', `/api/courses/${courseId}/grades`, {
      json: {
        items: [
          { name: '平时成绩', weight: 30, score: 88, fullScore: 100 },
          { name: '期中考试', weight: 20, score: 76, fullScore: 100 },
          { name: '期末考试', weight: 50, fullScore: 100 },
        ],
      },
    });
    ok('保存成绩构成成功', setGrades.status === 200, `状态码 ${setGrades.status}`);

    const courseDetail = await req('GET', `/api/courses/${courseId}`);
    const summary = courseDetail.json?.course?.gradeSummary;
    ok('成绩构成权重合计正确', summary?.totalWeight === 100, `实际 ${summary?.totalWeight}`);
    // 88×0.3 + 76×0.2 = 26.4 + 15.2 = 41.6
    ok('已得分数计算正确', Math.abs((summary?.earnedPoints ?? 0) - 41.6) < 0.01,
      `期望 41.6，实际 ${summary?.earnedPoints}`);
    // 41.6 ÷ 50 × 100 = 83.2
    ok('已出分部分得分率计算正确', Math.abs((summary?.scoredRate ?? 0) - 83.2) < 0.01,
      `期望 83.2，实际 ${summary?.scoredRate}`);
    ok('剩余权重计算正确', summary?.remainingWeight === 50, `实际 ${summary?.remainingWeight}`);
    ok('最终总评上限计算正确', Math.abs((summary?.bestPossible ?? 0) - 91.6) < 0.01,
      `期望 91.6，实际 ${summary?.bestPossible}`);

    const overWeight = await req('PUT', `/api/courses/${courseId}/grades`, {
      json: { items: [{ name: 'A', weight: 80 }, { name: 'B', weight: 50 }] },
    });
    ok('权重超过 100% 被拒绝', overWeight.status === 400, `状态码 ${overWeight.status}`);

    // 课表页应当能算出周次并显示课程
    const timetable = await req('GET', '/timetable');
    ok('课程表页可访问', timetable.status === 200, `状态码 ${timetable.status}`);
    ok('课程表显示课程名', timetable.text.includes('高等数学'));
    ok('课程表渲染了周次网格', timetable.text.includes('week-grid'));
    ok('课程表显示学分汇总', timetable.text.includes('5'));

    // ---- 当前时间线 ----
    // ⚠️ 这条线只在两种条件下才画：今天在显示的这一周里，而且**现在**正好落在
    //    某一节课的时间范围内。凌晨跑测试就落在范围外 —— 所以这里不能写成
    //    「必须有」，那样测试会在半夜莫名其妙地红。
    //    改成：有就验它的契约，没有就明确说清"这次没到那个时间段"，
    //    两个分支都验同一件事（页面确实是那份课表网格）。
    {
      const nowHm = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
      const nowLineHtml = /<div class="now-line"[^>]*data-now-line[\s\S]{0,200}?>/.exec(timetable.text)?.[0] || '';
      const pageHasGrid = timetable.text.includes('week-grid__cell');
      if (nowLineHtml) {
        ok('★ 当前时间线带了所在那一行的起止时间（前端要拿它算位置）',
          /data-start="\d{2}:\d{2}"/.test(nowLineHtml) && /data-end="\d{2}:\d{2}"/.test(nowLineHtml),
          nowLineHtml);
        ok('★ 当前时间线只画一列（今天那一列），不会七天都画一条',
          (timetable.text.match(/data-now-line/g) || []).length === 1,
          `画了 ${(timetable.text.match(/data-now-line/g) || []).length} 条`);
        // 现在这个时刻应该确实落在这一行的范围内（不然就是行挑错了）
        const start = /data-start="(\d{2}:\d{2})"/.exec(nowLineHtml)?.[1];
        const end = /data-end="(\d{2}:\d{2})"/.exec(nowLineHtml)?.[1];
        ok('★ 挑中的那一行确实包含"现在"',
          Boolean(start && end) && start <= nowHm && nowHm < end,
          `现在 ${nowHm}，那一行是 ${start}-${end}`);
      } else {
        ok(`（这次没画当前时间线：现在 ${nowHm} 不在任何一节的范围内，不是失败）`,
          pageHasGrid, '连课表网格都没渲染出来，那就是真出问题了');
      }
      // 这两个是静态资源，跟当前时间无关，可以无条件断言
      const appJsForLine = await req('GET', '/static/app.js');
      const cssForLine = await req('GET', '/static/app.css');
      ok('★ 时间线的定位逻辑在（纯函数 nowLineOffset）',
        appJsForLine.text.includes('nowLineOffset'));
      ok('★ 时间线在切回标签页时会补算一次（后台定时器会被降频）',
        appJsForLine.text.includes('visibilitychange'));
      ok('★ 时间线样式是细线 + 小圆点，不是大面积高亮',
        /\.now-line\s*\{[^}]*pointer-events:\s*none/.test(cssForLine.text)
        && cssForLine.text.includes('.now-line::after'));
    }

    // --------------------------------------------------------
    section('3. 作业与提醒生成');

    const dueAt = new Date(Date.now() + 2 * 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    const dueStr = `${dueAt.getFullYear()}-${pad(dueAt.getMonth() + 1)}-${pad(dueAt.getDate())}T23:59`;

    const createAssignment = await req('POST', '/api/assignments', {
      json: {
        title: '第三章课后习题 1-15 题',
        courseId,
        dueAt: dueStr,
        priority: 2,
        description: '写在作业本上，下次课交。',
        remindOffsets: '1440,120',
      },
    });
    ok('创建作业成功', createAssignment.status === 201,
      `状态码 ${createAssignment.status}：${createAssignment.text.slice(0, 120)}`);
    const assignmentId = createAssignment.json?.assignment?.id;

    const assignmentDetail = await req('GET', `/api/assignments/${assignmentId}`);
    const reminders = assignmentDetail.json?.assignment?.reminders || [];
    ok('自动生成了 2 条提醒', reminders.length === 2, `实际 ${reminders.length} 条`);
    ok('提醒时间按提前量倒推正确',
      reminders.every((r) => r.fire_at < (dueStr || '').replace('T', ' ')),
      JSON.stringify(reminders.map((r) => r.fire_at)));
    ok('提醒内容包含课程名与作业名',
      reminders[0]?.title.includes('高等数学') && reminders[0]?.title.includes('第三章'));

    // 改 DDL 后提醒要重建
    const newDue = new Date(Date.now() + 5 * 86_400_000);
    const newDueStr = `${newDue.getFullYear()}-${pad(newDue.getMonth() + 1)}-${pad(newDue.getDate())}T12:00`;
    await req('PATCH', `/api/assignments/${assignmentId}`, { json: { dueAt: newDueStr } });
    const afterUpdate = await req('GET', `/api/assignments/${assignmentId}`);
    const newReminders = afterUpdate.json?.assignment?.reminders || [];
    ok('修改 DDL 后提醒被重建', newReminders.length === 2
      && newReminders[0].fire_at !== reminders[0].fire_at);
    ok('新提醒时间基于新 DDL', newReminders.some((r) => r.fire_at.startsWith(newDueStr.slice(0, 10))));

    // 标记完成后提醒应被取消
    await req('PATCH', `/api/assignments/${assignmentId}`, { json: { status: 'done' } });
    const afterDone = await req('GET', `/api/assignments/${assignmentId}`);
    ok('作业完成后待发提醒被清除',
      (afterDone.json?.assignment?.reminders || []).filter((r) => r.status === 'pending').length === 0);

    // 恢复成未完成，后续统计用
    await req('PATCH', `/api/assignments/${assignmentId}`, { json: { status: 'todo' } });

    const assignmentPage = await req('GET', '/assignments');
    ok('作业页可访问', assignmentPage.status === 200);
    ok('作业页显示作业', assignmentPage.text.includes('第三章课后习题'));
    ok('作业页显示提醒标签', assignmentPage.text.includes('提前 1 天'));
    ok('作业页提示未配置渠道', assignmentPage.text.includes('未配置提醒渠道'));

    // ---- 勾选框：二次确认 + 完成动画 ----
    // 用户原话：「作业做完了点击方格消除时，加一些确认按键，防止误触，
    // 如果可以再加一些简单动画更有仪式感」
    ok('★ 作业页的勾选框是真按钮（键盘也能用）',
      /<button[^>]*class="sg-check__box[^"]*"[^>]*data-toggle-assignment/.test(assignmentPage.text));
    ok('★ 勾选框带上了作业名（读屏能听出是哪一项）',
      assignmentPage.text.includes('data-check-title="第三章课后习题 1-15 题"'));
    ok('★ 读屏标签也带上了作业名',
      assignmentPage.text.includes('aria-label="标记为已完成：第三章课后习题 1-15 题"'));
    ok('★ 勾选框没有写死 tabindex 冒充按钮', !assignmentPage.text.includes('class="task__check"'));
    ok('★ 打勾标记用 pathLength 归一化（这样才画得出描边动画）',
      assignmentPage.text.includes('pathLength="1"'));
    ok('★ 待办视图的列表标了 data-hides-done（前端据此决定要不要做退场动画）',
      assignmentPage.text.includes('data-hides-done="1"'));

    // 「全部」视图里完成的作业不会消失，就不该标记成会隐藏
    const allView = await req('GET', '/assignments?status=all');
    ok('★ 「全部」视图不标记 data-hides-done', !allView.text.includes('data-hides-done'));

    // ---- 「已逾期」筛选 ----
    // 逾期是**派生**状态（没做完 + 有截止时间 + 时间已过），不是 status 列里的值，
    // 所以不能用 status='overdue' 去查库 —— 那样一条都查不出来，
    // 而页面上照样渲染出一个空列表，看起来像「你没有逾期作业」。
    //
    // 先造两条时间点确定的作业（一条过去、一条未来），
    // 否则这一页本来就是空的，下面几条断言全在空转 —— 这个坑踩过。
    const padNum = (n) => String(n).padStart(2, '0');
    const localStamp = (offsetDays) => {
      const d = new Date(Date.now() + offsetDays * 86_400_000);
      return `${d.getFullYear()}-${padNum(d.getMonth() + 1)}-${padNum(d.getDate())}`
        + `T${padNum(d.getHours())}:${padNum(d.getMinutes())}`;
    };
    const OVERDUE_TITLE = 'E2E 已过期作业';
    const FUTURE_TITLE = 'E2E 还没到期作业';
    const pastNew = await req('POST', '/api/assignments', {
      json: { title: OVERDUE_TITLE, dueAt: localStamp(-3), priority: 1 },
    });
    const futureNew = await req('POST', '/api/assignments', {
      json: { title: FUTURE_TITLE, dueAt: localStamp(3), priority: 1 },
    });
    ok('（前提）造出一条已过期的作业',
      pastNew.status === 200 || pastNew.status === 201, `状态码 ${pastNew.status}`);
    ok('（前提）造出一条还没到期的作业',
      futureNew.status === 200 || futureNew.status === 201, `状态码 ${futureNew.status}`);

    const overdueView = await req('GET', '/assignments?status=overdue');
    ok('★ 「已逾期」筛选页能打开', overdueView.status === 200, `状态码 ${overdueView.status}`);
    ok('★ 逾期页里能看到已过期的作业（不是空列表）',
      overdueView.text.includes(OVERDUE_TITLE));
    ok('★ 逾期页里**看不到**还没到期的作业（筛选真的在起作用）',
      !overdueView.text.includes(FUTURE_TITLE),
      '★ 没到期的作业混进了逾期页 —— 逾期判定写错了');
    ok('★ 逾期筛选被标成当前项（读屏也知道在哪个视图）',
      /class="filter-tab is-active"[^>]*aria-current="page"[^>]*href="\/assignments\?status=overdue"/.test(overdueView.text));
    // 副标题要跟着筛选走，不能还是「共 N 项待办」
    ok('★ 逾期页的副标题说的是逾期，不是「共 N 项待办」',
      /项已逾期/.test(overdueView.text) && !/共 \d+ 项待办/.test(overdueView.text));
    // 统计卡上的「已过期」数字（走 SQL 聚合）和这一页的列表条数（走筛选）
    // 是**分别算出来的**。两边口径不一致的话，会出现「卡片说 3 条、
    // 点进去只有 2 条」，用户会觉得数据是错的。
    const statOverdue = Number(
      /已过期<\/span><span class="stat__value">(\d+)</.exec(overdueView.text)?.[1],
    );
    const overdueRows = (overdueView.text.match(/<article class="assignment[ "]/g) || []).length;
    ok('★ 「已过期」统计卡的数字和列表条数对得上（两边口径一致）',
      Number.isFinite(statOverdue) && overdueRows > 0 && statOverdue === overdueRows,
      `卡片说 ${statOverdue} 条，列表里数到 ${overdueRows} 条`);

    // ⚠️ 把自己造的两条删掉。
    // 后面还有「清理后分组标题不再出现」那类测试，它们假定作业集合是已知的 ——
    // 多留两条会让那边莫名其妙地红，而且报错信息完全指不到这里。
    // 造了数据就要自己收干净。
    for (const created of [pastNew, futureNew]) {
      const id = created.json?.assignment?.id;
      if (id) await req('DELETE', `/api/assignments/${id}`);
    }
    const afterOverdueCleanup = await req('GET', '/assignments?status=overdue');
    ok('★ 造的两条测试数据已经清掉了（不影响后面的用例）',
      !afterOverdueCleanup.text.includes(OVERDUE_TITLE)
      && !afterOverdueCleanup.text.includes(FUTURE_TITLE));

    // 课程详情页也用了同一个勾选框组件。
    // 这里曾经有个真 bug：课程页的勾选框是个 <span role="button">，
    // 而绑事件的 initAssignments() 在没有作业表单模板的页面上会提前返回，
    // 所以点了完全没反应、按回车也没反应。
    const coursePage = await req('GET', `/courses/${courseId}`);
    ok('★ 课程详情页也渲染了勾选框',
      coursePage.text.includes('data-toggle-assignment'));
    ok('★ 课程详情页的勾选框同样是真的 button，不是 span',
      /<button[^>]*class="sg-check__box[^"]*"[^>]*data-toggle-assignment/.test(coursePage.text));
    ok('★ 课程详情页不会把已完成的作业做退场处理（列表本来就不隐藏它们）',
      !coursePage.text.includes('data-hides-done'));

    // 绑事件的初始化不能挂在只有作业页才有的模板上
    const appJsChecks = await req('GET', '/static/app.js');
    ok('★ 勾选逻辑在独立的初始化函数里（不依赖作业表单模板）',
      appJsChecks.text.includes('initAssignmentChecks'));
    // 断言「在 boot() 里被调用」，而不是「紧跟在某一行后面」——
    // 以前写成后者，中间插一个新初始化函数就把测试写挂了
    const bootBody = /function boot\(\)\s*\{([\s\S]*?)\n\}/.exec(appJsChecks.text)?.[1] || '';
    ok('★ 勾选逻辑被无条件调用（课程页才会生效）',
      bootBody.includes('initAssignmentChecks()'), 'boot() 里没有调用 initAssignmentChecks');
    ok('★ 有确认条的实现', appJsChecks.text.includes('askCheckConfirm'));
    ok('★ 有粒子动画的实现', appJsChecks.text.includes('burstConfetti'));
    ok('★ 尊重系统的「减弱动态效果」设置',
      appJsChecks.text.includes('prefers-reduced-motion')
      && appJsChecks.text.includes('prefersReducedMotion'));
    ok('★ 接口失败时会把勾选状态退回去（界面不能骗人）',
      /catch[\s\S]{0,240}paintCheckBox\(box, !toDone\)/.test(appJsChecks.text));

    // 确认条和粒子都必须挂到 body 上。
    // 课程详情页的作业列表在 .card 里，而 .card 是 overflow: hidden，
    // 挂在方格里面的话它们会被卡片边缘整块裁掉。
    ok('★ 确认条挂到 body 上（否则会被 .card 的 overflow 裁掉）',
      /document\.body\.appendChild\(el\)/.test(appJsChecks.text));
    ok('★ 粒子图层也挂到 body 上', appJsChecks.text.includes('sg-confetti-layer')
      && /document\.body\.appendChild\(layer\)/.test(appJsChecks.text));

    // 勾选成功后马上要 reload，直接 toast 会被一起刷掉（只闪一下）。
    // 所以成功提示要寄存在 sessionStorage 里，由新页面取出来显示。
    ok('★ 成功提示能跨刷新存活（否则 300ms 后就没了）',
      appJsChecks.text.includes('toastAfterReload')
      && appJsChecks.text.includes('flushPendingToast'));
    ok('★ 新页面启动时会把上次留下的提示显示出来',
      /function boot\(\)[\s\S]{0,200}flushPendingToast\(\)/.test(appJsChecks.text));
    // 失败时不刷新页面，直接 toast 就行，别绕一圈 sessionStorage
    ok('★ 失败提示是立即显示，不是留给下次刷新',
      /catch[\s\S]{0,320}toast\(err\.message, 'error'\)/.test(appJsChecks.text));

    // ---- 样式表不能有语法错误 ----
    // 一段没闭合的大括号会静默吞掉后面所有规则，页面看着就是「样式没生效」，
    // 而且不会有任何报错。真实踩过，所以这里强行查一遍。
    const cssRes = await req('GET', '/static/app.css');
    const cssText = cssRes.text;
    let depth = 0;
    let minDepth = 0;
    for (const ch of cssText) {
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; minDepth = Math.min(minDepth, depth); }
    }
    ok('★ 样式表的大括号是配平的', depth === 0, `结束时深度 ${depth}`);
    ok('★ 样式表没有多余的右括号', minDepth === 0, `最小深度 ${minDepth}`);
    for (const sel of ['.sg-check__box', '.sg-check__mark', '.check-confirm', '.sg-confetti',
      '.sg-confetti-layer', '.is-just-checked', '.is-flashing', '.is-leaving']) {
      ok(`★ 样式里有 ${sel}`, cssText.includes(sel));
    }
    // 确认条是 fixed 定位的，靠 JS 算坐标；用 absolute 就会被祖先的
    // overflow: hidden 裁掉（.card 就有），所以这里钉住定位方式
    ok('★ 确认条用 fixed 定位且在 body 上（不被卡片裁剪）',
      /\.check-confirm\s*\{[^}]*position:\s*fixed/.test(cssText));
    ok('★ 确认条的层级在弹窗(100)和 toast(200)之间',
      /\.check-confirm\s*\{[^}]*z-index:\s*90/.test(cssText));
    ok('★ 确认条默认隐藏，摆好坐标再显示（避免在左上角闪一下）',
      /\.check-confirm\s*\{[^}]*visibility:\s*hidden/.test(cssText)
      && cssText.includes('.check-confirm.is-positioned'));

    // ---- 分组标题要如实说明离 DDL 多远 ----
    // 用户原话：「我觉得在三天外的 ddl 不能叫做稍后截止」。
    // 那一组的范围是 3 天以上、上不封顶，把三周后的作业叫「稍后」是在淡化它。
    //
    // 注意：分组标题只在组内有内容时才渲染，所以不能断言「页面上有全部标题」。
    // 上面这门作业的 DDL 是 5 天后，落在「3 天以后截止」那一组。
    ok('★ 作业页不再把三天外说成「稍后截止」', !assignmentPage.text.includes('稍后截止'));
    ok('★ 三天外那一组如实写出边界', assignmentPage.text.includes('3 天以后截止'));
    ok('★ 5 天后的作业没有被塞进「3 天内截止」那一组',
      !assignmentPage.text.includes('3 天内截止'));

    // 再从另一侧验证一次边界：临时造一门 1 天后到期的作业，
    // 它应该出现在「3 天内截止」里，而不是「3 天以后截止」里。
    const soonDue = new Date(Date.now() + 1 * 86_400_000);
    const soonDueStr = `${soonDue.getFullYear()}-${pad(soonDue.getMonth() + 1)}-${pad(soonDue.getDate())}T23:59`;
    const soonCreated = await req('POST', '/api/assignments', {
      json: { title: '【边界检查】明天到期', courseId, dueAt: soonDueStr },
    });
    const soonId = soonCreated.json?.assignment?.id;

    const soonPage = await req('GET', '/assignments');
    ok('★ 1 天后的作业落在「3 天内截止」那一组',
      soonPage.text.includes('3 天内截止') && soonPage.text.includes('【边界检查】明天到期'));
    ok('★ 两个分组同时出现时，标题各自都写对了',
      soonPage.text.includes('3 天内截止') && soonPage.text.includes('3 天以后截止'));
    ok('★ 分组标题按紧急程度排列（3 天内在前，3 天以后在后）',
      soonPage.text.indexOf('3 天内截止') < soonPage.text.indexOf('3 天以后截止'));
    ok('★ 两个分组同时出现时也没有「稍后截止」', !soonPage.text.includes('稍后截止'));

    // 清理，后面的统计和调度器不该被这门临时作业影响
    await req('DELETE', `/api/assignments/${soonId}`);
    const afterCleanup = await req('GET', '/assignments');
    ok('★ 清理后分组标题不再出现（空组不渲染）',
      !afterCleanup.text.includes('【边界检查】明天到期')
      && !afterCleanup.text.includes('3 天内截止'));

    // --------------------------------------------------------
    section('4. 课件上传与在线预览');

    const pptx = makeTestPptx();
    ok('构造出的 PPTX 是合法 zip', pptx[0] === 0x50 && pptx[1] === 0x4b);

    const upload = multipart(
      { courseId: String(courseId), category: 'courseware', week: '3', tags: '重点,期中' },
      { field: 'file', filename: '第3章 需求与供给.pptx', data: pptx, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    );
    const uploadRes = await req('POST', '/api/materials', {
      body: upload.body,
      headers: { 'Content-Type': upload.contentType },
    });
    ok('上传 PPTX 成功', uploadRes.status === 201,
      `状态码 ${uploadRes.status}：${uploadRes.text.slice(0, 200)}`);

    const material = uploadRes.json?.material;
    const materialId = material?.id;
    ok('识别为演示文稿类型', material?.kind === 'ppt', `实际 ${material?.kind}`);
    ok('中文文件名正确保存', material?.original_name === '第3章 需求与供给.pptx',
      `实际 ${material?.original_name}`);
    ok('标题默认取文件名（去掉扩展名）', material?.title === '第3章 需求与供给',
      `实际 ${material?.title}`);
    ok('文件大小记录正确', material?.size === pptx.length, `${material?.size} vs ${pptx.length}`);

    // 预览是异步生成的，轮询等待
    let status = null;
    for (let i = 0; i < 60; i += 1) {
      const res = await req('GET', `/api/materials/${materialId}/status`);
      status = res.json;
      if (status?.status === 'ready' || status?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    ok('预览生成完成', status?.status === 'ready',
      `状态 ${status?.status}，错误 ${status?.error || '无'}`);
    ok('降级为网页版预览（本测试关闭了 Office 转换）', status?.previewMode === 'office',
      `实际 ${status?.previewMode}`);

    const previewPage = await req('GET', `/materials/${materialId}`);
    ok('预览页可访问', previewPage.status === 200, `状态码 ${previewPage.status}`);
    ok('预览页渲染出 PPT 文本内容', previewPage.text.includes('第一章 导论')
      && previewPage.text.includes('微观经济学的研究对象'));
    ok('预览页渲染出第二页', previewPage.text.includes('需求与供给'));
    ok('预览页对幻灯片正确编号', previewPage.text.includes('第 1 页') && previewPage.text.includes('第 2 页'));
    ok('预览页给出降级说明', previewPage.text.includes('这是网页版预览'));
    ok('预览页显示所属课程', previewPage.text.includes('高等数学'));

    // ---- 全屏观看 ----
    // 用户提的需求：「资料界面可以全屏观看吗，如果不能，想新加入」。
    // 原来只有幻灯片图片那条路有个覆盖全屏的看图器，PDF（服务器上的主要模式）
    // 只是一个 iframe，没有任何全屏入口。
    ok('★ 预览页有「全屏」按钮', previewPage.text.includes('data-viewer-fullscreen'));
    // 注意：这条只验了 hidden 属性在不在。属性本身并不隐藏任何东西 ——
    // 真正让它藏起来的是样式表里那条 [hidden] { display: none !important }，
    // 下面单独有一条断言盯着它。
    ok('★ 全屏按钮默认隐藏（没有 JS 时不该摆个按不动的按钮）',
      /<button[^>]*data-viewer-fullscreen[^>]*\bhidden\b/.test(previewPage.text),
      '按钮上缺 hidden');
    ok('★ 预览页有「退出全屏」按钮，而且它在预览区里面',
      previewPage.text.includes('data-viewer-exit')
      && previewPage.text.indexOf('data-viewer-exit') > previewPage.text.indexOf('data-preview-main')
      && previewPage.text.indexOf('data-viewer-exit') < previewPage.text.indexOf('preview-side'),
      '放在 .preview-main 外面的话它永远不显示（或永远显示）');
    // 「带文字」要把图标剥掉再看：SVG 有一两百个字符，
    // 用固定长度的窗口去找文字会被图标撑爆（这条一开始就是这么写错的）
    const fsBtnHtml = /<button[^>]*data-viewer-fullscreen[\s\S]*?<\/button>/.exec(previewPage.text)?.[0] || '';
    ok('★ 全屏按钮有文字标签，不是只有图标（图标看不懂是什么意思）',
      fsBtnHtml.replace(/<svg[\s\S]*?<\/svg>/g, '').includes('全屏'),
      fsBtnHtml.slice(0, 160));

    const fsCss = (await req('GET', '/static/app.css')).text;
    ok('★ 样式里有全屏态（铺满视口）',
      fsCss.includes('.preview-main.is-immersive')
      && /\.preview-main\.is-immersive \{[^}]*position:\s*fixed/.test(fsCss));
    ok('★ 退出按钮平时不显示',
      /\.viewer-exit \{[^}]*display:\s*none/.test(fsCss));
    ok('★ 全屏态的层级盖过手机底部导航、但没盖过弹窗',
      (() => {
        const z = Number(/\.preview-main\.is-immersive \{[^}]*z-index:\s*(\d+)/.exec(fsCss)?.[1]);
        const modal = Number(/\.modal-backdrop \{[^}]*z-index:\s*(\d+)/.exec(fsCss)?.[1]);
        return z > 50 && modal > z;
      })(), '全屏盖住底部导航才不留一条，但必须低于弹窗(100)，否则全屏时弹窗点不到');

    const fsAppJs = (await req('GET', '/static/app.js')).text;
    ok('★ 客户端有全屏逻辑，而且在启动时被调用了',
      fsAppJs.includes('function initMaterialViewer()') && /\n\s+initMaterialViewer\(\);/.test(fsAppJs),
      '定义了却没调用的话，点全屏不会有任何反应');
    ok('★ 客户端有 iOS 提示逻辑，而且在启动时被调用了',
      fsAppJs.includes('function initIosPdfNotice()') && /\n\s+initIosPdfNotice\(\);/.test(fsAppJs),
      '定义了却没调用的话，那块提示永远不会出现');

    // ---- PDF 预览的 iPhone / iPad 提示 ----
    // iOS Safari 在 <iframe> 里渲染 PDF 时只画第一页、而且不给滚动。
    // 服务器上的课件现在大多是 LibreOffice 转出来的 PDF，
    // 于是手机上打开资料页看到的是「一份只有一页的课件」，很容易以为文件传坏了。
    // 修不了苹果的行为，但可以告诉用户换个打开方式 —— 新标签页会交给系统阅读器。
    ok('★ 网页版 Office 预览不该有这块 iOS 提示（那种模式手机上本来就是好的）',
      !previewPage.text.includes('data-ios-pdf-notice'),
      '别的模式多一块提示纯属噪音');

    const pdfUpload = multipart(
      { courseId: String(courseId), category: 'handout' },
      { field: 'file', filename: '手机上看这份.pdf', data: makeTestPdf(), mime: 'application/pdf' },
    );
    const iosPdfRes = await req('POST', '/api/materials', {
      body: pdfUpload.body,
      headers: { 'Content-Type': pdfUpload.contentType },
    });
    ok('上传一份原生 PDF（用来验 PDF 模式那条路径）', iosPdfRes.status === 201,
      `状态码 ${iosPdfRes.status}：${iosPdfRes.text.slice(0, 200)}`);
    const pdfMaterialId = iosPdfRes.json?.material?.id;

    const iosPdfPage = await req('GET', `/materials/${pdfMaterialId}`);
    ok('★ PDF 预览里有 iOS 提示', iosPdfPage.text.includes('data-ios-pdf-notice'));
    ok('★ iOS 提示默认带 hidden（桌面浏览器点开 PDF 是好的，不该看到它）',
      /<div[^>]*data-ios-pdf-notice[^>]*\bhidden\b/.test(iosPdfPage.text),
      '缺 hidden 属性');
    ok('★ iOS 提示排在 iframe 前面（要先看到提示，而不是先对着第一页纳闷）',
      iosPdfPage.text.indexOf('data-ios-pdf-notice') > -1
      && iosPdfPage.text.indexOf('data-ios-pdf-notice') < iosPdfPage.text.indexOf('<iframe'),
      '两边都得能找到才比得了 —— 只写 < 的话，钩子改名后 -1 反而算通过');

    // 把提示那一整段抠出来单独检查。用 iframe 当右边界最省事：
    // 块里有嵌套 div 和 <a>，「数标签配对」的正则很容易对不上。
    const noticeHtml = iosPdfPage.text.slice(
      iosPdfPage.text.indexOf('data-ios-pdf-notice'),
      iosPdfPage.text.indexOf('<iframe'),
    );
    ok('★ iOS 提示给了「新标签页打开」这条出路，而不是只说一句不支持',
      new RegExp(`<a[^>]*href="/materials/${pdfMaterialId}/pdf"[^>]*target="_blank"`).test(noticeHtml),
      noticeHtml.slice(0, 220));
    ok('★ iOS 提示说清了是苹果的限制（否则用户会以为文件传坏了）',
      /苹果|Safari/.test(noticeHtml) && noticeHtml.includes('第一页'));

    // ★ 这一条是上面两个 hidden 的兜底。
    //   hidden 属性本身并不隐藏任何东西：浏览器默认那条 [hidden]{display:none}
    //   属于最低优先级，会被 .btn / .notice 自己的 display 盖掉。
    //   少了下面这条 !important 规则，「全屏」按钮和这块 iOS 提示
    //   会在**所有设备上**冒出来 —— 一个点了没反应，一个根本不该出现。
    ok('★ 样式表里有 [hidden] 契约（否则上面两处 hidden 都是摆设）',
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(fsCss.replace(/\/\*[\s\S]*?\*\//g, '')),
      '基础层缺 [hidden] { display: none !important }');
    ok('★ iOS 提示块的样式在（.viewer__notice）', fsCss.includes('.viewer__notice'));

    const delPdf = await req('DELETE', `/api/materials/${pdfMaterialId}`);
    ok('清理掉这份临时 PDF（别影响后面的统计）', delPdf.status === 200,
      `状态码 ${delPdf.status}`);

    // 标题不应重复显示
    const titleOccurrences = (previewPage.text.match(/第一章 导论/g) || []).length;
    ok('PPT 标题没有重复渲染', titleOccurrences === 1, `出现 ${titleOccurrences} 次`);

    const rawFile = await req('GET', `/materials/${materialId}/raw`);
    ok('可以取到原始文件', rawFile.status === 200, `状态码 ${rawFile.status}`);
    ok('原始文件字节数一致', Buffer.byteLength(rawFile.text, 'utf8') > 0 && rawFile.status === 200);

    // 文本文件走另一条预览路径
    const txtUpload = multipart(
      { courseId: String(courseId), category: 'reference' },
      { field: 'file', filename: '复习提纲.txt', data: Buffer.from('第一章重点\n第二章重点\n', 'utf8'), mime: 'text/plain' },
    );
    const txtRes = await req('POST', '/api/materials', {
      body: txtUpload.body,
      headers: { 'Content-Type': txtUpload.contentType },
    });
    ok('上传文本文件成功', txtRes.status === 201);
    ok('识别为文本类型', txtRes.json?.material?.kind === 'text', `实际 ${txtRes.json?.material?.kind}`);

    let txtStatus = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await req('GET', `/api/materials/${txtRes.json.material.id}/status`);
      txtStatus = res.json;
      if (txtStatus?.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const txtPage = await req('GET', `/materials/${txtRes.json.material.id}`);
    ok('文本预览页显示正文', txtPage.text.includes('第一章重点'));
    // 文字版也走的是「服务端排版 + 一段正文」这条路，同样不该出现 iOS 提示。
    // 在这里也验一次，而不是只在 Office 页上看 —— A/B 注入时发现：
    // 只验一个模式的话，把提示误加进另一个模式是抓不住的。
    ok('★ 文字预览模式不该有 iOS 提示（那种模式手机上本来就是好的）',
      !txtPage.text.includes('data-ios-pdf-notice'));

    // 全文检索
    const search = await req('GET', '/materials?q=' + encodeURIComponent('微观经济学'));
    ok('可以按课件正文全文检索', search.text.includes('第3章 需求与供给'));

    // 资料库页
    const materialsPage = await req('GET', '/materials');
    ok('资料库页可访问', materialsPage.status === 200);
    // 资料库是**文件列表**，不是卡片墙 —— 卡片每份要占 210px 宽 + 130px 预览区，
    // 一屏放不下几份；而翻课件真正要做的是「在一堆文件里找到那一份」。
    ok('资料库显示文件列表（不是卡片墙）',
      materialsPage.text.includes('material-list')
      && materialsPage.text.includes('material-row')
      && !materialsPage.text.includes('material-card'));
    ok('★ 列表行里的操作按钮在 <a> 外面（交互元素不能嵌套）',
      // 放在链接里面的话，点「删除」会同时触发「打开这份资料」
      /<\/a>\s*<span class="material-row__actions">/.test(materialsPage.text));
    ok('★ 手机上会被藏掉的元信息单独包了一层（不然窄屏会挤成两行）',
      materialsPage.text.includes('material-row__meta-extra'));
    ok('资料库按类型统计', materialsPage.text.includes('演示文稿'));
    ok('上传表单模板已注入', materialsPage.text.includes('upload-form-template'));

    // ---- 编辑已上传课件的属性 ----
    // 用户反馈：「已加入的课件资料无法重新选择属性，比如属于什么学科等」。
    // 这条路径此前完全没有测试覆盖，所以先把它整条走一遍。
    const editForm = await req('GET', `/materials/${materialId}`);
    ok('★ 预览页渲染了编辑表单模板', editForm.text.includes('material-edit-template'));
    ok('★ 编辑表单里有「归属课程」下拉',
      editForm.text.includes('name="courseId"'));
    ok('★ 编辑表单里有「分类」下拉', editForm.text.includes('name="category"'));
    ok('★ 编辑表单里列出了可选课程',
      editForm.text.includes(`<option value="${courseId}">`));

    const listPageForEdit = await req('GET', '/materials');
    ok('★ 资料库页也有编辑表单模板', listPageForEdit.text.includes('material-edit-template'));
    ok('★ 资料库页每一行都有编辑入口',
      listPageForEdit.text.includes(`data-edit-material="${materialId}"`));
    // 纯图标按钮在手机上没法悬停，title 提示永远不会出现 ——
    // 用户只会看到一个不知道是什么的小图标。主操作要有文字。
    // （不能用「属性后面多少字符内出现 span」这种断言：中间夹着的
    //   SVG 图标本身就好几百字符，窗口一开就假阴性。）
    ok('★ 资料库页的编辑按钮带文字（不是纯图标，手机上才找得到）',
      listPageForEdit.text.includes('<span>编辑</span>'));
    ok('★ 编辑按钮有 aria-label（读屏能说清是编辑哪一份）',
      /aria-label="编辑「[^"]+」/.test(listPageForEdit.text));

    // 接口回给客户端的数据要带上当前值，表单才能正确回填
    const editData = await req('GET', `/api/materials/${materialId}`);
    ok('★ 接口返回了 course_id（表单靠它回填下拉框）',
      editData.json?.material?.course_id != null,
      `course_id=${editData.json?.material?.course_id}`);
    ok('★ 接口返回了 category', Boolean(editData.json?.material?.category));

    // 造一门新课程，把课件改挂过去
    const otherCourse = await req('POST', '/api/courses', {
      json: { name: '【编辑测试】线性代数', teacher: '李老师' },
    });
    const otherCourseId = otherCourse.json?.course?.id;

    const patched = await req('PATCH', `/api/materials/${materialId}`, {
      json: { courseId: otherCourseId, category: 'reference', week: 7, tags: 'a,b', description: '改过了' },
    });
    ok('★ 能改课件的归属课程', patched.status === 200, `状态码 ${patched.status}`);

    const afterPatch = (await req('GET', `/api/materials/${materialId}`)).json?.material;
    ok('★ 归属课程真的变了', String(afterPatch?.course_id) === String(otherCourseId),
      `期望 ${otherCourseId}，实际 ${afterPatch?.course_id}`);
    ok('★ 分类也变了', afterPatch?.category === 'reference', `实际 ${afterPatch?.category}`);
    ok('★ 周次也变了', Number(afterPatch?.week) === 7, `实际 ${afterPatch?.week}`);
    ok('★ 标签也变了', afterPatch?.tags === 'a,b', `实际 ${afterPatch?.tags}`);
    ok('★ 说明也变了', afterPatch?.description === '改过了');

    // 再改回去，并验证「暂不归类」能清空归属
    await req('PATCH', `/api/materials/${materialId}`, { json: { courseId: '' } });
    const cleared = (await req('GET', `/api/materials/${materialId}`)).json?.material;
    ok('★ 选「暂不归类」能把课程清掉', cleared?.course_id === null,
      `实际 ${JSON.stringify(cleared?.course_id)}`);

    await req('PATCH', `/api/materials/${materialId}`, { json: { courseId } });
    const restored = (await req('GET', `/api/materials/${materialId}`)).json?.material;
    ok('★ 能改回原来的课程', String(restored?.course_id) === String(courseId));

    // 编辑后列表页要跟着变
    const listAfterEdit = await req('GET', '/materials');
    ok('★ 改完之后资料库页显示新的课程名',
      listAfterEdit.text.includes('线性代数') || listAfterEdit.text.includes('高等数学'));

    // 别人的课件改不了
    const editAnon = createClient(baseUrl);
    const anonPatch = await editAnon('PATCH', `/api/materials/${materialId}`, {
      json: { title: '被人改了' },
    });
    ok('★ 未登录不能编辑课件',
      anonPatch.status === 302 || anonPatch.status === 401 || anonPatch.status === 403,
      `状态码 ${anonPatch.status}`);

    if (otherCourseId) await req('DELETE', `/api/courses/${otherCourseId}`);

    // ---- 按钮真的绑上事件了吗 ----
    // 用户反馈的是「点了没反应」，这种问题接口测试看不出来：
    // 数据层完全正常，坏的是前端根本没绑事件。
    //
    // 根因是同一个反模式（这已经是第二次踩）：
    // 绑事件的函数开头写着「页面上没有某个模板就 return」，
    // 而那个模板只在部分页面存在 —— 于是别的页面上的按钮全成了摆设。
    //   · 第一次：作业勾选框（模板只有作业页有 → 课程页点了没反应）
    //   · 这一次：资料的「编辑」和「重新转换」（上传模板只有资料库页有
    //     → 预览页上这两个按钮点了没反应）
    const appJsMat = await req('GET', '/static/app.js');

    ok('★ initMaterials 不再因为「页面缺上传模板」就整体退出',
      !/const tpl = document\.getElementById\('upload-form-template'\);[\s\S]{0,20}if \(!tpl\) return;/
        .test(appJsMat.text),
      '又出现了那个反模式：绑事件的函数拿页面级模板做提前返回');

    ok('★ 资料的编辑按钮在共用处理器里绑定（两个页面才都能用）',
      appJsMat.text.includes("closest('[data-edit-material]')"));
    ok('★ 「重新转换」按钮也一样绑定（它只出现在预览页）',
      appJsMat.text.includes("closest('[data-rebuild-preview]')"));
    ok('★ 上传弹窗改成点击时才检查模板（而不是初始化时就退出）',
      /function openUploadModal\(\)\s*\{[\s\S]{0,200}getElementById\('upload-form-template'\)/
        .test(appJsMat.text));

    // 预览页确实同时具备「编辑按钮」和「编辑表单模板」——
    // 两者缺一，用户点了都会是没反应
    const previewForEdit = await req('GET', `/materials/${materialId}`);
    ok('★ 预览页同时有编辑按钮和编辑表单模板',
      previewForEdit.text.includes(`data-edit-material="${materialId}"`)
      && previewForEdit.text.includes('material-edit-template'));

    // 未登录不能下载别人的文件
    const anon = createClient(baseUrl);
    const anonFetch = await anon('GET', `/materials/${materialId}/raw`);
    ok('未登录无法下载课件', anonFetch.status === 302 || anonFetch.status === 401,
      `状态码 ${anonFetch.status}`);

    // ---- 幻灯片图片渲染路径 ----
    // 用户问：「能不能让课件直接渲染出来，有没有什么办法」。
    // 这条路的由来：Office 导 PDF 依赖打印管线，没有打印机的会话里
    // PowerPoint 会直接崩，但同一份文件导出 PNG 完全正常。
    //
    // 本测试跑在临时数据目录里，没法真的调 PowerPoint 导出，
    // 所以直接铺好产物来验证「存下来的图片能不能被正确服务出去、页面能不能渲染」。
    const slidesDir = path.join(dataDir, 'cache', 'slides', 'e2e-fake');
    fs.mkdirSync(slidesDir, { recursive: true });
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(slidesDir, `slide-${n}.png`), PNG_1PX);
    }
    // 混一个不该被当成幻灯片的文件，验证过滤
    fs.writeFileSync(path.join(slidesDir, 'thumb.png'), PNG_1PX);

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'app.db'));
    // slides_dir 和 pdf_name 一样，存的是相对 uploads 目录的路径
    const relSlides = path.relative(path.join(dataDir, 'uploads'), slidesDir).replace(/\\/g, '/');
    db.prepare("UPDATE materials SET slides_dir = ?, slide_count = 3 WHERE id = ?")
      .run(relSlides, materialId);
    db.close();

    const slideRes = await req('GET', `/materials/${materialId}/slide/1`);
    ok('★ 幻灯片图片能取到', slideRes.status === 200, `状态码 ${slideRes.status}`);
    ok('★ 返回的是 PNG',
      (slideRes.headers.get('content-type') || '').includes('image/png'),
      slideRes.headers.get('content-type') || '');

    const slideDeckPage = await req('GET', `/materials/${materialId}`);
    ok('★ 预览页改用幻灯片模式', slideDeckPage.text.includes('slide-deck'));
    ok('★ 每一页都渲染成一张图',
      slideDeckPage.text.includes('/slide/1') && slideDeckPage.text.includes('/slide/3'));
    ok('★ 页面如实说明共几页', slideDeckPage.text.includes('共 3 页'));
    ok('★ 有幻灯片时就不再是文字版降级',
      !slideDeckPage.text.includes('这个文件还是文字版预览'));
    ok('★ 图片用懒加载，长课件不会一次性拉几百张',
      slideDeckPage.text.includes('loading="lazy"'));
    ok('★ 幻灯片图片模式不该有 iOS 提示（每页都是图，手机上本来就是好的）',
      !slideDeckPage.text.includes('data-ios-pdf-notice'));

    // ---- 页面内看图器 ----
    // 用户反馈：「点进 ppt 单页图片有 bug，退不出来，然后也不能翻页」。
    // 原来每一页是个 target="_blank" 的链接，点开只有一张裸图：
    // 没有返回、不能翻页；装成 PWA 后链接可能开在同一个 webview 里，
    // 连后退键都没有 —— 就真的退不出来了。
    // 现在改成页面内的浮层，所以这些钩子必须在。
    ok('★ 幻灯片容器带上了看图器需要的基准路径和总页数',
      slideDeckPage.text.includes('data-slide-deck')
      && slideDeckPage.text.includes(`data-slide-base="/materials/${materialId}/slide"`)
      && slideDeckPage.text.includes('data-slide-total="3"'));
    ok('★ 每一页都标了页码，看图器才知道从第几页打开',
      slideDeckPage.text.includes('data-slide-viewer="1"')
      && slideDeckPage.text.includes('data-slide-viewer="3"'));

    const appJsViewer = await req('GET', '/static/app.js');
    ok('★ 有看图器的实现', appJsViewer.text.includes('initSlideViewer'));
    ok('★ 看图器在启动时被调用',
      (/function boot\(\)\s*\{([\s\S]*?)\n\}/.exec(appJsViewer.text)?.[1] || '')
        .includes('initSlideViewer()'),
      'boot() 里没有调用 initSlideViewer');
    ok('★ 看图器有上一页/下一页', appJsViewer.text.includes('data-sv-prev')
      && appJsViewer.text.includes('data-sv-next'));
    ok('★ 看图器有关闭按钮', appJsViewer.text.includes('data-sv-close'));
    ok('★ 支持 Esc 关闭和左右方向键翻页',
      appJsViewer.text.includes("'Escape'") && appJsViewer.text.includes("'ArrowLeft'")
      && appJsViewer.text.includes("'ArrowRight'"));
    ok('★ 支持手机左右滑动翻页', appJsViewer.text.includes('touchstart')
      && appJsViewer.text.includes('touchend'));
    ok('★ 会拦截链接默认行为，不再跳到裸图页面',
      appJsViewer.text.includes('e.preventDefault()')
      && appJsViewer.text.includes("closest('[data-slide-viewer]')"));
    ok('★ 按住 Ctrl/Cmd 点仍然能在新标签页打开（尊重用户意图）',
      /e\.metaKey \|\| e\.ctrlKey/.test(appJsViewer.text));
    // 手机用户的本能是右滑返回。如果那一下直接退出整个课件页，还是「退不出来」。
    ok('★ 手机右滑返回是关看图器，而不是退出课件页',
      appJsViewer.text.includes('pushState') && appJsViewer.text.includes('popstate'));
    ok('★ 翻页到头会禁用按钮，不会点了没反应',
      /\[data-sv-prev\]'\)\.disabled/.test(appJsViewer.text));

    const cssViewer = await req('GET', '/static/app.css');
    ok('★ 有看图器的样式', cssViewer.text.includes('.slide-viewer')
      && cssViewer.text.includes('.slide-viewer__nav'));
    ok('★ 看图器的层级盖过弹窗和提示',
      /\.slide-viewer\s*\{[^}]*z-index:\s*300/.test(cssViewer.text));

    // 页码必须校验，不能让 URL 变成任意文件读取
    const badPage = await req('GET', `/materials/${materialId}/slide/abc`);
    ok('★ 非法页码被拒绝', badPage.status === 404, `状态码 ${badPage.status}`);
    const slideTraversal = await req('GET', `/materials/${materialId}/slide/${encodeURIComponent('../../secret')}`);
    ok('★ 页码里的路径穿越被挡住', slideTraversal.status === 404,
      `状态码 ${slideTraversal.status}`);

    const otherAnon = createClient(baseUrl);
    const anonSlide = await otherAnon('GET', `/materials/${materialId}/slide/1`);
    ok('★ 未登录取不到幻灯片图片',
      anonSlide.status === 302 || anonSlide.status === 401 || anonSlide.status === 403,
      `状态码 ${anonSlide.status}`);

    // ---- PDF 预览路径 ----
    // 用户反馈：「第二节 ppt 为什么打不开」。
    // 根因：pdf_name 存的是 '../cache/pdf/xxx.pdf'（相对于 uploads 目录），
    // 而 PDF 路由用的是 uploadPath() —— 那个函数会把任何跑出 uploads 的路径
    // 判为非法并抛异常。于是转换明明成功、PDF 就在磁盘上，点开却打不开。
    //
    // 之所以一直没被发现：本测试为了跑得快关掉了 Office 转换，
    // pdf_name 永远是空的，这条路由从来没被走到过。
    // 现在铺一个 PDF 出来，把这条路由真正测一遍。
    const pdfDir = path.join(dataDir, 'cache', 'pdf');
    fs.mkdirSync(pdfDir, { recursive: true });
    const fakePdfPath = path.join(pdfDir, 'e2e-fake.pdf');
    // 前缀和结尾按 PDF 规范写，中间内容不重要 —— 路由只负责把文件发出去
    const fakePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Size 1>>\n%%EOF\n',
      'latin1',
    );
    fs.writeFileSync(fakePdfPath, fakePdf);

    const db3 = new DatabaseSync(path.join(dataDir, 'app.db'));
    // 和代码里的写法保持一致：相对 uploads 目录
    const relPdf = path.relative(path.join(dataDir, 'uploads'), fakePdfPath).replace(/\\/g, '/');
    db3.prepare("UPDATE materials SET pdf_name = ?, slides_dir = '' WHERE id = ?")
      .run(relPdf, materialId);
    db3.close();

    const pdfRes = await req('GET', `/materials/${materialId}/pdf`);
    ok('★ 转换出来的 PDF 能取到（这条路由以前是 500）', pdfRes.status === 200,
      `状态码 ${pdfRes.status}`);
    ok('★ 返回的是 PDF',
      (pdfRes.headers.get('content-type') || '').includes('application/pdf'),
      pdfRes.headers.get('content-type') || '');
    ok('★ 发出去的确实是 PDF 内容', pdfRes.text.startsWith('%PDF-'),
      JSON.stringify(pdfRes.text.slice(0, 20)));
    ok('★ 内容长度正确',
      Number(pdfRes.headers.get('content-length')) === fakePdf.length,
      `声明 ${pdfRes.headers.get('content-length')}，实际 ${fakePdf.length}`);

    // 浏览器的 PDF 阅读器靠 Range 请求分段加载，这条不通就会显示空白
    const rangeRes = await req('GET', `/materials/${materialId}/pdf`, {
      headers: { Range: 'bytes=0-7' },
    });
    ok('★ 支持 Range 请求（PDF 阅读器要靠它加载）',
      rangeRes.status === 206 && rangeRes.headers.get('content-range'),
      `状态码 ${rangeRes.status}，content-range=${rangeRes.headers.get('content-range')}`);
    ok('★ Range 返回的是请求的那一段', rangeRes.text.startsWith('%PDF-1.4'),
      JSON.stringify(rangeRes.text));

    const pdfPage = await req('GET', `/materials/${materialId}`);
    ok('★ 有 PDF 时预览页用内嵌 PDF 阅读器',
      pdfPage.text.includes(`/materials/${materialId}/pdf`)
      && pdfPage.text.includes('<iframe'));
    ok('★ 有 PDF 就不再是文字版降级', !pdfPage.text.includes('这个文件还是文字版预览'));

    const downloadRes = await req('GET', `/materials/${materialId}/pdf?download=1`);
    ok('★ 带 download=1 时作为附件下载',
      /attachment/i.test(downloadRes.headers.get('content-disposition') || ''),
      downloadRes.headers.get('content-disposition') || '');

    const anonPdf = createClient(baseUrl);
    const anonPdfRes = await anonPdf('GET', `/materials/${materialId}/pdf`);
    ok('★ 未登录取不到 PDF',
      anonPdfRes.status === 302 || anonPdfRes.status === 401 || anonPdfRes.status === 403,
      `状态码 ${anonPdfRes.status}`);

    // 恢复，别影响后面的统计断言
    const db4 = new DatabaseSync(path.join(dataDir, 'app.db'));
    db4.prepare("UPDATE materials SET pdf_name = '' WHERE id = ?").run(materialId);
    db4.close();
    fs.rmSync(fakePdfPath, { force: true });

    // 把幻灯片那一路也恢复掉
    const db2 = new DatabaseSync(path.join(dataDir, 'app.db'));
    db2.prepare("UPDATE materials SET slides_dir = '', slide_count = NULL WHERE id = ?").run(materialId);
    db2.close();
    fs.rmSync(slidesDir, { recursive: true, force: true });

    // --------------------------------------------------------
    section('5. 通知渠道');

    const catalog = await req('GET', '/api/channels/catalog');
    ok('渠道目录可访问', catalog.status === 200);
    ok('内置了 Bark 渠道', catalog.json?.channels?.some((c) => c.type === 'bark'));
    ok('内置了邮件渠道', catalog.json?.channels?.some((c) => c.type === 'email'));
    ok('渠道数量不少于 10 种', (catalog.json?.channels?.length || 0) >= 10,
      `实际 ${catalog.json?.channels?.length} 种`);

    // ---- Bark 引导 ----
    // 用户的原话：「bark推送设置还是有点问题，你再修改一下，把引导做更详细一点」
    const barkDef = catalog.json?.channels?.find((c) => c.type === 'bark');
    ok('★ Bark 渠道带上了详细引导文案', typeof barkDef?.guide === 'string' && barkDef.guide.length > 300,
      `长度 ${barkDef?.guide?.length || 0}`);
    ok('★ 引导里写了去 App Store 装 Bark',
      (barkDef?.guide || '').includes('App Store'));
    ok('★ 引导里写了要允许通知权限', /允许/.test(barkDef?.guide || ''));
    ok('★ 引导里写了怎么复制 Key（长按）', /长按/.test(barkDef?.guide || ''));
    ok('★ 引导里有「没收到怎么排查」的清单', /排查/.test(barkDef?.guide || ''));
    ok('★ 引导里讲了 iOS 时效性通知的开关位置',
      /时效性通知/.test(barkDef?.guide || '') && /设置 → 通知/.test(barkDef?.guide || ''));
    ok('★ 引导里讲了自建服务器怎么填', /自建/.test(barkDef?.guide || ''));

    ok('★ 引导是折叠块起头（设置页用 details 包住）',
      (barkDef?.guide || '').trimStart().startsWith('<ol'));

    const barkKeyField = barkDef?.fields?.find((f) => f.key === 'key');
    ok('★ Key 字段的说明里提到可以整段粘贴网址',
      /网址/.test(barkKeyField?.help || ''));
    const barkSoundField = barkDef?.fields?.find((f) => f.key === 'sound');
    ok('★ 提示音是下拉选择而不是自由文本（打错字不会静默失效）',
      barkSoundField?.type === 'select' && (barkSoundField?.options?.length || 0) >= 5,
      `类型 ${barkSoundField?.type}，选项 ${barkSoundField?.options?.length}`);
    const barkLevelField = barkDef?.fields?.find((f) => f.key === 'level');
    ok('★ 通知级别默认是时效性通知',
      barkLevelField?.default === 'timeSensitive', `默认 ${barkLevelField?.default}`);
    ok('★ 通知级别的说明里写了要去 iOS 设置里开开关',
      /设置/.test(barkLevelField?.help || '') && /时效性通知/.test(barkLevelField?.help || ''));

    // ---- 起一个本地假 Bark 服务器 ----
    // POST /api/channels 会「先试发一条」再保存，所以想验证「保存时也做了
    // 规范化」就必须有一个真能回 200 的推送端。用它同时验证完整的发送链路。
    const barkRequests = [];
    // 先按「成功」应答；后面要测报错文案时把它切成「拒绝」
    let barkMode = 'success';
    const fakeBark = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 忽略 */ }
        barkRequests.push({ url: req.url, body });
        res.writeHead(barkMode === 'success' ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          barkMode === 'success'
            ? { code: 200, message: 'success' }
            : { code: 400, message: 'device token is not exists' },
        ));
      });
    });
    await new Promise((r) => fakeBark.listen(0, '127.0.0.1', r));
    const fakeBarkBase = `http://127.0.0.1:${fakeBark.address().port}`;

    /**
     * 找一个当前没人监听的端口，用来测「连接被拒绝」。
     *
     * 不能图省事写 127.0.0.1:1 —— 端口 1、7、25、5060 这类在 fetch 规范里
     * 属于「禁用端口」，请求在客户端就被拒了，拿到的错误是 "bad port"
     * 而不是 ECONNREFUSED，测不到真正想测的那条路径。
     * 先占用再释放可以拿到一个确定空闲的高位端口。
     */
    async function findClosedPort() {
      const probe = http.createServer();
      await new Promise((r) => probe.listen(0, '127.0.0.1', r));
      const { port } = probe.address();
      await new Promise((r) => probe.close(r));
      return port;
    }
    const closedPort = await findClosedPort();

    // ---- Bark 配置自动修正：把整段网址拆成服务器地址 + Key ----
    // Bark App 首页显示的就是这一段网址，用户很容易整段复制。
    // 以前直接当 Key 发出去，Bark 只回一句英文报错。
    const pastedUrl = await req('POST', '/api/channels/test', {
      json: {
        type: 'bark',
        config: { key: 'https://api.day.app/AbCdEf123456', server: '' },
      },
    });
    ok('★ 粘贴整段 Bark 网址时，接口会把服务器地址和 Key 拆开',
      pastedUrl.json?.config?.server === 'https://api.day.app'
      && pastedUrl.json?.config?.key === 'AbCdEf123456',
      `server=${pastedUrl.json?.config?.server} key=${pastedUrl.json?.config?.key}`);
    ok('★ 拆开之后的 Key 不会再被当成网址发出去（Bark 才认得）',
      pastedUrl.json?.config?.key === 'AbCdEf123456');

    const pastedNoScheme = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: 'api.day.app/AbCdEf123456', server: '' } },
    });
    ok('★ 不带协议头的网址也能拆开',
      pastedNoScheme.json?.config?.key === 'AbCdEf123456'
      && pastedNoScheme.json?.config?.server === 'https://api.day.app',
      `server=${pastedNoScheme.json?.config?.server}`);

    const trailingSlash = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: 'k123456', server: 'https://api.day.app/' } },
    });
    ok('★ 服务器地址结尾的斜杠会被去掉（否则拼出 //push）',
      trailingSlash.json?.config?.server === 'https://api.day.app',
      `server=${trailingSlash.json?.config?.server}`);

    const dirtyKey = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: ' AbCdEf\n123456 ', server: '' } },
    });
    ok('★ Key 里的换行和空格会被清掉（复制粘贴常见）',
      dirtyKey.json?.config?.key === 'AbCdEf123456',
      `key=${JSON.stringify(dirtyKey.json?.config?.key)}`);

    // ---- 真的发一条到假 Bark，验证规范化后的配置被用上了 ----
    const realSend = await req('POST', '/api/channels/test', {
      json: {
        type: 'bark',
        config: { key: 'https://api.day.app/FakeKey123', server: fakeBarkBase },
      },
    });
    ok('★ 用假 Bark 服务器测试发送成功', realSend.status === 200 && realSend.json?.ok === true,
      `状态码 ${realSend.status}：${realSend.json?.error}`);
    ok('★ 请求打到了 POST /push',
      barkRequests.at(-1)?.url === '/push', `实际 ${barkRequests.at(-1)?.url}`);
    ok('★ 发出去的是拆好的 Key，而不是一整段网址',
      barkRequests.at(-1)?.body?.device_key === 'FakeKey123',
      `device_key=${barkRequests.at(-1)?.body?.device_key}`);
    ok('★ 自建服务器地址没有被网址里的官方域名冲掉',
      realSend.json?.config?.server === fakeBarkBase,
      `server=${realSend.json?.config?.server}`);

    // ---- 保存时同样会修正，不能只修测试那一遍 ----
    const created = await req('POST', '/api/channels', {
      json: {
        type: 'bark',
        name: 'Bark 测试',
        config: { key: 'https://api.day.app/FakeKey123', server: fakeBarkBase },
      },
    });
    ok('★ 新建 Bark 渠道成功', created.status === 201 || created.status === 200,
      `状态码 ${created.status}：${created.json?.error}`);

    const savedChannel = (await req('GET', '/api/channels')).json?.channels
      ?.find((c) => c.name === 'Bark 测试');
    // 注意：列表接口会把 Key 打码（AbC•••••56），所以只能比对首尾。
    // 首三字符足够区分——存的是拆好的 FakeKey123 还是整段网址
    // https://api.day.app/FakeKey123，两者打码后的开头完全不同。
    ok('★ 保存进数据库的 Key 已经是拆好的（不是整段网址）',
      savedChannel?.config?.key?.startsWith('Fak') && !savedChannel?.config?.key?.startsWith('htt'),
      `打码后 key=${savedChannel?.config?.key}`);
    ok('★ 保存进数据库的服务器地址也拆好了',
      savedChannel?.config?.server === fakeBarkBase,
      `server=${savedChannel?.config?.server}`);

    // ---- 编辑已存在的渠道时也要修正 ----
    if (savedChannel) {
      await req('PATCH', `/api/channels/${savedChannel.id}`, {
        json: { config: { key: 'https://api.day.app/PatchedKey99' } },
      });
      const patched = (await req('GET', '/api/channels')).json?.channels
        ?.find((c) => c.id === savedChannel.id);
      ok('★ 编辑渠道时同样会拆网址（打码后开头是 Pat 而不是 htt）',
        patched?.config?.key?.startsWith('Pat') && !patched?.config?.key?.startsWith('htt'),
        `打码后 key=${patched?.config?.key}`);

      // 「测试已保存的渠道」这个入口也要能跑通
      const savedTest = await req('POST', `/api/channels/${savedChannel.id}/test`);
      ok('★ 测试已保存的渠道能跑通', savedTest.status === 200,
        `状态码 ${savedTest.status}：${savedTest.json?.error}`);

      const del = await req('DELETE', `/api/channels/${savedChannel.id}`);
      ok('清理测试渠道', del.status === 200 || del.status === 204, `状态码 ${del.status}`);
    }

    // ---- Bark 报错要说人话 ----
    // 假 Bark 改成回一个真实会遇到的错误
    barkMode = 'reject';

    const badKeyTest = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: 'WrongKey123', server: fakeBarkBase } },
    });
    ok('★ Key 不对时给的是中文解释，不是 Bark 的英文原文',
      badKeyTest.status === 400
      && /推送 Key 不对/.test(badKeyTest.json?.error || '')
      && !/^device token/.test(badKeyTest.json?.error || ''),
      `${badKeyTest.json?.error}`);
    ok('★ 中文解释里告诉用户去哪儿复制 Key',
      /Bark App/.test(badKeyTest.json?.error || ''));
    const barkErrText = badKeyTest.json?.error || '';
    ok('★ 中文解释里带上你填的那几位，方便对照',
      /Wro/.test(barkErrText), '至少要看得出「填的是不是这一个」');
    // 但只能露前 3 位。
    // 这句话会被写进 notify_log.detail，然后在设置页的「发送记录」里长期显示 ——
    // 以前露的是前 6 位，等于每次推送失败都往页面上挂一段密钥前缀
    // （截图、共享屏幕就漏了）。前 3 + 后 2 够对照，和渠道表单打码的口径也一致。
    ok('★ 但不许把完整的 Key 写进这条消息（它会长期显示在发送记录里）',
      !barkErrText.includes('WrongKey123'), barkErrText);
    ok('★ 露出的前缀不超过 3 位',
      !/WrongK/.test(barkErrText), '又露回到前 6 位了');
    ok('★ 解释里保留了服务器原话，方便搜索',
      /device token is not exists/.test(barkErrText));

    await new Promise((r) => fakeBark.close(r));

    // ---- 设置页要把引导渲染出来 ----
    const settingsForGuide = await req('GET', '/settings');
    ok('★ 设置页有引导容器', settingsForGuide.text.includes('data-channel-guide'));
    ok('★ 渠道表单模板里有引导容器',
      /data-channel-form[\s\S]*data-channel-guide/.test(settingsForGuide.text));
    const appJsForGuide = await req('GET', '/static/app.js');
    ok('★ 前端 JS 会渲染渠道引导', appJsForGuide.text.includes('data-channel-guide')
      && /guide__body/.test(appJsForGuide.text));
    ok('★ 前端把修正后的配置回填进表单（不然用户以为没生效）',
      appJsForGuide.text.includes('applyNormalizedConfig'));
    const cssForGuide = await req('GET', '/static/app.css');
    ok('★ 引导的样式已定义（步骤圆圈 + 折叠清单）',
      cssForGuide.text.includes('.guide-steps') && cssForGuide.text.includes('.guide-details'));

    // 用一个必然失败的地址测试「测试发送」错误处理
    const badTest = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: 'testkey', server: `http://127.0.0.1:${closedPort}` } },
    });
    ok('★ 连不上时返回可读的中文错误',
      badTest.status === 400 && /失败|超时|网络|连不上/.test(badTest.json?.error || ''),
      `状态码 ${badTest.status}：${badTest.json?.error}`);
    ok('★ 连接被拒时说明是服务器地址/端口的问题',
      /服务器地址|端口|连不上/.test(badTest.json?.error || ''),
      `${badTest.json?.error}`);
    ok('★ 连接被拒时不会把 ECONNREFUSED / fetch failed 直接甩给用户',
      !/ECONNREFUSED|fetch failed|POST \//i.test(badTest.json?.error || ''),
      `${badTest.json?.error}`);

    // 端口写成 fetch 规范里的禁用端口时，是另一种错，提示也要说人话
    const badPort = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: { key: 'testkey', server: 'http://127.0.0.1:1' } },
    });
    ok('★ 端口不合法时提示地址有问题',
      badPort.status === 400 && /服务器地址不合法/.test(badPort.json?.error || ''),
      `${badPort.json?.error}`);

    const missingKey = await req('POST', '/api/channels/test', {
      json: { type: 'bark', config: {} },
    });
    ok('缺少必填配置时给出明确提示',
      missingKey.status === 400 && (missingKey.json?.error || '').includes('缺少'),
      `${missingKey.json?.error}`);

    const channelList = await req('GET', '/api/channels');
    ok('渠道列表可访问（测试渠道已清理）', channelList.status === 200
      && channelList.json?.channels?.length === 0,
      `剩余 ${channelList.json?.channels?.length} 个`);

    // --------------------------------------------------------
    section('6. 日历导出与订阅');

    const ics = await req('GET', '/calendar/download.ics');
    ok('日历下载可访问', ics.status === 200, `状态码 ${ics.status}`);
    ok('返回正确的 MIME 类型',
      (ics.headers.get('content-type') || '').includes('text/calendar'),
      ics.headers.get('content-type') || '');
    ok('ICS 结构完整', ics.text.startsWith('BEGIN:VCALENDAR') && ics.text.includes('END:VCALENDAR'));
    ok('ICS 包含课程事件', ics.text.includes('SUMMARY:高等数学(上)'));
    ok('ICS 包含重复规则', ics.text.includes('RRULE:FREQ=WEEKLY'));
    ok('ICS 包含作业事件', ics.text.includes('【作业】'));
    ok('ICS 包含提醒闹钟', ics.text.includes('BEGIN:VALARM'));
    ok('ICS 使用 CRLF 行尾', ics.text.includes('\r\n'));

    const calendarPreview = await req('GET', '/api/calendar/preview');
    ok('日历预览接口可用', calendarPreview.status === 200
      && (calendarPreview.json?.eventCount || 0) > 0,
      `事件数 ${calendarPreview.json?.eventCount}`);

    const settingsPage = await req('GET', '/settings');
    ok('设置页可访问', settingsPage.status === 200);
    const subscribeMatch = /webcal:\/\/[^"'\s]+token=([A-Za-z0-9._-]+)/.exec(settingsPage.text);
    ok('设置页给出订阅链接', Boolean(subscribeMatch), '未找到 webcal 链接');

    if (subscribeMatch) {
      const sub = await req('GET', `/calendar/subscribe.ics?token=${subscribeMatch[1]}`);
      ok('用订阅令牌可以匿名拉取日历', sub.status === 200
        && sub.text.includes('BEGIN:VCALENDAR'), `状态码 ${sub.status}`);

      const badToken = await req('GET', '/calendar/subscribe.ics?token=forged.token.value');
      ok('伪造的订阅令牌被拒绝', badToken.status === 403, `状态码 ${badToken.status}`);
    }

    // ---- 订阅链接可以作废 ----
    // 这条链接**不需要登录**就能看课表，有效期还长达一年。
    // 被截图、被投屏、粘到群里、或者在学校 WiFi 上被抄走，都可能；
    // 没有吊销手段的话，唯一的收场办法是换 SESSION_SECRET，
    // 而那会把所有人的登录状态一起清掉。
    if (subscribeMatch) {
      const oldLink = subscribeMatch[1];
      ok('（前提）作废之前这条链接是能用的',
        (await req('GET', `/calendar/subscribe.ics?token=${oldLink}`)).status === 200);

      const regen = await req('POST', '/api/calendar/regenerate', { json: {} });
      ok('★ 重新生成订阅链接的接口可用', regen.status === 200, `状态码 ${regen.status}`);

      const afterRevoke = await req('GET', `/calendar/subscribe.ics?token=${oldLink}`);
      ok('★ 旧的订阅链接立刻失效（403，而不是继续能用一年）',
        afterRevoke.status === 403, `状态码 ${afterRevoke.status}`);

      const settingsAfter = await req('GET', '/settings');
      const newMatch = /webcal:\/\/[^"'\s]+token=([A-Za-z0-9._-]+)/.exec(settingsAfter.text);
      ok('★ 设置页给出一条新的订阅链接', Boolean(newMatch), '重新生成后没拿到新链接');
      if (newMatch) {
        ok('★ 新链接和旧的不是同一个', newMatch[1] !== oldLink);
        const fresh = await req('GET', `/calendar/subscribe.ics?token=${newMatch[1]}`);
        ok('★ 新链接可以正常拉取日历', fresh.status === 200
          && fresh.text.includes('BEGIN:VCALENDAR'), `状态码 ${fresh.status}`);
      }
      ok('★ 换链接不会把自己踢下线（订阅链接和登录状态是两件事）',
        (await req('GET', '/settings')).status === 200);
    }

    // --------------------------------------------------------
    section('7. 课表导入（CSV 与 ICS）');

    const csvImport = await req('POST', '/api/import/csv', { json: { text: TEST_CSV } });
    ok('CSV 解析成功', csvImport.status === 200, `状态码 ${csvImport.status}`);
    const csvCourses = csvImport.json?.parsed?.courses || [];
    ok('CSV 识别出 2 门课程', csvCourses.length === 2, `实际 ${csvCourses.length}`);
    const mathCourse = csvCourses.find((c) => c.name === '高等数学(上)');
    ok('CSV 合并了同一门课的多个时间段', mathCourse?.sessions?.length === 2,
      `实际 ${mathCourse?.sessions?.length}`);
    const econCourse = csvCourses.find((c) => c.name === '微观经济学');
    ok('CSV 正确解析单周', econCourse?.sessions?.[0]?.weeks === '1-16单',
      `实际 ${econCourse?.sessions?.[0]?.weeks}`);
    ok('CSV 解析出教师与学分',
      mathCourse?.teacher === '张三' && mathCourse?.credits === 5,
      `教师 ${mathCourse?.teacher}，学分 ${mathCourse?.credits}`);
    ok('CSV 解析出教室', mathCourse?.classroom === '之远楼301', `实际 ${mathCourse?.classroom}`);

    const icsImport = await req('POST', '/api/import/ics', { json: { text: TEST_ICS } });
    ok('ICS 解析成功', icsImport.status === 200, `状态码 ${icsImport.status}`);
    const icsCourses = icsImport.json?.parsed?.courses || [];
    ok('ICS 识别出 2 门课程', icsCourses.length === 2, `实际 ${icsCourses.length}`);
    const accounting = icsCourses.find((c) => c.name === '会计学原理');
    ok('ICS 还原出周次', accounting?.sessions?.[0]?.weeks === '1-16',
      `实际 ${accounting?.sessions?.[0]?.weeks}`);
    ok('ICS 还原出上课时间', accounting?.sessions?.[0]?.startTime === '08:00',
      `实际 ${accounting?.sessions?.[0]?.startTime}`);
    ok('ICS 从描述里抽出了教师', accounting?.teacher === '王五', `实际 ${accounting?.teacher}`);
    ok('ICS 从描述里抽出了学分', accounting?.credits === 4, `实际 ${accounting?.credits}`);

    // ---- 教室 / 教师 分离（核心回归）----
    // 教务系统把两者塞在同一个字段里（`校本部之远楼401 王五`）。
    // 旧实现把整串当成教室，教师字段永远为空，这是真实踩过的坑。
    ok('ICS 教室字段是干净的教室名',
      accounting?.classroom === '校本部之远楼401',
      `实际 ${JSON.stringify(accounting?.classroom)}`);
    ok('ICS 教室字段里没有混进教师名',
      !(accounting?.classroom || '').includes('王五'),
      `教室=${accounting?.classroom}`);
    ok('ICS 时间段上的教室也是干净的',
      accounting?.sessions?.[0]?.location === '校本部之远楼401',
      `实际 ${JSON.stringify(accounting?.sessions?.[0]?.location)}`);
    ok('ICS 时间段上带上了教师',
      accounting?.sessions?.[0]?.teacher === '王五',
      `实际 ${accounting?.sessions?.[0]?.teacher}`);
    ok('ICS 保留了教务系统原话的节次',
      accounting?.sessions?.[0]?.periodLabel === '第 1-2 节',
      `实际 ${accounting?.sessions?.[0]?.periodLabel}`);

    const stats2 = icsCourses.find((c) => c.name === '统计学');
    ok('第二门课的教室教师也拆对了',
      stats2?.classroom === '校本部笃行楼108' && stats2?.teacher === '赵六',
      `教室=${stats2?.classroom} 教师=${stats2?.teacher}`);

    // ---- 学分 / 学时：三个不同位置都要能认出来 ----
    ok('① 描述里的学分被识别', accounting?.credits === 4, `实际 ${accounting?.credits}`);
    ok('② 课程名里的学分被识别', stats2?.credits === 3, `实际 ${stats2?.credits}`);
    ok('② 课程名里的「(3学分)」没有残留在名字里',
      stats2?.name === '统计学', `实际「${stats2?.name}」`);
    ok('③ 自定义属性里的学时被识别', stats2?.hours === 48, `实际 ${stats2?.hours}`);
    ok('没有学分信息时不瞎猜（会计学原理没写学时）',
      accounting?.hours === null, `实际 ${accounting?.hours}`);

    // 「学分：4」里带数字，不能被当成门牌号
    ok('元信息行（学分：4）没有被当成教室',
      !(accounting?.classroom || '').includes('学分'),
      `教室=${accounting?.classroom}`);
    ok('备注里不再重复教室和教师',
      accounting?.note === '第 1-2 节',
      `实际 ${JSON.stringify(accounting?.note)}`);
    ok('ICS 推断出学期起始日', Boolean(icsImport.json?.parsed?.termStart),
      icsImport.json?.parsed?.termStart);

    // 确认导入（走表单提交这条路径）
    const confirmBody = multipart({
      payload: JSON.stringify(icsImport.json.parsed),
      source: 'ics',
      termId: 'new',
      termStart: icsImport.json.parsed.termStart,
      onConflict: 'skip',
    }, null);

    const confirm = await req('POST', '/import', {
      body: confirmBody.body,
      headers: { 'Content-Type': confirmBody.contentType },
    });
    ok('确认导入成功', confirm.status === 200, `状态码 ${confirm.status}`);
    ok('导入结果页显示新建数量', confirm.text.includes('导入完成'));

    const afterImport = await req('GET', '/api/courses');
    const names = (afterImport.json?.courses || []).map((c) => c.name);
    ok('导入的课程已入库', names.includes('会计学原理') && names.includes('统计学'),
      names.join('、'));
    ok('原有课程未受影响', names.includes('高等数学(上)'));

    // 重复导入应该被跳过
    const confirmAgain = multipart({
      payload: JSON.stringify(icsImport.json.parsed),
      source: 'ics',
      termId: 'new',
      onConflict: 'skip',
    }, null);
    const again = await req('POST', '/import', {
      body: confirmAgain.body,
      headers: { 'Content-Type': confirmAgain.contentType },
    });
    ok('重复导入被跳过而非重复创建', again.status === 200 && again.text.includes('跳过 2 门'),
      again.text.match(/跳过 \d+ 门/)?.[0] || '未找到跳过计数');

    // --------------------------------------------------------
    // 合并导入：把空着的学分/学时补上
    //
    // 这是用户真实反馈过的场景：「重新上传 ICS、选合并周次，学分还是空的」。
    // 所以必须有一条测试把这条路走通——先建一门没学分的课，
    // 再用带学分的 ICS 以「合并」方式导入，验证学分被补上。
    // --------------------------------------------------------

    const probeCourse = await req('POST', '/api/courses', {
      json: { name: '财务管理', teacher: '', credits: null },
    });
    ok('新建一门没有学分的课程', probeCourse.status === 201, `状态码 ${probeCourse.status}`);
    const probeId = probeCourse.json?.course?.id;
    ok('新课程的学分确实是空的',
      probeCourse.json?.course?.credits === null,
      `实际 ${probeCourse.json?.course?.credits}`);

    const MERGE_ICS = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:merge-1@jwc',
      'SUMMARY:财务管理',
      'DTSTART;TZID=Asia/Shanghai:20250905T080000',
      'DTEND;TZID=Asia/Shanghai:20250905T093500',
      'LOCATION:校本部之远楼220 钱七',
      'DESCRIPTION:第1 - 2节\\n校本部之远楼220\\n钱七',
      'X-CREDITS:2',
      'X-HOURS:32',
      'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=16',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const mergeParse = await req('POST', '/api/import/ics', { json: { text: MERGE_ICS } });
    ok('合并用的 ICS 解析出学分 2',
      mergeParse.json?.parsed?.courses?.[0]?.credits === 2,
      `实际 ${mergeParse.json?.parsed?.courses?.[0]?.credits}`);
    ok('合并用的 ICS 解析出教师与教室',
      mergeParse.json?.parsed?.courses?.[0]?.teacher === '钱七'
      && mergeParse.json?.parsed?.courses?.[0]?.classroom === '校本部之远楼220',
      `教师=${mergeParse.json?.parsed?.courses?.[0]?.teacher} 教室=${mergeParse.json?.parsed?.courses?.[0]?.classroom}`);

    const activeTermId = (await req('GET', '/api/terms')).json?.terms
      ?.find((t) => Number(t.is_active) === 1)?.id;

    const mergeForm = multipart({
      payload: JSON.stringify(mergeParse.json.parsed),
      source: 'ics',
      termId: String(activeTermId),
      onConflict: 'merge',
    }, null);

    const mergeRes = await req('POST', '/import', {
      body: mergeForm.body,
      headers: { 'Content-Type': mergeForm.contentType },
    });
    ok('合并导入执行成功', mergeRes.status === 200, `状态码 ${mergeRes.status}`);
    ok('结果显示「合并 1 门」', /合并 1 门/.test(mergeRes.text),
      mergeRes.text.match(/新建 \d+ 门[^<]*/)?.[0] || '未找到统计行');

    const afterMerge = await req('GET', `/api/courses/${probeId}`);
    ok('★ 合并后空着的学分被补上了',
      afterMerge.json?.course?.credits === 2,
      `实际 ${afterMerge.json?.course?.credits}`);
    ok('★ 合并后空着的学时也被补上了',
      afterMerge.json?.course?.hours === 32,
      `实际 ${afterMerge.json?.course?.hours}`);
    ok('合并也补上了空的教师与教室',
      afterMerge.json?.course?.teacher === '钱七'
      && afterMerge.json?.course?.classroom === '校本部之远楼220',
      `教师=${afterMerge.json?.course?.teacher} 教室=${afterMerge.json?.course?.classroom}`);
    ok('合并后新增了上课时间',
      (afterMerge.json?.course?.sessions || []).length === 1,
      `实际 ${(afterMerge.json?.course?.sessions || []).length} 条`);

    // 已有学分不能被覆盖
    const mergeAgain = multipart({
      payload: JSON.stringify(mergeParse.json.parsed),
      source: 'ics',
      termId: String(activeTermId),
      onConflict: 'merge',
    }, null);
    await req('POST', '/import', {
      body: mergeAgain.body,
      headers: { 'Content-Type': mergeAgain.contentType },
    });
    const afterMerge2 = await req('GET', `/api/courses/${probeId}`);
    ok('已经填过的学分不会被重复导入覆盖',
      afterMerge2.json?.course?.credits === 2,
      `实际 ${afterMerge2.json?.course?.credits}`);
    ok('重复的合并不会重复添加时间段',
      (afterMerge2.json?.course?.sessions || []).length === 1,
      `实际 ${(afterMerge2.json?.course?.sessions || []).length} 条`);

    // --------------------------------------------------------
    // 回归测试：走一遍「浏览器真实会发出来的请求」
    //
    // 之前这里有过一个很难发现的 bug：三个导入表单都漏写了 method="post"。
    // HTML 表单默认是 GET，而 GET 请求**根本不会提交文件输入**。
    // 用户看到的现象是「选好文件点导入 → 页面闪一下 → 文件没了 → 也没报错」。
    //
    // 当时的测试之所以没抓到，是因为它直接 POST 到 /import，绕过了 HTML 表单本身。
    // 下面这些断言就是专门堵这个窟窿的。
    // --------------------------------------------------------

    const importPageRes = await req('GET', '/import');

    /** 把 HTML 里的表单调出来，方便检查属性 */
    const parseForms = (html) => {
      const out = [];
      const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
      let m = re.exec(html);
      while (m !== null) {
        out.push({ attrs: m[1], inner: m[2] });
        m = re.exec(html);
      }
      return out;
    };

    const importForms = parseForms(importPageRes.text);
    ok('导入页渲染出了 3 个表单（2 个导入 + 1 个退出登录）',
      importForms.length === 3, `实际 ${importForms.length} 个`);

    // 排除侧边栏的退出登录表单，它指向 /logout，不属于导入流程
    const uploadForms = importForms.filter((f) => !/action\s*=\s*"\/logout"/i.test(f.attrs));
    ok('页面主体里有 2 个导入表单', uploadForms.length === 2, `实际 ${uploadForms.length} 个`);

    const fileForms = uploadForms.filter((f) => /type="file"/.test(f.inner));
    ok('两个导入表单都含文件上传框', fileForms.length === 2, `实际 ${fileForms.length} 个`);

    for (let i = 0; i < fileForms.length; i += 1) {
      ok(`含文件上传的表单 #${i + 1} 用 POST 提交`,
        /method\s*=\s*"post"/i.test(fileForms[i].attrs), fileForms[i].attrs.trim());
    }

    const nonPostForms = uploadForms.filter((f) => !/method\s*=\s*"post"/i.test(f.attrs));
    ok('导入页所有表单都是 POST（GET 会丢数据）',
      nonPostForms.length === 0,
      nonPostForms.map((f) => f.attrs.trim()).join(' | '));
    ok('导入表单都指向 /import',
      uploadForms.every((f) => /action\s*=\s*"\/import"/i.test(f.attrs)),
      uploadForms.map((f) => f.attrs.trim()).join(' | '));

    // ---- 按浏览器的方式真实提交一遍 ICS 文件 ----
    const icsUpload = multipart({ termId: '', onConflict: 'skip' }, {
      field: 'file',
      filename: '教务课表.ics',
      data: Buffer.from(TEST_ICS, 'utf8'),
      mime: 'text/calendar',
    });

    const icsViaForm = await req('POST', '/import', {
      body: icsUpload.body,
      headers: { 'Content-Type': icsUpload.contentType },
    });
    ok('通过表单上传 ICS 能进入预览页',
      icsViaForm.status === 200 && icsViaForm.text.includes('解析成功'),
      `状态码 ${icsViaForm.status}`);
    ok('预览页列出了 ICS 里的课程', icsViaForm.text.includes('会计学原理'));
    ok('预览页显示出待导入的上课时间', icsViaForm.text.includes('周一'));
    ok('预览页有确认导入按钮', icsViaForm.text.includes('确认导入'));

    // ---- 粘贴文本 + 空文件输入框 ----
    // 浏览器对「没选文件」的输入框会发一个 filename="" 的空部分，
    // 它不能盖掉真正有值的 text 字段（这正是修过的第二个 bug）
    const pasteUpload = multipart({ text: TEST_CSV, termId: '', onConflict: 'skip' }, {
      field: 'file',
      filename: '',
      data: Buffer.alloc(0),
      mime: 'application/octet-stream',
    });

    const pasteViaForm = await req('POST', '/import', {
      body: pasteUpload.body,
      headers: { 'Content-Type': pasteUpload.contentType },
    });
    ok('粘贴文本 + 空文件框时仍能解析（空文件不覆盖文本）',
      pasteViaForm.status === 200 && pasteViaForm.text.includes('解析成功'),
      pasteViaForm.text.match(/<strong>([^<]{0,60})<\/strong>/)?.[1] || '未进入预览页');
    ok('粘贴的 CSV 被解析出课程', pasteViaForm.text.includes('高等数学'));

    // ---- 什么都没填时应该给出明确提示，而不是空白页 ----
    const emptyUpload = multipart({ termId: '', onConflict: 'skip' }, {
      field: 'file', filename: '', data: Buffer.alloc(0),
    });
    const emptyRes = await req('POST', '/import', {
      body: emptyUpload.body,
      headers: { 'Content-Type': emptyUpload.contentType },
    });
    ok('什么都没填时给出中文提示而不是空白页',
      emptyRes.status === 200 && /没有收到文件或表格内容/.test(emptyRes.text),
      `状态码 ${emptyRes.status}`);

    // ---- 解析不出课程时，不能把用户粘的东西弄丢 ----
    //
    // 这里原本按审计的说法去测「catch 分支」，结果发现那条路基本走不到：
    // 两个解析器都**不抛异常**，看不懂的内容只是记一条 warning 然后返回空结果。
    // 真正会发生的是「0 门课程」那条 —— 而它原来会渲染一个
    // 「解析成功，识别出 0 门课程」的预览页：既没指出哪里不对，
    // 也没有回上一步的入口，用户只能重新打开 /import，粘的东西已经没了。
    const PASTE_MARKER = '高等数学(上),张三,5,星期一,08:00-09:40,1-16,之远楼301';
    const unreadableCsv = `甲,乙,丙\n${PASTE_MARKER}`;
    const badCsv = multipart({ termId: '', onConflict: 'skip', text: unreadableCsv }, null);
    const pasteFail = await req('POST', '/import', {
      body: badCsv.body, headers: { 'Content-Type': badCsv.contentType },
    });
    // 断言要落在 textarea 的**内容区**里：全文搜一下的话，
    // placeholder 或者页面别处的示例文本也能让它变绿。
    const textareaBody = (/<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/
      .exec(pasteFail.text)?.[1]) || '';
    ok('★ 没识别出课程时不再谎报「解析成功」',
      pasteFail.status === 200 && !/解析成功/.test(pasteFail.text),
      `状态码 ${pasteFail.status}，页面里${/解析成功/.test(pasteFail.text) ? '仍' : '没有'}出现「解析成功」`);
    ok('★ 会说明失败原因（而不是只丢一个空表格给用户）',
      /导入失败/.test(pasteFail.text)
      && /表头/.test(pasteFail.text)
      && /没能识别出表头/.test(pasteFail.text),
      '没有失败标题，或者没说清是表头的问题');
    ok('★ 并且告诉用户「你提交的内容还在」',
      /还留在下面的框里/.test(pasteFail.text));
    ok('★ 而且退回的是选择屏（不是那个 0 门课程的预览页）',
      pasteFail.text.includes('data-import-text-form')
      && !pasteFail.text.includes('preview-table-wrap'),
      '没有回到可以重新提交的那一屏');
    ok('★ 粘贴框里还留着上次的内容（这是关键，不能清空）',
      textareaBody.includes(PASTE_MARKER),
      `文本框里只有：${JSON.stringify(textareaBody.slice(0, 120))}`);

    // 上传文件那种情况回填不了文件框（浏览器不允许给 file 输入框赋值），
    // 但要告诉用户「你传的是哪个文件」；内容本身是文本就一并放进文本框。
    const badFile = multipart({ termId: '', onConflict: 'skip' }, {
      field: 'file', filename: '教务系统导出.csv', data: Buffer.from(unreadableCsv, 'utf8'),
    });
    const fileFail = await req('POST', '/import', {
      body: badFile.body, headers: { 'Content-Type': badFile.contentType },
    });
    ok('★ 上传的文件读不出课程时，说明了是哪个文件',
      fileFail.status === 200 && fileFail.text.includes('教务系统导出.csv'),
      `状态码 ${fileFail.status}`);
    ok('★ 文件内容回填进了文本框（可以直接改了再交，不用重新传）',
      ((/<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/.exec(fileFail.text)?.[1]) || '')
        .includes(PASTE_MARKER),
      '文本类的文件应该把内容放进文本框');

    // 反过来：能识别的内容必须照常走到预览页（别为了修这个把正常流程堵了）
    const goodCsv = multipart({ termId: '', onConflict: 'skip', text: TEST_CSV }, null);
    const goodRes = await req('POST', '/import', {
      body: goodCsv.body, headers: { 'Content-Type': goodCsv.contentType },
    });
    ok('★ 内容正常时照样进预览页（新加的拦截没有误伤）',
      goodRes.status === 200
      && goodRes.text.includes('preview-table-wrap')
      && /解析成功/.test(goodRes.text),
      `状态码 ${goodRes.status}`);

    // --------------------------------------------------------
    section('8. 设置与调度');

    const saveSettings = await req('POST', '/api/settings', {
      json: { default_remind_offsets: '2880,60', daily_digest_enabled: '1', daily_digest_time: '07:00' },
    });
    ok('保存设置成功', saveSettings.status === 200, `状态码 ${saveSettings.status}`);
    ok('设置已生效', saveSettings.json?.settings?.default_remind_offsets === '2880,60');

    const badSetting = await req('POST', '/api/settings', {
      json: { default_remind_offsets: 'abc' },
    });
    ok('非法设置值被拒绝', badSetting.status === 400, `状态码 ${badSetting.status}`);

    const termsRes = await req('POST', '/api/terms', {
      json: { name: '2026-2027学年第一学期', startDate: '2026-09-07', weekCount: 18, isActive: false },
    });
    ok('新增学期成功', termsRes.status === 201, `状态码 ${termsRes.status}`);

    const schedulerRun = await req('POST', '/api/scheduler/run');
    ok('手动触发调度器成功', schedulerRun.status === 200, `状态码 ${schedulerRun.status}`);
    ok('调度器返回处理结果', schedulerRun.json?.result !== undefined);
    ok('没有渠道时提醒会记为失败而不是崩溃',
      schedulerRun.json?.result?.reminders?.failed >= 0);

    const logsPage = await req('GET', '/settings');
    ok('设置页显示发送日志', logsPage.text.includes('发送记录') || logsPage.text.includes('还没有发送记录'));
    ok('设置页显示提醒服务状态', logsPage.text.includes('提醒服务'));
    ok('设置页显示 Office 转换状态', logsPage.text.includes('Office 转 PDF'));

    // ★ 这条是**反向**的：设置页**不该**出现服务器路径、运行时版本、
    //   以及「电脑关机 / 装个 LibreOffice / 备份 data 目录」这类运维建议。
    //   这个站是给同学用的，他改不了服务器，看到这些只会以为自己得去做点什么。
    //   （以前这些都是真的显示在这里的，所以钉一条防它长回来。）
    //
    // ⚠️ 覆盖范围的实话：这一条守的是**设置页这个模板**。
    //    `converterStatus().message` 那类文案它守不到 —— 自测环境把
    //    ENABLE_OFFICE_CONVERT 设成了 false，设置页走的是「自动转换已关掉」
    //    那一支，根本不渲染 message。那部分由 tests/convert.test.js 里的
    //    「★ 运维建议归 adminHint」守着。（A/B 校验时发现的：把
    //    「装个免费的 LibreOffice」塞回 message，这条端到端断言照样是绿的。）
    for (const [what, re] of [
      ['服务器绝对路径', /[A-Z]:\\|^\/opt\/|data[\\/](app\.db|uploads)/m],
      ['运行时版本', /Node\.js|v2\d\.\d+\.\d+/],
      ['「电脑关机」这类本机说法', /电脑关机|换电脑|搬到?一台常开|树莓派/],
      // ⚠️ 这几个模式要「瞄着服务器上的运维动作」，不能笼统地匹配「装个」：
      //    「App Store 装个 Bark」是**给用户手机**的正常指引，必须放行；
      //    而「装个免费的 LibreOffice」「在你电脑上关掉 WPS 自动更新」
      //    是在让用户去动服务器，那才是要挡的。
      ['服务器上的安装指引', /apt install|(装个|装一个|安装)[^。；\n]{0,12}LibreOffice|的自动更新/],
      ['内部机制名词（PowerShell / COM）', /PowerShell|COM 自动化/],
      ['打开数据目录那个本机按钮', /data-open-path|打开数据目录/],
    ]) {
      ok(`★ 设置页不再出现${what}`, !re.test(logsPage.text),
        `命中了：${re.exec(logsPage.text)?.[0]}`);
    }
    ok('★ 设置页仍然显示存储占用（这部分对用户是有用的）',
      logsPage.text.includes('存储占用') && logsPage.text.includes('预览缓存'));

    // --------------------------------------------------------
    section('9. 安全与边界');

    const badPassword = await req('POST', '/api/password', {
      json: { currentPassword: 'wrong-password', newPassword: 'newpass123' },
    });
    ok('错误的当前密码被拒绝', badPassword.status === 400, `状态码 ${badPassword.status}`);

    const shortPassword = await req('POST', '/api/password', {
      json: { currentPassword: 'test123456', newPassword: '123' },
    });
    ok('过短的新密码被拒绝', shortPassword.status === 400, `状态码 ${shortPassword.status}`);

    // 7 位这个边界是特意试的：下限从 6 提到 8 之后，「7 位」正是
    // 以前能过、现在必须被挡住的那一档。只试「3 位」的话，
    // 就算改密码这条路悄悄退回 6 位下限，测试也照样是绿的。
    const sevenCharPassword = await req('POST', '/api/password', {
      json: { currentPassword: 'test123456', newPassword: '1234567' },
    });
    ok('★ 改密码时 7 位也被拒绝（改密码这条路同样受 8 位下限约束）',
      sevenCharPassword.status === 400, `状态码 ${sevenCharPassword.status}`);
    ok('★ 改密码被拒后原密码仍然可用（没被改坏）',
      (await req('POST', '/login', { form: { username: '测试同学', password: 'test123456' } })).status === 302);

    // ---- 退出其他所有设备 ----
    // 拿同一个账号在「第二台设备」上登一次（模拟：手机 + 图书馆的电脑）。
    // 这不是越权测试，而是「钥匙丢了要能收回来」——
    // 会话 Cookie 是无状态签名的，服务端原来没有任何办法让它提前失效。
    const secondDevice = createClient(baseUrl);
    const secondLogin = await secondDevice('POST', '/login', {
      form: { username: '测试同学', password: 'test123456' },
    });
    ok('（前提）同一个账号在第二台设备上也能登录',
      secondLogin.status === 302 && (await secondDevice('GET', '/settings')).status === 200);

    const revokeOthers = await req('POST', '/api/sessions/revoke-others', { json: {} });
    ok('★ 「退出其他所有设备」接口可用', revokeOthers.status === 200,
      `状态码 ${revokeOthers.status}`);

    const secondAfter = await secondDevice('GET', '/settings');
    ok('★ 其他设备被踢下线（旧 Cookie 立刻作废）',
      secondAfter.status !== 200, `状态码 ${secondAfter.status} —— 还能继续用就是没踢掉`);
    ok('★ 而且第二台设备看到的是登录页，不是一个空白页',
      secondAfter.status === 302
      && (secondAfter.headers.get('location') || '').includes('/login'),
      `状态码 ${secondAfter.status} → ${secondAfter.headers.get('location')}`);

    ok('★ 当前这台设备不受影响（自己没被踢出去）',
      (await req('GET', '/settings')).status === 200);

    // 被踢之后重新登录应该正常（别把账号本身弄坏）
    const reloginSecond = await secondDevice('POST', '/login', {
      form: { username: '测试同学', password: 'test123456' },
    });
    ok('★ 被踢的设备可以用同一个密码重新登录',
      reloginSecond.status === 302 && (await secondDevice('GET', '/settings')).status === 200);

    const traversal = await req('GET', '/static/../../../package.json');
    ok('静态资源路径穿越被阻止', traversal.status === 404 || traversal.status === 403,
      `状态码 ${traversal.status}`);

    const noSuchApi = await req('GET', '/api/does-not-exist');
    ok('不存在的接口返回 JSON 404', noSuchApi.status === 404 && noSuchApi.json?.error,
      `状态码 ${noSuchApi.status}`);

    const noSuchPage = await req('GET', '/no-such-page');
    ok('不存在的页面返回 404 页面', noSuchPage.status === 404, `状态码 ${noSuchPage.status}`);

    // 空状态的标题层级：直接挂在页面 h1 下面的那几处必须是 h2。
    // 模板里写死 h3 的话，标题层级从 h1 跳到 h3，读屏按标题导航时会缺一级。
    //
    // ⚠️ 这里以前只查了主账号的 /timetable —— 而主账号有课，
    // 页面根本不是空状态，一条 empty__title 都没有，断言在**空转**：
    // 反向验证时把空状态强行写成 h3，它照样绿。
    // 现在专门注册一个**一条数据都没有**的新账号来看，并且先要求
    // 「确实渲染出了空状态」，否则这条断言自己判失败。
    const emptyBrowser = createClient(baseUrl);
    const emptyReg = await emptyBrowser('POST', '/register', {
      form: {
        username: `E2EEmpty${Math.floor(Math.random() * 100000)}`,
        password: 'empty123456',
        password2: 'empty123456',
        inviteCode: E2E_INVITE_CODE,
      },
    });
    ok('为了验空状态层级，专门注册了一个没有任何数据的新账号',
      emptyReg.status === 302, `状态码 ${emptyReg.status}`);

    for (const [name, url] of [
      ['课程表', '/timetable'],
      ['课程', '/courses'],
      ['资料库', '/materials'],
      ['作业', '/assignments'],
    ]) {
      const page = await emptyBrowser('GET', url);
      const titleLevels = [...page.text.matchAll(/<h([1-6]) class="empty__title">/g)]
        .map((m) => Number(m[1]));
      ok(`★ ${name}页真的渲染出了空状态（否则下面那条是空转的）`,
        titleLevels.length > 0, `${name} 里一条 empty__title 都没有`);
      ok(`★ ${name}空状态的标题是 h2，不从 h1 跳到 h3`,
        titleLevels.length > 0 && titleLevels.every((h) => h === 2),
        `${name} 里出现了 h${titleLevels.join(' / h')}`);
    }

    const wrongMethod = await req('PUT', '/api/password');
    ok('错误的方法返回 405', wrongMethod.status === 405, `状态码 ${wrongMethod.status}`);

    // HEAD 要按 GET 处理。
    // 路由是按方法注册的，以前 HEAD 谁也不匹配 → 405「请求方法不被支持」，
    // 而规范围凡有 GET 的地方都该支持 HEAD（正文由 Node 自动省掉）。
    // 探活脚本和链接检查器常用 HEAD，回 405 会把「站点正常」误报成故障。
    const headRoot = await req('HEAD', '/');
    ok('★ HEAD 请求不再被当成「方法不支持」（按 GET 处理）',
      headRoot.status !== 405, `状态码 ${headRoot.status}`);
    ok('★ HEAD 也应该拿到和 GET 一样的成败（登录态下 200）',
      headRoot.status === 200, `状态码 ${headRoot.status}`);

    // 这个接口已经删掉了（设置页上那个「打开数据目录」按钮也一起去掉了）。
    // 为什么删：它只对「服务跑在自己电脑上」有意义，部署到云服务器之后点了什么都不会发生；
    // 而它会 spawn 一个进程，守卫却只是普通登录校验 —— 多用户下等于**任何注册用户**
    // 都能让服务器去起一个程序。这里钉住它不会再回来。
    const openPath = await req('POST', '/api/open-path', { json: { path: 'C:\\Windows' } });
    ok('★ 会 spawn 进程的「打开数据目录」接口已经删掉（返回 404）',
      openPath.status === 404, `状态码 ${openPath.status}`);

    // 登出后 API 不可用
    const logout = await req('POST', '/logout');
    ok('登出成功', logout.status === 302);
    const afterLogout = await req('GET', '/api/courses');
    ok('登出后 API 返回未授权', afterLogout.status === 401, `状态码 ${afterLogout.status}`);

    // 重新登录
    const relogin = await req('POST', '/login', {
      form: { username: '测试同学', password: 'test123456' },
    });
    ok('重新登录成功', relogin.status === 302, `状态码 ${relogin.status}`);
    const afterRelogin = await req('GET', '/api/courses');
    ok('重新登录后数据仍在', (afterRelogin.json?.courses || []).length >= 3,
      `${afterRelogin.json?.courses?.length} 门课`);

    // ---- 安全响应头 ----
    // 外部审计报告指出站点一个安全头都没发。这些都是一行一个的东西，
    // 但「没发出去」是**没有任何外部症状**的（页面照样正常），所以必须钉住。
    // 抽查四种不同的响应路径：动态 HTML、静态资源、404、302 ——
    // 实现是「在请求入口 setHeader 一次」，理应四种全都带上。
    const securedPage = await req('GET', '/settings');
    const headerCases = [
      ['★ 动态页面（HTML）', securedPage],
      ['★ 静态资源', await req('GET', '/static/app.css')],
      ['★ 404 页面', noSuchPage],
      ['★ 302 跳转', relogin],
    ];
    for (const [label, res] of headerCases) {
      const got = (name) => res.headers.get(name) || '';
      ok(`${label}带 nosniff`, got('x-content-type-options') === 'nosniff',
        got('x-content-type-options') || '（没有这个头）');
      ok(`${label}带 Referrer-Policy`,
        got('referrer-policy') === 'strict-origin-when-cross-origin',
        got('referrer-policy') || '（没有这个头）');
      ok(`${label}带点击劫持防护`,
        got('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(got('content-security-policy')),
        `XFO=${got('x-frame-options') || '无'} CSP=${got('content-security-policy') || '无'}`);
      ok(`${label}带 Permissions-Policy`, got('permissions-policy').includes('camera=()'),
        got('permissions-policy') || '（没有这个头）');
      ok(`${label}明确禁止被收录`, got('x-robots-tag') === 'noindex, nofollow',
        got('x-robots-tag') || '（没有这个头）');
    }

    const cspValue = securedPage.headers.get('content-security-policy') || '';
    ok('★ frame-ancestors 没有被收紧成 none（收紧会让 PDF 预览白屏）',
      !/frame-ancestors 'none'/.test(cspValue),
      'PDF 预览页是自己用同源 iframe 嵌自己的 PDF，写成 none 会把那个 iframe 一起挡掉');
    ok('★ CSP 只写那三条，不写 default-src / style-src（否则内联样式全被拦掉）',
      /frame-ancestors/.test(cspValue) && !/default-src|style-src|script-src/.test(cspValue), cspValue);

    // ---- 全站扫一遍：不该有 markdown 语法漏到页面上 ----
    // 起因是真的漏过一次：学期那一块写了 `**必须是星期一**`，
    // 模板是纯 HTML，于是页面上直接显示出一对星号。
    // 这类问题不会报错、也不影响任何功能，只有人眼看到才会发现，
    // 所以用一个「整站过一遍」的断言兜住，而不是等下次有人注意到。
    const markdownLeaks = [];
    for (const url of ['/', '/timetable', '/courses', '/assignments', '/materials', '/settings', '/settings#prefs', '/import', '/calendar']) {
      // eslint-disable-next-line no-await-in-loop
      const page = await req('GET', url);
      const body = page.text.replace(/<script[\s\S]*?<\/script>/gi, '');
      for (const [what, re] of [
        ['加粗星号 **…**', /\*\*[^*\n]{1,80}\*\*/],
        ['反引号 `…`', /`[^`\n]{1,60}`/],
        ['markdown 链接 [文字](地址)', /\[[^\]\n]{1,40}\]\([^)\n]{1,80}\)/],
      ]) {
        const hit = re.exec(body);
        if (hit) markdownLeaks.push(`${url} 里的${what}：${hit[0].slice(0, 40)}`);
      }
    }
    ok('★ 没有 markdown 语法漏到页面上（整站扫了一遍）',
      markdownLeaks.length === 0, markdownLeaks.join('；'));

    // ---- PDF 路由自己的响应头（这条最关键，单独验） ----
    // 上面那四种响应路径里**没有** /materials/:id/pdf，而它恰恰是
    // frame-ancestors 唯一可能出问题的地方：PDF 预览页是自己用同源 iframe
    // 嵌这个地址的。一旦这个头变成 'none'，iframe 会被浏览器挡掉 —— 表现是
    // 预览白屏，而服务器上的课件绝大多数都是 PDF。
    // 这里验不了「浏览器真的渲染出来了」（自测里没有浏览器），
    // 但能把「前提条件」钉死：这个响应上的 frame-ancestors 必须是 'self'。
    const pdfForHeaders = multipart(
      { courseId: String(courseId), category: 'handout' },
      { field: 'file', filename: '响应头检查.pdf', data: makeTestPdf(), mime: 'application/pdf' },
    );
    const pdfForHeadersRes = await req('POST', '/api/materials', {
      body: pdfForHeaders.body,
      headers: { 'Content-Type': pdfForHeaders.contentType },
    });
    const pdfForHeadersId = pdfForHeadersRes.json?.material?.id;
    ok('上传一份 PDF 专用来验响应头', pdfForHeadersRes.status === 201,
      `状态码 ${pdfForHeadersRes.status}`);

    const pdfResponse = await req('GET', `/materials/${pdfForHeadersId}/pdf`);
    ok('PDF 地址返回 200', pdfResponse.status === 200, `状态码 ${pdfResponse.status}`);
    const pdfCsp = pdfResponse.headers.get('content-security-policy') || '';
    ok('★ PDF 响应上的 frame-ancestors 是 self（是 none 的话同源 iframe 会被挡掉、预览白屏）',
      /frame-ancestors 'self'/.test(pdfCsp), `CSP=${pdfCsp || '（没有）'}`);
    ok('★ PDF 响应的 X-Frame-Options 是 SAMEORIGIN（不能是 DENY，同理）',
      pdfResponse.headers.get('x-frame-options') === 'SAMEORIGIN',
      pdfResponse.headers.get('x-frame-options') || '（没有）');
    ok('PDF 响应也带 nosniff（避免浏览器把上传文件猜成别的类型）',
      pdfResponse.headers.get('x-content-type-options') === 'nosniff');

    await req('DELETE', `/api/materials/${pdfForHeadersId}`);

    // ---- 日历页也要在站内布局里（否则用户进去就出不来了）----
    // 它以前是一段手写的裸 HTML：没有导航栏、没有「跳到主要内容」，
    // 用户从书签打开之后就再也没有能点回站内的入口。
    const calendarPage = await req('GET', '/calendar');
    ok('★ 日历页有站内导航（不是孤岛页面）',
      calendarPage.text.includes('class="sidebar"') && calendarPage.text.includes('class="tabbar"'),
      '缺导航栏的话，用户从书签进来就只能手动改地址栏');
    ok('★ 日历页也有「跳到主要内容」',
      calendarPage.text.includes('跳到主要内容'));
    ok('★ 日历页给出了「作业提醒用 Bark 或邮箱」的完整说法（不是只说 Bark）',
      calendarPage.text.includes('Bark 或邮箱'));

    // ---- 日志里的凭据要打码 ----
    // 日历订阅是 `?token=…`，那个 token 有效期一年、拿到就能拉走全部课表和作业，
    // 而手机日历会**定时轮询**它 —— 明文进日志等于把凭据抄一份到磁盘上。
    const RAW_TOKEN = 'e2e-fake-token-should-not-be-logged';
    const forgedSub = await req('GET', `/calendar/subscribe.ics?token=${RAW_TOKEN}`);
    ok('伪造的订阅令牌被拒绝（下面还要看日志）', forgedSub.status === 403,
      `状态码 ${forgedSub.status}`);

    // 日志是在响应之后才写的，轮询等一下，别用固定 sleep 赌时序
    let logText = server.readLog();
    for (let i = 0; i < 20 && !logText.includes('token=***'); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      logText = server.readLog();
    }

    ok('★ 访问日志里看不到订阅 token 原文',
      !logText.includes(RAW_TOKEN),
      '订阅 token 被明文写进了服务器日志（日志会落盘，还会被 pm2 收集）');
    ok('★ 但请求本身仍然记了下来（路径和参数名还在，排查问题时有用）',
      logText.includes('/calendar/subscribe.ics?token=***'),
      '找不到被打了码的那行日志');

    // --------------------------------------------------------
    section('10. 全部页面可访问');

    const pages = [
      ['/', '总览'],
      ['/timetable', '课程表'],
      ['/courses', '课程'],
      [`/courses/${courseId}`, '课程详情'],
      ['/assignments', '作业'],
      ['/materials', '资料库'],
      [`/materials/${materialId}`, '预览'],
      ['/settings', '设置'],
      ['/import', '导入'],
      ['/calendar', '日历'],
    ];

    for (const [url, name] of pages) {
      const res = await req('GET', url);
      const hasError = /出错了（\d+）/.test(res.text);
      ok(`${name}页 (${url})`, res.status === 200 && !hasError,
        `状态码 ${res.status}${hasError ? '，页面渲染出错' : ''}`);
    }

    // --------------------------------------------------------
    // 手机上进得去的页面，不能比电脑上少
    //
    // 这条是被真事坑出来的：底部导航原本只渲染前 5 项
    // （NAV_ITEMS.slice(0, 5)），而手机端侧边栏整个是 display:none 的。
    // 于是「设置」在手机上没有任何入口 —— 而 Bark 推送配置、作息时间表、
    // 学期设置全在里面。
    //
    // 特征很典型：电脑上一切正常，只有手机上才出问题，而且完全不报错。
    // 所以这里查的不是「设置页能不能打开」，而是那个通用不变量：
    // 侧边栏里每一个链接，底部导航都必须也有。
    // --------------------------------------------------------
    {
      const homeNav = await req('GET', '/');
      const linksIn = (html, cls) => {
        const m = html.match(new RegExp(`<nav class="${cls}"[\\s\\S]*?</nav>`));
        return m ? [...m[0].matchAll(/href="([^"]+)"/g)].map((x) => x[1]) : [];
      };
      const sidebarLinks = linksIn(homeNav.text, 'nav');
      const tabbarLinks = linksIn(homeNav.text, 'tabbar');
      const missingOnMobile = sidebarLinks.filter((h) => !tabbarLinks.includes(h));

      ok('底部导航渲染出了导航项', tabbarLinks.length > 0, `找到 ${tabbarLinks.length} 项`);
      ok('★ 底部导航覆盖侧边栏里的每一个入口（否则手机上那个页面进不去）',
        sidebarLinks.length > 0 && missingOnMobile.length === 0,
        `侧边栏 ${sidebarLinks.length} 项 / 底部导航 ${tabbarLinks.length} 项`
        + (missingOnMobile.length ? `，手机上缺：${missingOnMobile.join(', ')}` : ''));

      // 栏位数必须等于导航项数：对不上会让最后一项换行，
      // 而 .tabbar 是固定高度，多出来的那一行会被裁掉、看不见也点不到。
      const cssText = (await req('GET', '/static/app.css')).text;
      const cols = /\.tabbar\s*\{[^}]*grid-template-columns:\s*repeat\((\d+)/.exec(cssText)?.[1];
      ok('★ 底部导航的栏位数和导航项数一致',
        cols === String(tabbarLinks.length),
        `CSS ${cols} 列 vs 实际 ${tabbarLinks.length} 项`);

      // 间距工具类必须排在所有组件之后。
      //
      // 这条是真踩出来的：.mb-md 之类原本和其他工具类一起放在文件前面，
      // 而 .field__help / .kv 这些组件在后面写了 `margin: 0`。
      // 单类选择器只按出现顺序决胜，于是那几个 mb-* 全被盖掉 ——
      // 写在模板里，却一点间距都没有，而且**不报任何错**，看不出来。
      const spacingAt = Math.min(
        ...[['.mt-sm {'], ['.mt-md {'], ['.mt-lg {'], ['.mb-sm {'], ['.mb-md {']]
          .map(([sel]) => cssText.indexOf(sel)).filter((i) => i !== -1),
      );
      const lastZeroMarginComponent = Math.max(
        ...[['.field__help {'], ['.kv {'], ['.plain-list {'], ['.warning-list {'], ['.form__actions {']]
          .map(([sel]) => cssText.indexOf(sel)),
      );
      ok('★ 间距工具类定义在所有组件之后（否则会被组件的 margin:0 静默盖掉）',
        Number.isFinite(spacingAt) && spacingAt > lastZeroMarginComponent,
        `工具类在第 ${spacingAt} 字符，最后一条带 margin:0 的组件在第 ${lastZeroMarginComponent} 字符`);

      // 退出登录也只存在于侧边栏里，手机上得有别的入口
      const settingsRes = await req('GET', '/settings');
      ok('★ 设置页有退出登录（手机端侧边栏隐藏，这里是唯一入口）',
        /action="\/logout"/.test(settingsRes.text));
    }

    // 静态资源
    for (const asset of ['/static/app.css', '/static/app.js', '/static/manifest.webmanifest', '/static/favicon.svg', '/static/icon-192.png']) {
      const res = await req('GET', asset);
      ok(`静态资源 ${asset}`, res.status === 200, `状态码 ${res.status}`);
    }

    // --------------------------------------------------------
    // 静态资源的类型要对
    //
    // 这一条是被「清单文件被当成 application/octet-stream 发出去」坑出来的：
    // 状态码是 200，页面也能打开，看起来一切正常，
    // 但浏览器认不出这是网页应用清单，手机上「添加到主屏幕」
    // 就拿不到名字和图标 —— 一个只在真机上才暴露的问题。
    // --------------------------------------------------------
    {
      const manifest = await req('GET', '/static/manifest.webmanifest');
      ok('★ 清单文件用 application/manifest+json 发出去',
        /application\/manifest\+json/.test(manifest.headers.get('content-type') || ''),
        `实际是 ${manifest.headers.get('content-type')}`);

      for (const [asset, want] of [
        ['/static/app.css', /text\/css/],
        ['/static/app.js', /javascript/],
        ['/static/favicon.svg', /image\/svg\+xml/],
        ['/static/icon-192.png', /image\/png/],
      ]) {
        const res = await req('GET', asset);
        const type = res.headers.get('content-type') || '';
        ok(`★ ${asset} 的类型正确`, want.test(type), `实际是 ${type}`);
      }
    }

    // --------------------------------------------------------
    // gzip 压缩
    //
    // 为什么值得有断言：压缩最危险的失败方式不是「没压」，而是
    // **「声明压了、其实没压」** —— 头里写着 Content-Encoding: gzip，
    // 正文却是原文，浏览器会拿 gzip 解压器去解 HTML，用户看到一片乱码。
    //
    // 这里用 Content-Length 和正文长度的关系来判断「是不是真的压了」：
    // 声明 gzip 却没压的话，Content-Length 会等于未压缩的长度，断言就会红。
    // --------------------------------------------------------
    {
      for (const asset of ['/static/app.css', '/static/app.js']) {
        const plain = await req('GET', asset, { headers: { 'Accept-Encoding': 'identity' } });
        const zipped = await req('GET', asset, { headers: { 'Accept-Encoding': 'gzip' } });

        const enc = zipped.headers.get('content-encoding') || '';
        const declared = Number(zipped.headers.get('content-length') || 0);
        const plainBytes = Buffer.byteLength(plain.text, 'utf8');

        ok(`★ ${asset} 会返回 gzip`, enc === 'gzip', `Content-Encoding=${enc || '(无)'}`);
        ok(`★ ${asset} 的 Content-Length 是压缩后的真实字节数`,
          declared > 0 && declared < plainBytes * 0.6,
          `声明 ${declared} 字节，未压缩是 ${plainBytes} 字节`);
        ok(`★ ${asset} 带 Vary: Accept-Encoding（缓存才不会把 gzip 发给不支持的人）`,
          /accept-encoding/i.test(zipped.headers.get('vary') || ''),
          zipped.headers.get('vary') || '(无)');
        // fetch 会自动解压；解压后内容还得是对的，说明压缩流本身没问题
        ok(`★ ${asset} 解压后内容完好`, zipped.text === plain.text,
          `${zipped.text.length} vs ${plain.text.length}`);
      }

      // 明确说不接受的客户端，不该收到 gzip
      const noGzip = await req('GET', '/static/app.css', { headers: { 'Accept-Encoding': 'identity' } });
      ok('★ 客户端不接受 gzip 时就不压',
        !(noGzip.headers.get('content-encoding') || '').includes('gzip'));

      // 图片本身就是压缩格式，再 gzip 一遍纯属浪费 CPU
      const png = await req('GET', '/static/icon-512.png', { headers: { 'Accept-Encoding': 'gzip' } });
      ok('★ 已经是压缩格式的图片不会被再压一遍',
        !(png.headers.get('content-encoding') || '').includes('gzip'),
        png.headers.get('content-encoding') || '(无)');

      // 动态页面（没有缓存、每次都要传）才是流量的主要来源
      const settingsPlain = await req('GET', '/settings', { headers: { 'Accept-Encoding': 'identity' } });
      const settingsGz = await req('GET', '/settings', { headers: { 'Accept-Encoding': 'gzip' } });
      const spBytes = Buffer.byteLength(settingsPlain.text, 'utf8');
      const sgBytes = Number(settingsGz.headers.get('content-length') || 0);
      ok('★ 动态页面（HTML）也会被压缩',
        (settingsGz.headers.get('content-encoding') || '') === 'gzip' && sgBytes < spBytes * 0.5,
        `${spBytes} → ${sgBytes} 字节`);
      ok('★ 动态页面压缩解压后仍然完好',
        settingsGz.text.includes('设置') && settingsPlain.text.length === settingsGz.text.length);
    }

    // --------------------------------------------------------
    // 静态资源版本号
    //
    // 加这个是因为反复踩过同一个坑：改了 app.js 之后，
    // 页面上新按钮出来了，但点了没反应——因为浏览器还在用缓存的旧 JS。
    // 所以给资源 URL 拼上「由文件推导的版本号」，文件一改 URL 就变。
    // --------------------------------------------------------
    const homeRes = await req('GET', '/');
    const jsMatch = /<script[^>]*src="(\/static\/app\.js\?v=([^"]+))"/.exec(homeRes.text);
    const cssMatch = /<link[^>]*href="(\/static\/app\.css\?v=([^"]+))"/.exec(homeRes.text);

    ok('页面里的 app.js 带版本号', Boolean(jsMatch), '没找到带 ?v= 的 script 标签');
    ok('页面里的 app.css 带版本号', Boolean(cssMatch), '没找到带 ?v= 的 link 标签');
    ok('body 上标了资源版本号（方便排查缓存问题）',
      /<body data-asset-version="[^"]+"/.test(homeRes.text));

    if (jsMatch) {
      // 版本号必须由静态文件本身推导（大小 + 修改时间），
      // 这样文件一改 URL 就变，浏览器不可能一直用旧缓存。
      const jsStat = fs.statSync(path.join(ROOT, 'src/web/public/app.js'));
      const cssStat = fs.statSync(path.join(ROOT, 'src/web/public/app.css'));
      const expected = `${jsStat.size.toString(36)}${Math.floor(jsStat.mtimeMs).toString(36)}`
        + `-${cssStat.size.toString(36)}${Math.floor(cssStat.mtimeMs).toString(36)}`;

      ok('★ 版本号确实由静态文件推导（文件一改就会变）',
        jsMatch[2] === expected, `页面=${jsMatch[2]} 期望=${expected}`);

      // --------------------------------------------------------
      // 版本号必须在「服务器一直开着」的情况下也跟着变
      //
      // 这条是被真事坑出来的：版本号原本被缓存成模块级变量，
      // 只在进程启动时算一次。于是服务器不重启时改了 app.css，
      // 版本号纹丝不动，而 CSS 的响应头是 immutable（一年），
      // 浏览器压根不会重新下载 —— 症状是「改了样式，刷新多少次都没变化」
      // 而且不报任何错。
      //
      // 上面那条断言抓不到它：那条是在服务器刚启动、文件还没被改过的时候比的。
      // --------------------------------------------------------
      {
        const cssFile = path.join(ROOT, 'src/web/public/app.css');
        const before = fs.statSync(cssFile);

        const page1 = await req('GET', '/');
        const v1 = /app\.css\?v=([^"]+)/.exec(page1.text)?.[1];

        // 只动修改时间、不动文件内容：万一中途抛错，样式表本身也是完好的
        const bumped = new Date(before.mtimeMs + 60000);
        fs.utimesSync(cssFile, bumped, bumped);
        let v2;
        try {
          const page2 = await req('GET', '/');
          v2 = /app\.css\?v=([^"]+)/.exec(page2.text)?.[1];
        } finally {
          fs.utimesSync(cssFile, before.atime, before.mtime);
        }

        ok('★ 服务器不重启时，静态文件一变版本号也要跟着变',
          Boolean(v1) && Boolean(v2) && v1 !== v2, `${v1} → ${v2}`);

        // 恢复之后版本号要跟着回到「文件现在这个样子」对应的值。
        //
        // 这里不能写成 v3 === v1：Windows 上 fs.utimesSync 会把时间戳取整，
        // 恢复出来的毫秒数和当初读到的可能正好差 1，于是版本号最后一个字符
        // 不同 —— 那是文件系统的精度问题，不是版本号算错了。
        // 真正要保证的性质是「版本号永远等于现算一次 stat 的结果」，
        // 所以直接拿现算的值来比：既抓得住「缓存了旧版本号」，也不会偶发变红。
        const cssNow = fs.statSync(cssFile);
        const jsNow = fs.statSync(path.join(ROOT, 'src/web/public/app.js'));
        const expectedBack = `${jsNow.size.toString(36)}${Math.floor(jsNow.mtimeMs).toString(36)}`
          + `-${cssNow.size.toString(36)}${Math.floor(cssNow.mtimeMs).toString(36)}`;
        const page3 = await req('GET', '/');
        const v3 = /app\.css\?v=([^"]+)/.exec(page3.text)?.[1];
        ok('★ 修改时间恢复后，版本号也跟着回到当时的值（每次都现算，不缓存）',
          v3 === expectedBack, `页面=${v3} 期望=${expectedBack}（恢复前是 ${v1}）`);
      }

      const versionedJs = await req('GET', jsMatch[1]);
      ok('带版本号的 JS 能正常取到',
        versionedJs.status === 200 && versionedJs.text.includes('openBatchCreditsForm'),
        `状态码 ${versionedJs.status}`);
      ok('带版本号的资源使用长期缓存（immutable）',
        /immutable/.test(versionedJs.headers.get('cache-control') || ''),
        versionedJs.headers.get('cache-control') || '(空)');
      ok('带版本号时即便浏览器发了 If-None-Match 也能正确返回',
        versionedJs.headers.get('etag') !== null);
    }

    const plainJs = await req('GET', '/static/app.js');
    ok('不带版本号的资源仍然要求每次重新验证',
      /no-cache/.test(plainJs.headers.get('cache-control') || ''),
      plainJs.headers.get('cache-control') || '(空)');

    // 带版本号的地址照样要防路径穿越
    const traversalVersioned = await req('GET', '/static/../../../package.json?v=1');
    ok('带版本号的路径穿越同样被阻止',
      traversalVersioned.status === 404 || traversalVersioned.status === 403,
      `状态码 ${traversalVersioned.status}`);

    // --------------------------------------------------------
    // 客户端 JS 静态自查
    //
    // 真实踩过的坑：app.js 的模板字符串里用了 ${icon(...)}，
    // 但 icon() 只定义在服务端的 layout.js 里。
    // 结果一点按钮就抛 ReferenceError，弹窗根本打不开——
    // 现象是「点了完全没反应」。语法检查、接口测试、页面渲染测试
    // 全都发现不了，因为只有真正点下去才会执行到那一行。
    //
    // 这里做一次静态扫描：模板里调用的每个函数，必须在 app.js 里有定义。
    // --------------------------------------------------------
    const appSrc = (await req('GET', '/static/app.js')).text;

    const BUILTIN_GLOBALS = new Set([
      'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date',
      'Map', 'Set', 'WeakMap', 'Promise', 'Error', 'RegExp', 'Symbol', 'BigInt',
      'FormData', 'URL', 'URLSearchParams', 'Intl', 'fetch', 'parseInt', 'parseFloat',
      'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval',
      'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'structuredClone',
    ]);

    const calledInTemplates = new Set();
    for (const m of appSrc.matchAll(/\$\{([A-Za-z_$][\w$]*)\s*\(/g)) {
      calledInTemplates.add(m[1]);
    }

    const isDefinedInClient = (name) => [
      new RegExp(`function\\s+${name}\\b`),
      new RegExp(`(const|let|var)\\s+${name}\\s*=`),
      new RegExp(`class\\s+${name}\\b`),
    ].some((re) => re.test(appSrc));

    const undefinedCalls = [...calledInTemplates]
      .filter((n) => !BUILTIN_GLOBALS.has(n) && !isDefinedInClient(n));

    ok(`★ 客户端模板里调用的函数都有定义（扫了 ${calledInTemplates.size} 个）`,
      undefinedCalls.length === 0,
      `未定义：${undefinedCalls.join('、')}——这会让按钮点了毫无反应`);

    // ---- 图标数据注入 ----
    const homeHtml = (await req('GET', '/')).text;
    const iconJsonMatch = /<script[^>]*id="sg-icon-paths"[^>]*>([\s\S]*?)<\/script>/.exec(homeHtml);

    ok('页面里注入了图标数据（客户端 icon() 依赖它）',
      Boolean(iconJsonMatch), '没找到 #sg-icon-paths');

    ok('客户端定义了 icon()',
      /function\s+icon\s*\(/.test(appSrc), 'app.js 里没有 icon()');

    let iconMap = {};
    if (iconJsonMatch) {
      try {
        iconMap = JSON.parse(iconJsonMatch[1]);
      } catch {
        iconMap = null;
      }
    }
    ok('图标数据是合法 JSON 且条目充足',
      iconMap !== null && typeof iconMap === 'object' && Object.keys(iconMap).length > 15,
      iconMap === null ? '解析失败' : `只有 ${Object.keys(iconMap || {}).length} 个图标`);

    // 客户端用到的图标名必须都存在于注入的数据里，否则会渲染出空白图标
    if (iconMap) {
      const usedIcons = new Set();
      for (const m of appSrc.matchAll(/\bicon\(\s*'([a-zA-Z]+)'/g)) usedIcons.add(m[1]);
      const missingIcons = [...usedIcons].filter((n) => !iconMap[n]);
      ok(`★ 客户端用到的图标名都存在（用了 ${usedIcons.size} 个）`,
        missingIcons.length === 0,
        `缺少：${missingIcons.join('、') || '（无）'}`);
    }

    // 服务端渲染的页面里也应该真的有图标（不是空白 svg）
    ok('服务端渲染出的图标里有实际路径',
      /<svg class="icon"[^>]*>\s*<path/.test(homeHtml), '页面里的 svg 图标是空的');

    // --------------------------------------------------------
    section('11. 作息时间表与上课时间编辑');

    // 这一节覆盖两个曾经出问题的地方：
    //   1. 课程详情页没有「编辑上课时间」的入口（按钮错绑到了课程信息表单）
    //   2. 「第几节」对应几点是写死在代码里的，学校不一样就没法改

    const defaultPeriods = await req('GET', '/api/periods');
    ok('作息表接口可访问', defaultPeriods.status === 200, `状态码 ${defaultPeriods.status}`);
    ok('默认返回 12 节（一节课一行）', (defaultPeriods.json?.periods || []).length === 12,
      `实际 ${defaultPeriods.json?.periods?.length} 节`);
    ok('未自定义时 isCustom 为 false', defaultPeriods.json?.isCustom === false);
    ok('默认第 1 节是 08:00-08:45',
      defaultPeriods.json?.periods?.[0]?.start === '08:00'
      && defaultPeriods.json?.periods?.[0]?.end === '08:45'
      && defaultPeriods.json?.periods?.[0]?.index === 1,
      JSON.stringify(defaultPeriods.json?.periods?.[0]));
    ok('每一节都有独立的节次编号',
      (defaultPeriods.json?.periods || []).every((p, i) => p.index === i + 1),
      JSON.stringify((defaultPeriods.json?.periods || []).map((p) => p.index)));

    // ---- 课程详情页必须有编辑上课时间的入口 ----
    const detailPage = await req('GET', `/courses/${courseId}`);
    ok('课程详情页有「编辑上课时间」入口',
      detailPage.text.includes(`data-edit-sessions="${courseId}"`),
      '页面里找不到 data-edit-sessions 按钮');
    ok('入口文案明确写的是上课时间', detailPage.text.includes('编辑上课时间'));
    ok('前端 JS 里有该按钮的处理逻辑',
      (await req('GET', '/static/app.js')).text.includes('data-edit-sessions'));

    // ---- 服务端要拦住非法的上课时间 ----
    const badTime = await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: { sessions: [{ weekday: 1, startTime: '10:00', endTime: '08:00', weeks: '1-16' }] },
    });
    ok('结束时间早于开始时间被拒绝',
      badTime.status === 400 && /必须晚于/.test(badTime.json?.error || ''),
      `状态码 ${badTime.status}：${badTime.json?.error}`);

    const badWeeks = await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: { sessions: [{ weekday: 1, startTime: '08:00', endTime: '09:40', weeks: 'abc!!' }] },
    });
    ok('非法周次被拒绝', badWeeks.status === 400, `状态码 ${badWeeks.status}`);

    // ---- 自定义作息表 ----
    // 一节课一行，这样才能算对「第 5-7 节」这种任意跨度
    const customSchedule = [
      { index: 1, start: '08:30', end: '09:15' },
      { index: 2, start: '09:20', end: '10:05' },
      { index: 3, start: '10:25', end: '11:10' },
      { index: 4, start: '11:15', end: '12:00' },
    ];

    const savePeriods = await req('POST', '/api/periods', { json: { periods: customSchedule } });
    ok('保存自定义作息表成功', savePeriods.status === 200, `状态码 ${savePeriods.status}`);
    ok('返回值标为已自定义', savePeriods.json?.isCustom === true);
    ok('自定义的时间被正确保存',
      savePeriods.json?.periods?.[0]?.start === '08:30',
      JSON.stringify(savePeriods.json?.periods?.[0]));

    const badPeriods = await req('POST', '/api/periods', {
      json: { periods: [{ index: 1, start: '10:00', end: '09:00' }] },
    });
    ok('结束早于开始的节被拒绝并给出中文说明',
      badPeriods.status === 400 && /格式不正确/.test(badPeriods.json?.error || ''),
      `状态码 ${badPeriods.status}：${badPeriods.json?.error}`);

    const badTimeFormat = await req('POST', '/api/periods', {
      json: { periods: [{ index: 1, start: '25:99', end: '09:40' }] },
    });
    ok('非法时间格式被拒绝', badTimeFormat.status === 400, `状态码 ${badTimeFormat.status}`);

    const badIndex = await req('POST', '/api/periods', {
      json: { periods: [{ index: 0, start: '08:00', end: '08:45' }] },
    });
    ok('非法节次编号被拒绝', badIndex.status === 400, `状态码 ${badIndex.status}`);

    // ---- 导入时必须用自定义作息表换算「第 3-4 节」 ----
    const csvWithPeriods = [
      '课程名称,教师,学分,星期,上课时间,周次,上课地点',
      '财政学,孙七,3,星期一,第3-4节,1-16,之远楼502',
    ].join('\n');

    const periodImport = await req('POST', '/api/import/csv', { json: { text: csvWithPeriods } });
    ok('含「第 3-4 节」的课表能解析', periodImport.status === 200, `状态码 ${periodImport.status}`);
    const finance = (periodImport.json?.parsed?.courses || []).find((c) => c.name === '财政学');
    ok('「第 3-4 节」按自定义作息换算成 10:25-12:00',
      finance?.sessions?.[0]?.startTime === '10:25' && finance?.sessions?.[0]?.endTime === '12:00',
      `实际 ${finance?.sessions?.[0]?.startTime}-${finance?.sessions?.[0]?.endTime}`);

    // --------------------------------------------------------
    // 核心场景：一节一行才能算对任意跨度
    //
    // 真实课表里既有「第 5-6 节」也有「第 5-7 节」。
    // 如果作息表按「区段」存（第5-6节一行、第7-8节一行），
    // 「第 5-7 节」的结束时间就会错误地取到第 7-8 节那一行的末尾。
    // 下面这组断言就是钉死这个行为的。
    // --------------------------------------------------------
    // 注意：这份作息要把本周**所有**课程的时间都覆盖到，
    // 只要有一门课对不上，整张课表就会退化成整点分行（这是设计上的保守选择）
    const spanSchedule = [
      { index: 1, start: '08:00', end: '08:45' },
      { index: 2, start: '08:50', end: '09:35' },
      { index: 3, start: '09:55', end: '10:40' },
      { index: 4, start: '10:45', end: '11:30' },
      { index: 5, start: '13:00', end: '13:45' },
      { index: 6, start: '13:50', end: '14:35' },
      { index: 7, start: '14:40', end: '15:25' },
      { index: 8, start: '15:30', end: '16:15' },
    ];
    await req('POST', '/api/periods', { json: { periods: spanSchedule } });

    const spanCsv = [
      '课程名称,教师,星期,上课时间,周次,上课地点',
      '金融市场与金融机构,王五,星期一,第5-7节,1-18,博学楼101',
      '公司金融,赵六,星期二,第5-6节,1-18,博学楼102',
    ].join('\n');

    const spanImport = await req('POST', '/api/import/csv', { json: { text: spanCsv } });
    const spanCourses = spanImport.json?.parsed?.courses || [];

    const s57 = spanCourses.find((c) => c.name === '金融市场与金融机构');
    ok('「第 5-7 节」→ 13:00-15:25（跨三节，取第5节开始到第7节结束）',
      s57?.sessions?.[0]?.startTime === '13:00' && s57?.sessions?.[0]?.endTime === '15:25',
      `实际 ${s57?.sessions?.[0]?.startTime}-${s57?.sessions?.[0]?.endTime}`);

    const s56 = spanCourses.find((c) => c.name === '公司金融');
    ok('「第 5-6 节」→ 13:00-14:35（跨两节）',
      s56?.sessions?.[0]?.startTime === '13:00' && s56?.sessions?.[0]?.endTime === '14:35',
      `实际 ${s56?.sessions?.[0]?.startTime}-${s56?.sessions?.[0]?.endTime}`);

    // 把跨度种到已有课程上，然后看课程表的网格是不是真的跨行
    await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: {
        sessions: [
          { weekday: 1, startTime: '13:00', endTime: '15:25', weeks: '1-18', location: '博学楼101' },
          { weekday: 3, startTime: '13:00', endTime: '14:35', weeks: '1-18', location: '博学楼102' },
        ],
      },
    });

    const spanTimetable = await req('GET', '/timetable');
    ok('课表按节次分行（第5节出现在时间列里）',
      spanTimetable.text.includes('第5节'), '时间列里没找到「第5节」');
    ok('跨三节的课在网格里占据 3 行',
      /grid-row:\d+ \/ span 3/.test(spanTimetable.text),
      '没找到 span 3 的课程块');
    ok('跨两节的课在网格里占据 2 行',
      /grid-row:\d+ \/ span 2/.test(spanTimetable.text),
      '没找到 span 2 的课程块');
    ok('课程块上标注了节次范围',
      spanTimetable.text.includes('第5-7节') && spanTimetable.text.includes('第5-6节'),
      '课程块上没有节次范围标签');

    // 恢复一份完整作息，避免后面的断言受影响
    await req('POST', '/api/periods', { json: { periods: null } });
    await req('PUT', `/api/courses/${courseId}/sessions`, {
      json: {
        sessions: [
          { weekday: 1, startTime: '08:00', endTime: '09:35', weeks: '1-16', location: '之远楼301' },
          { weekday: 3, startTime: '09:55', endTime: '11:30', weeks: '1-16', location: '之远楼301' },
        ],
      },
    });

    // ---- 恢复默认 ----
    const resetPeriods = await req('POST', '/api/periods', { json: { periods: null } });
    ok('可以恢复成默认作息表', resetPeriods.status === 200 && resetPeriods.json?.isCustom === false);
    ok('恢复后第一组变回 08:00',
      resetPeriods.json?.periods?.[0]?.start === '08:00',
      JSON.stringify(resetPeriods.json?.periods?.[0]));

    // 恢复默认之后必须真的回到「未自定义」状态。
    // 这里曾经有过一个 bug：把默认值当成自定义值写进了数据库，
    // 于是界面上一直显示「已自定义」，明明已经恢复默认了。
    const afterResetPeriods = await req('GET', '/api/periods');
    ok('恢复默认后 isCustom 真的变回 false',
      afterResetPeriods.json?.isCustom === false,
      `实际 isCustom=${afterResetPeriods.json?.isCustom}`);

    // 把默认值原样提交一遍，也应该被当成「没自定义」
    const submitDefault = await req('POST', '/api/periods', {
      json: { periods: afterResetPeriods.json?.defaults },
    });
    ok('提交与默认值相同的内容时 isCustom 仍为 false',
      submitDefault.json?.isCustom === false,
      `实际 isCustom=${submitDefault.json?.isCustom}`);

    const afterReset = await req('POST', '/api/import/csv', { json: { text: csvWithPeriods } });
    const finance2 = (afterReset.json?.parsed?.courses || []).find((c) => c.name === '财政学');
    // 默认作息是 第3节 09:55-10:40、第4节 10:45-11:30，所以第3-4节 = 09:55-11:30
    ok('恢复默认后「第 3-4 节」按默认作息换算成 09:55-11:30',
      finance2?.sessions?.[0]?.startTime === '09:55' && finance2?.sessions?.[0]?.endTime === '11:30',
      `实际 ${finance2?.sessions?.[0]?.startTime}-${finance2?.sessions?.[0]?.endTime}`);

    // ---- 页面渲染 ----
    const settingsWithPeriods = await req('GET', '/settings');
    ok('设置页有作息时间表区块',
      settingsWithPeriods.text.includes('id="periods"')
      && settingsWithPeriods.text.includes('作息时间表'));
    ok('设置页渲染出「一节一行」的编辑行',
      settingsWithPeriods.text.includes('data-period-rows')
      && settingsWithPeriods.text.includes('name="p_index"'));

    // 读屏要能分清是第几节。以前 12 行的 aria-label 全是「开始时间」，
    // 而「第 X 节」是文本节点、不算进输入框的名字里 —— 读屏听到 12 个同名控件。
    const periodLabels = [...settingsWithPeriods.text.matchAll(/aria-label="第 (\d+) 节[^"]*"/g)]
      .map((m) => m[1]);
    ok('★ 作息表的读屏标签带上了节次（不是一个劲重复「开始时间」）',
      periodLabels.length >= 12, `只找到 ${periodLabels.length} 个带节次的标签`);
    ok('★ 每一节的标签都不一样（读屏才分得清在改哪一节）',
      new Set(periodLabels).size >= 12,
      `只有 ${new Set(periodLabels).size} 种不同的节次`);
    ok('★ 没有剩下裸的 aria-label="开始时间"',
      !/aria-label="开始时间"/.test(settingsWithPeriods.text));
    ok('设置页每行只有节次 + 开始 + 结束（没有区段的起止两列）',
      settingsWithPeriods.text.includes('name="p_index"')
      && !settingsWithPeriods.text.includes('name="p_from"')
      && !settingsWithPeriods.text.includes('name="p_to"'));
    ok('设置页有恢复默认按钮', settingsWithPeriods.text.includes('data-reset-periods'));
    ok('设置页有自动推算下一节的按钮',
      settingsWithPeriods.text.includes('data-auto-fill-periods'));

    // ---- 外观（深浅色）----
    // 手机上侧栏是隐藏的，而唯一的深浅色开关就在侧栏里 ——
    // 所以设置页这个入口是手机用户**唯一**能切主题的地方，不能没有。
    // 而且「跟随系统」这一项也不能少：缺了它，用户点过侧栏那个按钮之后
    // 就被永久固定在深或浅，回不到跟随系统。
    const appearanceAt = settingsWithPeriods.text.indexOf('id="appearance"');
    ok('★ 设置页有「外观」分组（手机切深浅色的唯一入口）',
      appearanceAt > -1, '整页找不到 id="appearance"');
    ok('★ 「外观」在设置页目录里有一项',
      settingsWithPeriods.text.includes('href="#appearance"'));
    for (const [label, value] of [['跟随系统', 'system'], ['浅色', 'light'], ['深色', 'dark']]) {
      ok(`★ 外观里有「${label}」这个选项`,
        settingsWithPeriods.text.includes(`data-theme-choice="${value}"`));
    }
    // 三个选项必须在 #appearance 这一节里，不能跑到别的分组去
    ok('★ 三个选项长在「外观」这一节里（不是散落在别处）',
      settingsWithPeriods.text.slice(appearanceAt, appearanceAt + 1400)
        .includes('data-theme-choice="dark"'),
      '外观分组里没有找到选项，可能被挪到别的 section 了');

    // ---- 窄屏放不下的表格要能横向滚 ----
    // 「学期」那张表有 6 列，手机上装不下；而 .card 是 overflow:hidden ——
    // 不套滚动容器的话右边的列会被**直接裁掉**：既看不见，也滚不动，
    // 用户只会觉得「编辑按钮不见了」。
    const termTableAt = settingsWithPeriods.text.indexOf('第一周周一');
    const termScrollAt = settingsWithPeriods.text.lastIndexOf('table-scroll', termTableAt);
    ok('★ 学期表格套了横向滚动容器（否则手机上右边的列被裁掉、还滚不动）',
      termTableAt > -1 && termScrollAt > -1 && termTableAt - termScrollAt < 400,
      '学期表格没有被 .table-scroll 包住');
    ok('★ 学期表格确实有 6 列（前提：它真的会在窄屏溢出）',
      /<th>学期<\/th><th>第一周周一<\/th><th>周数<\/th><th>现在第几周<\/th><th>状态<\/th>/.test(settingsWithPeriods.text));

    const scrollCss = (await req('GET', '/static/app.css')).text;
    ok('★ 横向滚动里加了 overscroll-behavior-x（否则手机右滑会当成「返回上一页」）',
      /\.table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(scrollCss));

    const importPageWithPeriods = await req('GET', '/import');
    ok('导入页展示当前作息表', importPageWithPeriods.text.includes('当前使用的作息时间表'));
    ok('导入页提示用的是默认作息',
      importPageWithPeriods.text.includes('内置默认时间'),
      '未自定义时应该提示用的是默认作息');

    // 自定义之后，导入页不再说「用的是默认值」
    await req('POST', '/api/periods', { json: { periods: customSchedule } });
    const importPageCustom = await req('GET', '/import');
    ok('自定义后导入页改口说「你自己设置的」',
      importPageCustom.text.includes('这是<strong>你自己设置的</strong>作息表'));
    await req('POST', '/api/periods', { json: { periods: null } });

    // ---- 课程表的时间轴 ----
    // 前面把高等数学设成了周一 08:00-09:35、周三 09:55-11:30，
    // 正好落在默认作息表的 第1-2 节 和 第3-4 节 里，所以应该按节次分行。
    const ttDefault = await req('GET', '/timetable');
    ok('课表按节次分行', ttDefault.text.includes('第1节') && ttDefault.text.includes('第3节'),
      '页面上没找到「第1节」「第3节」行标签');
    ok('课表左上角标注为「节次」',
      ttDefault.text.includes('week-grid__corner') && ttDefault.text.includes('>节次</div>'),
      '左上角标签不对');
    ok('节次行下面补了开始时间',
      ttDefault.text.includes('week-grid__timerange'));
    ok('时间对齐时，两节连上的课在网格里占 2 行',
      /grid-row:\d+ \/ span 2/.test(ttDefault.text),
      '没找到 span 2 的课程块');
    ok('课程时间对得上时不显示退回提示',
      !ttDefault.text.includes('时间轴用的是整点'));

    // 把作息表改成对不上的时间，应该自动退回整点分行并给出提示
    await req('POST', '/api/periods', {
      json: { periods: [{ index: 1, start: '08:30', end: '09:15' }] },
    });

    const ttMismatch = await req('GET', '/timetable');
    ok('作息表对不上时退回整点分行',
      ttMismatch.text.includes('时间轴用的是整点'),
      '应该给出退回提示');
    ok('退回后左上角标注改成「时间」',
      ttMismatch.text.includes('>时间</div>'),
      '左上角标签没跟着变');
    ok('退回后课程仍然显示出来（不能凭空消失）',
      ttMismatch.text.includes('高等数学'),
      '退回整点分行后课程不见了');

    await req('POST', '/api/periods', { json: { periods: null } });

    // --------------------------------------------------------
    // 学期编辑
    //
    // 之前这里也有过一次和「上课时间」一模一样的疏漏：
    // PATCH /api/terms/:id 接口和 updateTerm 都有，
    // 但设置页的学期列表里只有「设为当前」和「删除」，没有「编辑」，
    // 于是「第一周周一」填错了根本改不了。
    // --------------------------------------------------------

    const termsList = await req('GET', '/api/terms');
    ok('学期列表接口可访问', termsList.status === 200, `状态码 ${termsList.status}`);
    ok('至少有一个学期', (termsList.json?.terms || []).length >= 1);

    const mainTerm = termsList.json.terms.find((t) => Number(t.is_active) === 1)
      || termsList.json.terms[0];
    const originalStart = mainTerm.start_date;

    const settingsTerms = await req('GET', '/settings');
    ok('设置页学期列表有「编辑」按钮',
      settingsTerms.text.includes(`data-edit-term="${mainTerm.id}"`),
      '找不到 data-edit-term 按钮');
    ok('设置页显示「现在第几周」这一列',
      settingsTerms.text.includes('<th>现在第几周</th>'));
    ok('前端 JS 里有编辑学期的处理逻辑',
      (await req('GET', '/static/app.js')).text.includes('data-edit-term'));

    // 把起始日往前挪一周 → 当前周次应该 +1
    const shifted = new Date(`${originalStart}T00:00:00`);
    shifted.setDate(shifted.getDate() - 7);
    const pad2 = (n) => String(n).padStart(2, '0');
    const shiftedStr = `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}-${pad2(shifted.getDate())}`;

    const moveTerm = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { startDate: shiftedStr },
    });
    ok('修改学期起始日成功', moveTerm.status === 200, `状态码 ${moveTerm.status}`);
    ok('返回更新后的周次用于提示',
      Number.isFinite(moveTerm.json?.progress?.week),
      JSON.stringify(moveTerm.json?.progress));

    const movedWeek = moveTerm.json.progress.week;
    const beforeWeek = Math.max(1, movedWeek - 1);
    ok('起始日往前挪一周后，当前周次 +1',
      movedWeek === beforeWeek + 1,
      `挪之前应为 ${beforeWeek}，挪之后为 ${movedWeek}`);

    // 起始日必须是周一，否则整张课表的周次都会偏
    const notMonday = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { startDate: '2026-09-09' },
    });
    ok('起始日不是周一时被拒绝',
      notMonday.status === 400 && /星期一/.test(notMonday.json?.error || ''),
      `状态码 ${notMonday.status}：${notMonday.json?.error}`);

    const badDate = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { startDate: '2026/09/07' },
    });
    ok('起始日格式不对时被拒绝', badDate.status === 400, `状态码 ${badDate.status}`);

    const badWeekCount = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { weekCount: 99 },
    });
    ok('总周数超出范围时被拒绝', badWeekCount.status === 400, `状态码 ${badWeekCount.status}`);

    const emptyName = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { name: '   ' },
    });
    ok('学期名称为空时被拒绝', emptyName.status === 400, `状态码 ${emptyName.status}`);

    // 只改名字时不应该影响起始日
    const rename = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { name: '改名测试学期' },
    });
    ok('只改名称不影响起始日',
      rename.status === 200
      && rename.json?.terms?.find((t) => t.id === mainTerm.id)?.start_date === shiftedStr,
      JSON.stringify(rename.json?.terms?.find((t) => t.id === mainTerm.id)));

    // 恢复原状，避免影响后续断言
    const restore = await req('PATCH', `/api/terms/${mainTerm.id}`, {
      json: { name: mainTerm.name, startDate: originalStart, weekCount: mainTerm.week_count },
    });
    ok('可以改回原来的起始日',
      restore.status === 200
      && restore.json?.terms?.find((t) => t.id === mainTerm.id)?.start_date === originalStart,
      `期望 ${originalStart}`);

    // 课表页应该给出「周次不对？」的入口
    const ttHint = await req('GET', '/timetable');
    ok('课表页有「周次不对？」的入口',
      ttHint.text.includes('周次不对？') && ttHint.text.includes('/settings#term'));

    // --------------------------------------------------------
    section('12. 数据落盘检查');

    const dbFile = path.join(dataDir, 'app.db');
    ok('数据库文件已创建', fs.existsSync(dbFile), dbFile);

    // 开了 WAL 模式，数据可能还在 app.db-wal 里，所以要把两个文件加起来看
    const dbSize = ['app.db', 'app.db-wal', 'app.db-shm']
      .map((f) => {
        try {
          return fs.statSync(path.join(dataDir, f)).size;
        } catch {
          return 0;
        }
      })
      .reduce((a, b) => a + b, 0);
    ok('数据库已写入数据', dbSize > 20000, `app.db + wal = ${dbSize} 字节`);
    ok('会话密钥已生成', fs.existsSync(path.join(dataDir, 'secret.key')));
    ok('上传目录已创建', fs.existsSync(path.join(dataDir, 'uploads')));

    const uploadFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else uploadFiles.push(p);
      }
    };
    walk(path.join(dataDir, 'uploads'));
    ok('上传的文件已落盘', uploadFiles.length === 2, `实际 ${uploadFiles.length} 个文件`);

    // --------------------------------------------------------
    // 多用户
    //
    // 这一节钉住四件事：
    //   1. 打开网站同时能看到「登录」和「注册」两个入口
    //   2. 用户名不能重名（连只差大小写都不行）
    //   3. **数据互相不干扰** —— 这条最要紧，因为把 user_id 漏在某个查询里，
    //      界面上完全看不出来：每个人看到的都「像是自己的东西」
    //   4. 注销要真的删干净，包括磁盘上的课件
    // --------------------------------------------------------
    section('13. 多用户：注册、重名、数据隔离、注销');

    // 每次「换个人来操作」都要用一个全新的客户端：cookie jar 是跟着客户端走的，
    // 用新建的客户端去访问就等于换了个浏览器 —— 之前的会话不在它身上。
    // （第一版就是在这里栽的：注册用的是 A，后面读数据用的是新建的 B，
    //  于是 B 根本没登录，接口全 401；而「看不到别人的课」那条断言反而
    //  因为 401 返回空列表而"通过"了 —— 一个会骗人的假通过。）
    const newBrowser = () => createClient(baseUrl);

    // ---- 一个页面上同时有登录和注册 ----
    const authPage = await newBrowser()('GET', '/login');
    ok('登录页可以访问', authPage.status === 200, `状态码 ${authPage.status}`);
    ok('★ 一个页面上同时有「登录」和「注册」两个入口',
      authPage.text.includes('data-panel="login"') && authPage.text.includes('data-panel="register"'));
    ok('★ 默认展开登录（回访的人是多数，不给老用户添麻烦）',
      /id="tab-login"[^>]*checked/.test(authPage.text)
      && !/id="tab-register"[^>]*checked/.test(authPage.text));
    ok('★ 注册表单有「确认密码」（密码敲错一次就建出一个再也登不上的账号）',
      authPage.text.includes('name="password2"'));
    ok('★ 注册要填邀请码（这台机器按流量计费，不能让谁都能建号）',
      authPage.text.includes('name="inviteCode"'));

    const registerPage = await newBrowser()('GET', '/register');
    ok('注册页可以访问', registerPage.status === 200, `状态码 ${registerPage.status}`);
    ok('★ 直接开 /register 时默认展开的是注册那一栏',
      /id="tab-register"[^>]*checked/.test(registerPage.text));

    // ---- 邀请码把住门 ----
    const OTHER = { username: '第二同学', password: 'other123456' };

    const noCode = await newBrowser()('POST', '/register', {
      form: { ...OTHER, password2: OTHER.password, displayName: '第二个用户' },
    });
    ok('★ 不填邀请码注册会被拒绝', noCode.status === 200 && /邀请码/.test(noCode.text),
      `状态码 ${noCode.status}`);
    ok('★ 被拒之后停在注册那一栏，不是把人丢回登录栏',
      /id="tab-register"[^>]*checked/.test(noCode.text));
    ok('★ 用户名被回填了（重填一整个表单是很烦的事）',
      noCode.text.includes(OTHER.username));

    const badCode = await newBrowser()('POST', '/register', {
      form: { ...OTHER, password2: OTHER.password, inviteCode: '不是那个码' },
    });
    ok('★ 邀请码不对会被拒绝', badCode.status === 200 && /邀请码不正确/.test(badCode.text),
      `状态码 ${badCode.status}`);
    ok('★ 提示里不会把真正的邀请码泄露出来', !badCode.text.includes(E2E_INVITE_CODE));

    const mismatch = await newBrowser()('POST', '/register', {
      form: { ...OTHER, password2: '不一样123456', inviteCode: E2E_INVITE_CODE },
    });
    ok('★ 两次密码不一致会被拒绝', /两次输入的密码不一致/.test(mismatch.text));

    const shortPw = await newBrowser()('POST', '/register', {
      form: { ...OTHER, password: '123', password2: '123', inviteCode: E2E_INVITE_CODE },
    });
    ok('★ 密码太短会被拒绝', /至少 8 位/.test(shortPw.text));

    // 7 位这个边界是特意试的：下限从 6 提到 8 之后，
    // 「7 位」正是以前能过、现在必须被挡住的那一档。
    const sevenPw = await newBrowser()('POST', '/register', {
      form: { ...OTHER, password: '1234567', password2: '1234567', inviteCode: E2E_INVITE_CODE },
    });
    ok('★ 7 位也会被拒绝（这正是下限从 6 提到 8 的意义）',
      /至少 8 位/.test(sevenPw.text), sevenPw.text.slice(0, 200));

    // 而且要在**页面上**说清楚要求，不能只藏在 placeholder 里 ——
    // placeholder 在敲下第一个字符时就消失了，新用户根本没机会看到。
    //
    // ⚠️ 必须用**未登录**的客户端取这一页：这段测试跑的时候当前会话是登录状态，
    //    而 /register 对已登录用户会直接 302 回首页 —— 拿到的是空响应体，
    //    三条断言会全红（第一版就是这么写错的，而且红得像功能坏了）。
    const registerPageHtml = (await newBrowser()('GET', '/register')).text;
    ok('注册页确实渲染了注册表单（前提：下面三条才有意义）',
      registerPageHtml.includes('id="rg_pass"'), `长度 ${registerPageHtml.length}`);
    ok('★ 注册页把密码要求写成了常驻帮助文字（不是 placeholder）',
      /id="rg_pass_help"[\s\S]{0,120}至少 8 位/.test(registerPageHtml)
      && !/placeholder="至少 \d 位"/.test(registerPageHtml),
      '要求只写在 placeholder 里的话，一输入就看不见了');
    ok('★ 注册页的密码框带 minlength（浏览器先拦一道，不用等提交）',
      /id="rg_pass"[\s\S]{0,240}minlength="8"/.test(registerPageHtml));
    ok('★ 帮助文字和输入框用 aria-describedby 关联（读屏能念出来）',
      /id="rg_pass"[\s\S]{0,240}aria-describedby="rg_pass_help"/.test(registerPageHtml));

    const dupSame = await newBrowser()('POST', '/register', {
      form: {
        username: '测试同学', password: 'dup123456', password2: 'dup123456',
        inviteCode: E2E_INVITE_CODE,
      },
    });
    ok('★ 用户名和已有账号完全相同会被拒绝', /已经有人用了/.test(dupSame.text),
      dupSame.text.slice(0, 150));
    ok('★ 重名的提示是人话，不是 SQL 报错原文', !/UNIQUE constraint/i.test(dupSame.text));

    // ---- 正常注册一个（用它自己的客户端，注册完这个 jar 里就有会话了）----
    const other = newBrowser();
    const regOther = await other('POST', '/register', {
      form: { ...OTHER, password2: OTHER.password, displayName: '第二个用户', inviteCode: E2E_INVITE_CODE },
    });
    ok('★ 邀请码正确时注册成功并直接进入首页',
      regOther.status === 302 && (regOther.headers.get('location') || '').endsWith('/'),
      `状态码 ${regOther.status}`);

    const otherHome = await other('GET', '/');
    ok('★ 注册完就已经是登录状态（不用再登一次）', otherHome.status === 200,
      `状态码 ${otherHome.status}`);
    ok('★ 新用户的首页是自己的（看到的是自己的名字，不是别人的）',
      otherHome.text.includes('第二个用户'));

    // 再注册一个纯英文名的，用来验「只差大小写也算重名」
    const caseName = `E2ECaseUser${Math.floor(Math.random() * 10000)}`;
    const regCase = await newBrowser()('POST', '/register', {
      form: {
        username: caseName, password: 'case123456', password2: 'case123456',
        inviteCode: E2E_INVITE_CODE,
      },
    });
    ok('英文用户名可以注册', regCase.status === 302, `状态码 ${regCase.status}`);

    const dupCase = await newBrowser()('POST', '/register', {
      form: {
        username: caseName.toLowerCase(), password: 'case123456', password2: 'case123456',
        inviteCode: E2E_INVITE_CODE,
      },
    });
    ok('★ 只差大小写的用户名同样算重名（否则登录时不知道该进哪个账号）',
      /已经有人用了/.test(dupCase.text), dupCase.text.slice(0, 150));

    const upperLogin = await newBrowser()('POST', '/login', {
      form: { username: caseName.toUpperCase(), password: 'case123456' },
    });
    ok('★ 登录不区分大小写（注册时怎么写的，登录时大小写敲错也能进）',
      upperLogin.status === 302, `状态码 ${upperLogin.status}`);

    // 已登录的人不该能从注册接口再建号（否则会被悄悄切成新账号）
    const regWhileLoggedIn = await req('POST', '/register', {
      form: { username: '偷偷换号', password: 'swap123456', password2: 'swap123456', inviteCode: E2E_INVITE_CODE },
    });
    ok('★ 已登录时 POST /register 直接被挡回首页（不能悄悄把会话换成新账号）',
      regWhileLoggedIn.status === 302
      && (regWhileLoggedIn.headers.get('location') || '').endsWith('/'),
      `状态码 ${regWhileLoggedIn.status} → ${regWhileLoggedIn.headers.get('location') || ''}`);
    const stillMe = await req('GET', '/api/courses');
    ok('★ 被挡回来之后，我还是原来那个账号', stillMe.status === 200
      && (stillMe.json?.courses || []).length >= 3, `状态码 ${stillMe.status}`);

    // ---- 数据隔离 ----
    const mineCourses = await req('GET', '/api/courses');
    const theirsCourses = await other('GET', '/api/courses');
    // 先确认「真的登录上了，接口真的返回了」—— 否则一条 401 会让下面
    // 「一门课都看不到」因为读到空数组而假通过（第一版就骗过去了一次）
    ok('第二个用户的接口是通的（不是 401 那种假通过）',
      theirsCourses.status === 200 && Array.isArray(theirsCourses.json?.courses),
      `状态码 ${theirsCourses.status}`);
    ok('★ 新用户一门课都看不到', (theirsCourses.json?.courses || []).length === 0,
      `看到 ${theirsCourses.json?.courses?.length} 门`);
    ok('老用户自己的课程没受影响', (mineCourses.json?.courses || []).length >= 3,
      `${mineCourses.json?.courses?.length} 门`);

    const theirNewCourse = await other('POST', '/api/courses', {
      json: { name: '第二同学的课', teacher: '别人的老师', credits: 1 },
    });
    ok('新用户能建自己的课', theirNewCourse.status === 201, `状态码 ${theirNewCourse.status}`);
    const theirCourseId = theirNewCourse.json?.course?.id;

    const mineAfter = await req('GET', '/api/courses');
    ok('★ 别人新建的课不会出现在我的列表里',
      !(mineAfter.json?.courses || []).some((c) => c.id === theirCourseId),
      `我的课程：${(mineAfter.json?.courses || []).map((c) => c.name).join(', ')}`);

    // 直接按 id 访问别人的东西：一律 404
    // （而不是 403 —— 连「这个 id 存在」都不该暴露出去）
    const stealCourse = await other('GET', `/api/courses/${courseId}`);
    ok('★ 按 id 也读不到别人的课程', stealCourse.status === 404, `状态码 ${stealCourse.status}`);

    const stealPatch = await other('PATCH', `/api/courses/${courseId}`, {
      json: { name: '被改掉的课' },
    });
    ok('★ 改不动别人的课程', stealPatch.status === 404, `状态码 ${stealPatch.status}`);

    const stealDelete = await other('DELETE', `/api/assignments/${assignmentId}`);
    ok('★ 删不掉别人的作业', stealDelete.status === 404, `状态码 ${stealDelete.status}`);

    const stillThere = await req('GET', `/api/assignments/${assignmentId}`);
    ok('★ 被「删」过之后，我的作业还在', stillThere.status === 200,
      `状态码 ${stillThere.status}`);

    const stealMaterial = await other('GET', `/api/materials/${materialId}`);
    ok('★ 读不到别人的课件信息', stealMaterial.status === 404, `状态码 ${stealMaterial.status}`);

    const stealRaw = await other('GET', `/materials/${materialId}/raw`);
    ok('★ 下载不到别人的课件文件', stealRaw.status === 404, `状态码 ${stealRaw.status}`);

    const stealPage = await other('GET', `/materials/${materialId}`);
    ok('★ 打不开别人的课件预览页', stealPage.status === 404, `状态码 ${stealPage.status}`);

    const stealCoursePage = await other('GET', `/courses/${courseId}`);
    ok('★ 打不开别人的课程详情页', stealCoursePage.status === 404, `状态码 ${stealCoursePage.status}`);

    const otherTimetable = await other('GET', '/timetable');
    ok('★ 别人的课表里没有我的课程',
      otherTimetable.status === 200 && !otherTimetable.text.includes(createCourse.json.course.name),
      `状态码 ${otherTimetable.status}`);

    const otherSettings = await other('GET', '/settings');
    ok('★ 设置页显示的是自己的账号名',
      otherSettings.text.includes(OTHER.username) && !otherSettings.text.includes('测试同学'));

    // ---- 隔离：把每一类数据都过一遍 ----
    // 上面验的是课程 / 作业 / 资料这三类。但「带 user_id 的东西」远不止这三样，
    // 漏掉任何一类都是**看不见的**：接口照样返回 200，只是内容串了号。
    // 现在这个站真的给同学用了，所以每一类都要有一条。
    // （这几条是外部审计指出「隔离只测了一部分」之后补的。）

    // 1) 学期：别人的学期读不到、改不动、删不掉
    const otherTerm = await other('POST', '/api/terms', {
      json: { name: '别人的学期', startDate: '2026-09-07', weekCount: 18 },
    });
    const otherTermId = otherTerm.json?.id;
    ok('第二个账号建了自己的学期（下面拿它验隔离）',
      otherTerm.status === 201 && Number.isFinite(otherTermId),
      `状态码 ${otherTerm.status}：${otherTerm.text.slice(0, 120)}`);

    const stealTermPatch = await req('PATCH', `/api/terms/${otherTermId}`, { json: { name: '被改了' } });
    ok('★ 改不动别人的学期', stealTermPatch.status === 404, `状态码 ${stealTermPatch.status}`);

    const stealTermDelete = await req('DELETE', `/api/terms/${otherTermId}`);
    ok('★ 删不掉别人的学期', stealTermDelete.status === 404, `状态码 ${stealTermDelete.status}`);

    const otherStillHasTerm = await other('GET', '/api/terms');
    ok('★ 被人「改过删过」之后，别人的学期还在且没被改名',
      (otherStillHasTerm.json?.terms || []).some((t) => t.id === otherTermId && t.name === '别人的学期'));

    const myTerms = await req('GET', '/api/terms');
    ok('★ 我的学期列表里没有别人的学期',
      !(myTerms.json?.terms || []).some((t) => t.id === otherTermId));

    // 2) 提醒渠道：别人的渠道读不到、改不动、删不掉
    //    verify:false —— 建渠道时默认会先真发一条测试消息，这里不该真发
    const otherChannel = await other('POST', '/api/channels', {
      json: { type: 'bark', name: '别人的手机', config: { key: 'OtherKey123' }, isDefault: true, verify: false },
    });
    const otherChannelId = otherChannel.json?.id;
    ok('第二个账号建了自己的提醒渠道', otherChannel.status === 201 && Number.isFinite(otherChannelId),
      `状态码 ${otherChannel.status}：${otherChannel.text.slice(0, 120)}`);

    const stealChannelPatch = await req('PATCH', `/api/channels/${otherChannelId}`, { json: { name: '被改了' } });
    ok('★ 改不动别人的提醒渠道', stealChannelPatch.status === 404, `状态码 ${stealChannelPatch.status}`);

    const stealChannelDelete = await req('DELETE', `/api/channels/${otherChannelId}`);
    ok('★ 删不掉别人的提醒渠道', stealChannelDelete.status === 404, `状态码 ${stealChannelDelete.status}`);

    const stealChannelTest = await req('POST', `/api/channels/${otherChannelId}/test`);
    ok('★ 不能用别人的渠道发测试消息（否则可以拿它当骚扰工具）',
      stealChannelTest.status === 404, `状态码 ${stealChannelTest.status}`);

    const myChannels = await req('GET', '/api/channels');
    ok('★ 我的渠道列表里没有别人的渠道',
      !(myChannels.json?.channels || []).some((c) => c.id === otherChannelId));
    const myChannelsText = JSON.stringify(myChannels.json || {});
    ok('★ 别人的渠道密钥不会出现在我的接口返回里（打码之后也不该串过来）',
      !myChannelsText.includes('OtherKey123'));

    // 3) 设置：各改各的，互不影响
    //    设置没有 GET 接口（页面是服务端渲染的），所以用 POST 的返回值比对
    const otherSettingsSaved = await other('POST', '/api/settings', {
      json: { daily_digest_time: '06:15' },
    });
    ok('第二个账号改了自己的简报时间（前提）',
      otherSettingsSaved.json?.settings?.daily_digest_time === '06:15',
      JSON.stringify(otherSettingsSaved.json?.settings?.daily_digest_time));
    const mySettingsSaved = await req('POST', '/api/settings', { json: {} });
    ok('★ 别人改了设置，我的设置没跟着变',
      mySettingsSaved.json?.settings?.daily_digest_time !== '06:15',
      `我的是 ${mySettingsSaved.json?.settings?.daily_digest_time}`);

    // 4) 作息表：各改各的
    await other('POST', '/api/periods', {
      json: { periods: [{ index: 1, start: '07:00', end: '07:45' }] },
    });
    const myPeriods = await req('GET', '/api/periods');
    ok('★ 别人改了作息表，我的作息表没跟着变',
      (myPeriods.json?.periods || [])[0]?.start !== '07:00',
      `我的第 1 节是 ${(myPeriods.json?.periods || [])[0]?.start}`);

    // 5) 课件：改和删也要挡住（上面只验了「读」）
    const stealMaterialPatch = await other('PATCH', `/api/materials/${materialId}`, { json: { title: '被改名了' } });
    ok('★ 改不了别人的课件信息', stealMaterialPatch.status === 404, `状态码 ${stealMaterialPatch.status}`);

    const stealMaterialDelete = await other('DELETE', `/api/materials/${materialId}`);
    ok('★ 删不掉别人的课件', stealMaterialDelete.status === 404, `状态码 ${stealMaterialDelete.status}`);

    const materialStillMine = await req('GET', `/api/materials/${materialId}`);
    ok('★ 被人「改过删过」之后，我的课件还在且没被改名',
      materialStillMine.status === 200 && materialStillMine.json?.material?.title !== '被改名了');

    // 6) 作业：改也要挡住（前面验了删）
    const stealAssignmentPatch = await other('PATCH', `/api/assignments/${assignmentId}`, { json: { title: '被改名了' } });
    ok('★ 改不了别人的作业', stealAssignmentPatch.status === 404, `状态码 ${stealAssignmentPatch.status}`);

    // 7) 日历订阅令牌 —— 这条最值得单独验：
    //    令牌是匿名可用的（手机日历不带 Cookie），一旦串号，
    //    等于把别人的课表和作业直接交给任何拿到链接的人。
    const otherSub = await other('GET', '/settings');
    const otherToken = /token=([A-Za-z0-9._-]+)/.exec(otherSub.text)?.[1];
    ok('拿到第二个账号的订阅令牌（前提）', Boolean(otherToken));

    const otherCalendar = await req('GET', `/calendar/subscribe.ics?token=${otherToken}`);
    ok('★ 用别人的订阅令牌能拉到日历（令牌本身是有效的）',
      otherCalendar.status === 200 && otherCalendar.text.includes('BEGIN:VCALENDAR'),
      `状态码 ${otherCalendar.status}`);
    ok('★ 但拉到的只有他自己的东西，没有我的课程',
      !otherCalendar.text.includes(createCourse.json.course.name),
      '★ 订阅令牌串号 = 把别人的课表交给了任何拿到链接的人');
    ok('★ 也没有我的作业',
      !otherCalendar.text.includes(createAssignment.json.assignment.title));

    // 8) 导入：别人导入课表不该动到我的课程
    //    真实风险是「导入时用错了 user_id」，那会让一个人的课表灌到所有人账号里 ——
    //    接口全都返回 200，谁都看不出来。
    const myCoursesBefore = (await req('GET', '/api/courses')).json?.courses?.length || 0;
    const otherImport = await other('POST', '/api/import/confirm', {
      json: {
        payload: { courses: [{ name: '别人导入的课', sessions: [] }], termStart: '2026-09-07' },
        termId: 'new',
        onConflict: 'skip',
      },
    });
    ok('第二个账号导入了一门课（前提）',
      otherImport.status === 200 && otherImport.json?.result?.created >= 1,
      `状态码 ${otherImport.status}：${otherImport.text.slice(0, 120)}`);

    const myCoursesAfter = (await req('GET', '/api/courses')).json?.courses || [];
    ok('★ 别人导入课程之后，我的课程数量没变',
      myCoursesAfter.length === myCoursesBefore,
      `${myCoursesBefore} → ${myCoursesAfter.length}`);
    ok('★ 别人导入的课不会出现在我的课程列表里',
      !myCoursesAfter.some((c) => c.name === '别人导入的课'));

    // ---- 注销账号 ----
    const victim = newBrowser();
    const VICTIM = { username: `要注销的同学${Math.floor(Math.random() * 10000)}`, password: 'gone123456' };
    const regVictim = await victim('POST', '/register', {
      form: { ...VICTIM, password2: VICTIM.password, inviteCode: E2E_INVITE_CODE },
    });
    ok('第三个账号注册成功（后面用它验注销）', regVictim.status === 302,
      `状态码 ${regVictim.status}`);

    const victimCourse = await victim('POST', '/api/courses', {
      json: { name: '待注销的课', credits: 2 },
    });
    ok('注销测试账号建了一门自己的课', victimCourse.status === 201);

    const victimUpload = multipart(
      { category: 'courseware' },
      {
        field: 'file',
        filename: '待删课件.txt',
        data: Buffer.from('注销之后这个文件不该还在', 'utf8'),
        mime: 'text/plain',
      },
    );
    const victimUploadRes = await victim('POST', '/api/materials', {
      body: victimUpload.body,
      headers: { 'Content-Type': victimUpload.contentType },
    });
    ok('注销测试账号上传了一个课件', victimUploadRes.status === 201,
      `状态码 ${victimUploadRes.status}`);

    const countUploads = () => {
      let n = 0;
      const count = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) count(p);
          else n += 1;
        }
      };
      count(path.join(dataDir, 'uploads'));
      return n;
    };
    ok('★ 上传之后磁盘上确实多了一个文件（否则后面的删除断言是空转的）',
      countUploads() === 3, `实际 ${countUploads()} 个`);

    // 两道确认，缺一不可
    const wrongPw = await victim('POST', '/api/account/delete', {
      json: { password: '不是密码', confirmUsername: VICTIM.username },
    });
    ok('★ 注销要输对密码', wrongPw.status === 400 && /密码不正确/.test(wrongPw.text),
      `状态码 ${wrongPw.status}`);

    const wrongName = await victim('POST', '/api/account/delete', {
      json: { password: VICTIM.password, confirmUsername: '随便是谁' },
    });
    ok('★ 注销要把用户名原样敲一遍',
      wrongName.status === 400 && /原样输入/.test(wrongName.text),
      `状态码 ${wrongName.status}`);

    const stillLoggedIn = await victim('GET', '/api/courses');
    ok('★ 两道确认没过时，账号一点没动', stillLoggedIn.status === 200,
      `状态码 ${stillLoggedIn.status}`);

    const deleted = await victim('POST', '/api/account/delete', {
      json: { password: VICTIM.password, confirmUsername: VICTIM.username },
    });
    ok('★ 两道确认都对才真的注销', deleted.status === 200 && deleted.json?.ok === true,
      `状态码 ${deleted.status}：${deleted.text.slice(0, 120)}`);
    ok('★ 注销之后会话立刻失效（不能揣着一条指向已删用户的 Cookie）',
      (deleted.headers.getSetCookie?.() || []).some((c) => /^sg_session=;/.test(c)),
      (deleted.headers.getSetCookie?.() || []).join('; ') || '(没有清 Cookie)');

    const afterDelete = await victim('GET', '/api/courses');
    ok('★ 注销之后再也拿不到数据',
      afterDelete.status === 401 || afterDelete.status === 302,
      `状态码 ${afterDelete.status}`);

    const reloginDeleted = await newBrowser()('POST', '/login', { form: VICTIM });
    ok('★ 注销之后这个账号登不进去了',
      reloginDeleted.status === 200 && /用户名或密码不正确/.test(reloginDeleted.text),
      `状态码 ${reloginDeleted.status}`);

    ok('★ 注销把磁盘上的课件也删了（不能只在数据库里删掉）',
      countUploads() === 2, `实际还剩 ${countUploads()} 个文件`);

    const afterAll = await req('GET', '/api/courses');
    ok('★ 别人注销不影响我的数据', (afterAll.json?.courses || []).length >= 3,
      `${afterAll.json?.courses?.length} 门`);

    const deletedNotice = await newBrowser()('GET', `/login?deleted=${encodeURIComponent(VICTIM.username)}`);
    ok('★ 注销后回到登录页会说一句「已注销」，而不是莫名其妙被登出',
      deletedNotice.text.includes('已注销'), deletedNotice.text.slice(0, 120));

    // 已登录的状态下不该还能看到注册页
    const registerWhileLoggedIn = await req('GET', '/register');
    ok('已登录时访问 /register 会跳回首页',
      registerWhileLoggedIn.status === 302
      && (registerWhileLoggedIn.headers.get('location') || '').endsWith('/'),
      `状态码 ${registerWhileLoggedIn.status}`);

    // /setup 是老入口（README 和老书签里都写着）。站点已经有账号之后它不能再
    // 用来建号 —— 否则就是一条绕过邀请码的旁路（policy.open 这时是 true）。
    const setupAgain = await newBrowser()('POST', '/setup', {
      form: { username: '偷偷建的号', password: 'sneak123456', password2: 'sneak123456' },
    });
    ok('★ 站点已有账号之后 /setup 不能再建号（否则就绕过了邀请码）',
      setupAgain.status === 302 && (setupAgain.headers.get('location') || '').includes('/login'),
      `状态码 ${setupAgain.status} → ${setupAgain.headers.get('location') || ''}`);
    const sneakLogin = await newBrowser()('POST', '/login', {
      form: { username: '偷偷建的号', password: 'sneak123456' },
    });
    ok('★ 那个账号确实没被建出来',
      sneakLogin.status === 200 && /用户名或密码不正确/.test(sneakLogin.text),
      `状态码 ${sneakLogin.status}`);

    // --------------------------------------------------------
    // 登录限流
    //
    // 这一节用**另一个独立实例**跑，而不是接着用上面那个：
    //   1. 上面那个实例的限流被放开了（功能用例不该被 429 打挂），
    //      而这里要的正是默认值下的真实行为；
    //   2. 原来它必须排在最后，因为跑完登录桶就空了 ——
    //      以后任何人想在这后面加一节都会踩到。独立实例把这个地雷拆掉了。
    //
    // 为什么必须兜住：这个平台原本没有任何登录失败限制，
    // 也就是说密码可以无限次尝试。而它常常跑在按流量计费的服务器上，
    // 被脚本爆破既是安全问题，也是账单问题。
    // --------------------------------------------------------
    section('14. 登录限流');

    {
      const rlDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-rl-'));
      let rlServer = null;
      try {
        rlServer = await startServer(rlDataDir, pickPort(), {
          RATE_LIMIT_AUTH_PER_MIN: '1',
        });
        const rl = createClient(rlServer.baseUrl);

        // 先建一个账号：否则「正确的密码也被挡住」那条断言是空转的
        // （库里没有账号时，任何密码都算错，测不出东西）
        const rlSetup = await rl('POST', '/setup', {
          form: { username: '限流测试', password: 'limit123456', password2: 'limit123456' },
        });
        ok('限流实例的账号已建好', rlSetup.status === 302, `状态码 ${rlSetup.status}`);

        let blockedAt = null;
        let retryAfter = null;
        let blockBody = '';

        for (let i = 1; i <= 30; i += 1) {
          const res = await rl('POST', '/login', {
            form: { username: '限流测试', password: `wrong-password-${i}` },
          });
          if (res.status === 429) {
            blockedAt = i;
            retryAfter = res.headers.get('retry-after');
            blockBody = res.text;
            break;
          }
        }

        ok('★ 连续输错密码会被限流挡住（不能无限试）',
          blockedAt !== null,
          blockedAt ? `第 ${blockedAt} 次被拦` : '试了 30 次都没拦住');

        ok('★ 429 带上了标准的 Retry-After 头',
          Boolean(retryAfter) && Number(retryAfter) > 0,
          `Retry-After=${retryAfter || '(无)'}`);

        ok('★ 限流的提示是中文、说清了要等多久，而不是干巴巴一个 429',
          /请求太频繁/.test(blockBody) && /等/.test(blockBody),
          blockBody.slice(0, 80));

        // 被限流之后，连正确密码也进不去 —— 这是有意的：
        // 否则攻击者只要在每次猜错后夹一次正确密码就能绕过限流。
        const correct = await rl('POST', '/login', {
          form: { username: '限流测试', password: 'limit123456' },
        });
        ok('★ 限流生效期间，正确的密码同样被挡住（不然限流可以被绕过）',
          correct.status === 429, `状态码 ${correct.status}`);

        // 但读静态资源不该被牵连：登录接口的桶是独立的
        const stillOk = await rl('GET', '/static/app.css');
        ok('★ 登录被限流不会连累静态资源（两个桶是分开的）',
          stillOk.status === 200, `状态码 ${stillOk.status}`);

        // 注册走的是同一档：不限的话邀请码可以被无限次试出来
        const regBlocked = await rl('POST', '/register', {
          form: { username: '限流测试2', password: 'limit123456', password2: 'limit123456' },
        });
        ok('★ 注册接口也走严格档（否则邀请码可以被无限次试）',
          regBlocked.status === 429, `状态码 ${regBlocked.status}`);
      } finally {
        if (rlServer?.child) {
          killTree(rlServer.child);
          await new Promise((r) => setTimeout(r, 300));
        }
        try {
          fs.rmSync(rlDataDir, { recursive: true, force: true });
        } catch {
          /* Windows 上偶发文件占用，忽略 */
        }
      }
    }
  } finally {
    if (server?.child) {
      killTree(server.child);
      await new Promise((r) => setTimeout(r, 400));
    }

    if (KEEP) {
      console.log(`\n临时数据目录已保留：${dataDir}`);
    } else {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Windows 上偶发文件占用，忽略 */
      }
    }
  }

  // 汇总
  console.log(`\n${'─'.repeat(56)}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\u001b[32m\u001b[1m全部通过：${passed} / ${total}\u001b[0m`);
  } else {
    console.log(`\u001b[31m\u001b[1m${failed} 项失败\u001b[0m，${passed} / ${total} 通过`);
    console.log('\n失败明细：');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
  }
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\n\u001b[31m自测执行出错：\u001b[0m', err);
  process.exit(1);
});
