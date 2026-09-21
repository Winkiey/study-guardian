/**
 * HTML 页面路由。
 *
 * 每个处理函数负责：查数据 → 调用对应 page 模块渲染 → 套上 layout 输出。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  badRequest,
  notFound,
  redirect,
  sendHtml,
  readBodyAuto,
  escapeHtml,
  unauthorized,
} from '../lib/http.js';
import config from '../config.js';
import { get } from '../db/index.js';
import {
  extractOfficeText,
  humanSize,
  readTextFile,
  uploadPath,
} from '../lib/files.js';
import {
  bootstrapState,
  clearSessionCookie,
  createUser,
  currentUser,
  findUserByUsername,
  hashPassword,
  isUsernameTaken,
  passwordProblem,
  setSessionCookie,
  usernameProblem,
  verifyPassword,
} from '../lib/auth.js';
import * as courses from '../lib/courses.js';
import * as assignments from '../lib/assignments.js';
import * as materials from '../lib/materials.js';
import * as notify from '../lib/notify/index.js';
import {
  getSettings,
  settingDefaults,
  getPeriodSchedule,
  hasCustomPeriodSchedule,
  DEFAULT_PERIOD_SCHEDULE,
} from '../lib/settings.js';
import { renderPage } from '../web/layout.js';
import { dashboardPage } from '../web/pages/dashboard.js';
import { timetablePage } from '../web/pages/timetable.js';
import { coursesPage, courseDetailPage } from '../web/pages/courses.js';
import { assignmentsPage } from '../web/pages/assignments.js';import { materialsPage, materialPreviewPage, renderUploadForm, renderMaterialEditForm } from '../web/pages/materials.js';
import { settingsPage, loginPage } from '../web/pages/settings.js';
import { importManualPage, importPage, importResultPage } from '../web/pages/import.js';
import { converterStatus } from '../lib/convert.js';
import { schedulerStatus } from '../lib/scheduler.js';
import { subscriptionUrl } from '../lib/export/ics-export.js';
import { parseIcsTimetable, importCourses } from '../lib/import/ics-import.js';
import { extractTimetableImage } from '../lib/import/pdf-image.js';

/**
 * 没有图时占位用的 scan。
 * 路由在「没收到文件」和「解不出图」两种情况下都要渲染同一个页面（带着错误提示），
 * 而页面要求 scan 一定有 dataUrl/width/height —— 用一张 1×1 的透明 PNG 兜底，
 * 免得为了错误分支在模板里到处写 if。
 */
const EMPTY_SCAN = {
  dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  width: 0,
  height: 0,
};
import { parseCourseCsv, csvTemplate } from '../lib/import/csv.js';
import { addDays, nowStr, startOfWeek, todayStr } from '../lib/datetime.js';
import { weekOfDate } from '../lib/weeks.js';

/** 统一的页面输出 */
/**
 * 用户名不存在时拿来「陪跑」的假哈希。
 *
 * 目的是让「用户名不存在」和「密码错误」两条路的耗时接近 ——
 * 不然光靠响应时间就能把用户名试出来（见 POST /login 里的说明）。
 * 这个哈希对应的是一个**谁都猜不到、也永远不会被设置**的密码，
 * 所以就算有人拿它登录也过不了。内容只是一串固定值，不含任何真实账号信息。
 */
const DUMMY_PASSWORD_HASH = hashPassword(`not-a-real-password-${'x'.repeat(32)}`);

function output(res, page, extras = {}) {
  sendHtml(res, renderPage({
    title: page.title,
    active: page.active,
    body: page.body,
    wide: page.wide,
    bare: page.bare,
    ...extras,
  }));
}

/** 每个页面都要的导航角标数据 */
function navStats(userId) {
  return {
    pendingAssignments: assignments.assignmentStats(userId).pending,
    materialCount: Number(get('SELECT COUNT(*) AS c FROM materials WHERE user_id = ?', userId)?.c || 0),
  };
}

export function registerPages(router) {
  // ==========================================================
  // 注册 / 登录 / 初始化
  // ==========================================================

  /**
   * 注册页每次都要重新算：站点是不是还没有任何账号、邀请码配了没。
   * 不能缓存 —— 管理员在 .env 里填上邀请码后重启，
   * 这个判断必须立刻跟着变，否则页面还在说「未开放注册」。
   */
  const policy = () => registerPolicy();

  /** 把一个登录/注册页渲染出去（两个 GET 入口和所有失败回显共用） */
  const renderAuth = (res, { mode, error = '', info = '', username = '' }) => {
    const p = policy();
    output(res, loginPage({
      mode,
      error,
      info,
      username,
      registerOpen: p.open,
      inviteRequired: p.inviteRequired,
    }), { user: null, stats: {} });
  };

  router.get('/login', async (ctx) => {
    if (currentUser(ctx.req)) return redirect(ctx.res, '/');
    // 注销成功后前端会带着 ?deleted=用户名 回到这里。
    // 不说一句「已注销」的话，用户只会看到自己莫名其妙被登出了。
    const deleted = String(ctx.url.searchParams.get('deleted') || '').trim();
    renderAuth(ctx.res, {
      mode: 'login',
      info: deleted
        ? `账号「${deleted}」已注销，数据已全部删除。谢谢你用过它。`
        : '',
    });
  });

  router.get('/register', async (ctx) => {
    if (currentUser(ctx.req)) return redirect(ctx.res, '/');
    renderAuth(ctx.res, { mode: 'register' });
  });

  // /setup 是早期版本唯一的入口，README、老书签和端到端测试都还打着它，
  // 所以不能删。语义收窄成「站点还没账号时的初始化」，行为等同 /register。
  router.get('/setup', async (ctx) => {
    if (bootstrapState().initialized) return redirect(ctx.res, currentUser(ctx.req) ? '/' : '/login');
    renderAuth(ctx.res, { mode: 'register' });
  });

  /**
   * 建账号。POST /register 和 POST /setup 共用这一份：
   * 两者的差别只有 URL，校验、建默认学期、发会话完全一样，
   * 复制两份必然会有一天改一边忘一边。
   */
  async function createAccount(ctx) {
    const parsed = await readBodyAuto(ctx.req);
    const form = parsed.data || {};
    const username = String(form.username || '').trim();
    const password = String(form.password || '');
    const password2 = String(form.password2 || '');
    const invite = String(form.inviteCode || '').trim();

    const fail = (message) => renderAuth(ctx.res, { mode: 'register', error: message, username });

    // 已经登录的人不该从注册接口再建一个号：注册成功会换掉会话 Cookie，
    // 于是「我以为在给朋友建号，结果自己被切成了新账号」—— 数据看着像丢了。
    // GET /register 已经跳回首页，POST 这边要跟上，否则守卫只挡住了一半。
    if (currentUser(ctx.req)) return redirect(ctx.res, '/');

    const p = policy();

    if (!p.open) {
      return fail('本站当前未开放注册。想用的话，请联系站点管理员索取邀请码。');
    }

    const nameProblem = usernameProblem(username);
    if (nameProblem) return fail(nameProblem);

    const passProblem = passwordProblem(password);
    if (passProblem) return fail(passProblem);

    if (password !== password2) return fail('两次输入的密码不一致');

    // 邀请码只在需要时校验。用 timingSafeEqual 是为了不靠「比较用了几纳秒」
    // 泄露「前几位猜对了」—— 邀请码通常不长，逐字符比较的耗时差是可以量出来的。
    if (p.inviteRequired && !inviteMatches(invite)) {
      return fail('邀请码不正确。邀请码由站点管理员提供。');
    }

    // 先查一次给出友好提示；真正的唯一性由数据库的唯一索引兜底
    // （两处都要有：这里管体验，索引管正确性）
    if (isUsernameTaken(username)) {
      return fail(`用户名「${username}」已经有人用了，换一个吧`);
    }

    let user;
    try {
      user = createUser({
        username,
        password,
        displayName: String(form.displayName || '').trim(),
        school: String(form.school || '').trim() || '东北财经大学',
      });
    } catch (err) {
      return fail(err.message);
    }

    // 顺手建一个默认学期，省得用户一进来课表算不出周次
    const monday = startOfWeek(todayStr());
    courses.createTerm(user.id, {
      name: courses.guessTermName(monday),
      startDate: monday,
      weekCount: 18,
      isActive: true,
    });

    setSessionCookie(ctx.res, user.id);
    redirect(ctx.res, '/');
  }

  router.post('/register', createAccount);

  /**
   * 老入口，语义收窄成「站点还没有账号时的初始化」。
   *
   * 必须有这道守卫：配了邀请码之后 policy.open 是 true，
   * 如果 /setup 不做检查，它就会变成一条绕过「站点已就绪」状态、
   * 无限建号的旁路 —— 而它本来只是老书签和老测试在打的一个地址。
   */
  router.post('/setup', async (ctx) => {
    if (bootstrapState().initialized) return redirect(ctx.res, '/login');
    return createAccount(ctx);
  });

  router.post('/login', async (ctx) => {
    const parsed = await readBodyAuto(ctx.req);
    const form = parsed.data || {};
    const username = String(form.username || '').trim();
    const password = String(form.password || '');

    const user = findUserByUsername(username);
    // 用户名不存在和密码错误给**同一句**提示：
    // 分开说等于免费提供一个「这个用户存在吗」的探测接口。
    //
    // 但光统一文案还不够：用户不存在时直接短路、根本不跑 scrypt，
    // 而 scrypt 是**故意很慢**的（N=16384，几十毫秒）。
    // 于是「用户名存在」比「不存在」明显慢一截，看响应时间就能把用户名试出来 ——
    // 同一件事换了个侧信道而已。所以不存在时也拿一个假的哈希跑一遍，
    // 让两条路耗时接近。用同一个常量哈希，不依赖任何真实账号。
    if (!user) {
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return renderAuth(ctx.res, {
        mode: 'login',
        error: '用户名或密码不正确',
        username,
      });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return renderAuth(ctx.res, {
        mode: 'login',
        error: '用户名或密码不正确',
        username,
      });
    }

    setSessionCookie(ctx.res, user.id);
    redirect(ctx.res, '/');
  });

  router.post('/logout', async (ctx) => {
    clearSessionCookie(ctx.res);
    redirect(ctx.res, '/login');
  });

  // ---- 以下页面都需要登录 ----
  const page = (handler) => async (ctx) => {
    const user = currentUser(ctx.req);
    if (!user) {
      // 页面类请求直接跳登录页（而不是返回 401 JSON）
      return redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url.pathname)}`);
    }
    ctx.user = user;
    return handler(ctx);
  };

  // ==========================================================
  // 总览
  // ==========================================================

  router.get('/', page(async (ctx) => {
    const userId = ctx.user.id;
    const todayRes = courses.todayOccurrences(userId);
    const todayCourses = todayRes.occurrences;
    const currentHm = nowStr().slice(11, 16);

    // 找下一节课：先看今天剩下的，再看未来 7 天
    let nextCourse = todayCourses.find((c) => c.endTime >= currentHm);
    if (!nextCourse) {
      const upcoming = courses.upcomingOccurrences(userId, 7).occurrences;
      nextCourse = upcoming.find((c) => `${c.date} ${c.startTime}` > nowStr());
    }

    const weekRes = courses.thisWeekOccurrences(userId);

    output(ctx.res, dashboardPage({
      user: ctx.user,
      termProgress: courses.activeTermProgress(userId),
      todayCourses,
      assignments: assignments.upcomingAssignments(userId, 14, 6),
      recentMaterials: materials.listMaterials(userId, { limit: 4 }),
      stats: assignments.assignmentStats(userId),
      nextCourse,
      schedulerOk: notify.listChannels(userId).filter((c) => c.enabled).length > 0,
      // 新同学进门时首页一片空白，得有人告诉他先做哪三件事。
      // 判据用「有没有课程」：课表是其它一切的基础（没有课就没有课可上、
      // 作业也没法归属），所以它是最合适的「入门了没有」的分界点。
      courseCount: courses.listCourses(userId).length,
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // ==========================================================
  // 课程表
  // ==========================================================

  router.get('/timetable', page(async (ctx) => {
    const userId = ctx.user.id;
    const term = courses.getActiveTerm(userId);

    // 指定第几周，或默认当前周
    const weekParam = Number.parseInt(ctx.url.searchParams.get('week') || '', 10);
    let viewWeek = term ? weekOfDate(term.start_date, todayStr()) : 1;
    if (Number.isFinite(weekParam) && weekParam >= 1) viewWeek = weekParam;
    viewWeek = Math.max(1, Math.min(viewWeek, Number(term?.week_count || 18)));

    let weekStart;
    let weekEnd;
    if (term) {
      const { dateForWeekday } = await import('../lib/weeks.js');
      weekStart = dateForWeekday(term.start_date, viewWeek, 1);
      weekEnd = dateForWeekday(term.start_date, viewWeek, 7);
    } else {
      weekStart = startOfWeek(todayStr());
      weekEnd = addDays(weekStart, 6);
    }

    const { occurrences } = term
      ? courses.occurrencesInRange(userId, weekStart, weekEnd, { termId: term.id })
      : { occurrences: [] };

    output(ctx.res, timetablePage({
      user: ctx.user,
      term,
      termProgress: courses.activeTermProgress(userId),
      weekStart,
      weekEnd,
      occurrences,
      courses: courses.listCourses(userId),
      viewWeek,
      totalWeeks: Number(term?.week_count || 18),
      importHint: term ? textHint() : '',
      // 课表的时间轴按用户自己的作息表分行
      periodSchedule: getPeriodSchedule(userId),
      hasCustomPeriods: hasCustomPeriodSchedule(userId),
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // ==========================================================
  // 课程
  // ==========================================================

  router.get('/courses', page(async (ctx) => {
    const userId = ctx.user.id;
    const keyword = String(ctx.url.searchParams.get('q') || '').trim();

    let list = courses.listCourses(userId);
    if (keyword) {
      const lower = keyword.toLowerCase();
      list = list.filter((c) => (
        c.name.toLowerCase().includes(lower)
        || String(c.teacher || '').toLowerCase().includes(lower)
        || String(c.code || '').toLowerCase().includes(lower)
      ));
    }

    const totalCredits = Math.round(
      list.reduce((sum, c) => sum + (Number(c.credits) || 0), 0) * 10,
    ) / 10;
    const weeklyHours = list.reduce((sum, c) => sum + c.sessions.length, 0);

    output(ctx.res, coursesPage({
      user: ctx.user,
      courses: list,
      term: courses.getActiveTerm(userId),
      stats: { totalCredits, weeklyHours },
      keyword,
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  router.get('/courses/:id', page(async (ctx) => {
    const userId = ctx.user.id;
    const id = Number.parseInt(ctx.params.id, 10);
    const course = courses.getCourseDetail(userId, id);
    if (!course) throw notFound('课程不存在');

    output(ctx.res, courseDetailPage({
      user: ctx.user,
      course,
      materials: materials.listMaterials(userId, { courseId: id, limit: 12 }),
      assignments: assignments.listAssignments(userId, { courseId: id }).slice(0, 12),
      assignmentScore: assignments.assignmentScoreSummary(userId, id),
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // ==========================================================
  // 作业
  // ==========================================================

  router.get('/assignments', page(async (ctx) => {
    const userId = ctx.user.id;
    const status = ctx.url.searchParams.get('status') || '';
    const courseId = ctx.url.searchParams.get('courseId') || '';
    const highlightId = ctx.url.searchParams.get('highlight') || '';

    const list = assignments.listAssignments(userId, {
      courseId: courseId || undefined,
      // 「已逾期」是派生状态，走 overdue 那条路（见 listAssignments 的注释）。
      // 其余情况：done 单独放行，all 靠 includeDone 放行，默认只看没做完的。
      overdue: status === 'overdue',
      status: status === 'done' ? 'done' : undefined,
      includeDone: status === 'all' || status === 'done',
    });

    const channels = notify.listChannels(userId).filter((c) => c.enabled);
    const settings = getSettings(userId, settingDefaults());

    output(ctx.res, assignmentsPage({
      user: ctx.user,
      assignments: list,
      grouped: assignments.groupByUrgency(list),
      courses: courses.listCourses(userId),
      stats: assignments.assignmentStats(userId),
      filters: { status, courseId, highlightId },
      channels,
      defaultOffsets: settings.default_remind_offsets || '1440,120',
      highlightId,
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // ==========================================================
  // 资料
  // ==========================================================

  router.get('/materials', page(async (ctx) => {
    const userId = ctx.user.id;
    const keyword = String(ctx.url.searchParams.get('q') || '').trim();
    const category = ctx.url.searchParams.get('category') || '';
    const courseId = ctx.url.searchParams.get('courseId') || '';

    const list = materials.listMaterials(userId, {
      keyword: keyword || undefined,
      category: category || undefined,
      courseId: courseId || undefined,
      limit: 200,
    });

    output(ctx.res, materialsPage({
      user: ctx.user,
      materials: list,
      courses: courses.listCourses(userId),
      stats: materials.materialStats(userId, courseId || undefined),
      filters: { keyword, category, courseId },
      storage: storageInfo(),
      // 上传与编辑表单作为 <template> 渲染进页面，前端 JS 拿来开弹窗
      uploadFormTemplate: renderUploadForm({
        courses: courses.listCourses(userId),
        maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
        currentCourseId: courseId,
      }),
      editFormTemplate: renderMaterialEditForm({ courses: courses.listCourses(userId) }),
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // 上传表单模板要注入到页面里（前端 JS 用它开弹窗）
  router.get('/materials/upload-form', page(async (ctx) => {
    sendHtml(ctx.res, renderUploadForm({
      courses: courses.listCourses(ctx.user.id),
      maxUploadMB: Math.round(config.maxUploadBytes / 1024 / 1024),
      currentCourseId: ctx.url.searchParams.get('courseId') || '',
    }), 200);
  }));

  router.get('/materials/:id', page(async (ctx) => {
    const userId = ctx.user.id;
    const id = Number.parseInt(ctx.params.id, 10);
    const material = materials.getMaterial(userId, id);
    if (!material) throw notFound('资料不存在');

    // 文本类资料读取正文；Office 类尝试读取抽取出来的结构
    let textContent = '';
    let officeData = null;

    if (material.kind === 'text') {
      try {
        textContent = await readTextFile(uploadPath(material.stored_name), 400_000);
      } catch (err) {
        textContent = `（读取失败：${err.message}）`;
      }
    } else if (material.previewMode === 'office') {
      const extracted = await tryExtractOffice(material);
      officeData = extracted.data;
      textContent = extracted.text;
    } else if (material.previewMode === 'slides') {
      // 图片是逐页导出的，页数要数一下目录才知道。
      // 只有预览页需要这个数（列表页不渲染图片），所以在这里数就行。
      material.slideImageCount = materials.listSlideImages(material).length;
    }

    output(ctx.res, materialPreviewPage({
      user: ctx.user,
      material,
      siblings: materials.siblingMaterials(userId, id, material.course_id),
      textContent,
      officeData,
      // 预览页也要能「编辑资料信息」，把表单模板一并渲染进页面
      editFormTemplate: renderMaterialEditForm({ courses: courses.listCourses(userId) }),
    }), { user: ctx.user, stats: navStats(userId), wide: true });
  }));

  // ==========================================================
  // 设置
  // ==========================================================

  router.get('/settings', page(async (ctx) => {
    const userId = ctx.user.id;

    output(ctx.res, settingsPage({
      user: ctx.user,
      settings: getSettings(userId, settingDefaults()),
      terms: courses.listTerms(userId),
      channels: notify.listChannels(userId),
      converter: converterStatus(),
      scheduler: schedulerStatus(),
      logs: notify.recentLogs(userId, 30),
      logStats: notify.logStats(userId),
      storage: storageInfo(),
      subscription: subscriptionUrl(userId, { host: requestBase(ctx.req) }),
      officeConvertEnabled: config.enableOfficeConvert,
      periodSchedule: getPeriodSchedule(userId),
      defaultPeriodSchedule: DEFAULT_PERIOD_SCHEDULE,
      hasCustomPeriods: hasCustomPeriodSchedule(userId),
    }), { user: ctx.user, stats: navStats(userId) });
  }));

  // ==========================================================
  // 导入向导
  // ==========================================================

  router.get('/import', page(async (ctx) => {
    const userId = ctx.user.id;

    // 下载 CSV 模板
    if (ctx.url.searchParams.get('template') === 'csv') {
      const body = Buffer.from(csvTemplate(), 'utf8');
      ctx.res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''%E8%AF%BE%E8%A1%A8%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.csv",
        'Content-Length': body.length,
      });
      ctx.res.end(body);
      return;
    }

    output(ctx.res, importPage(importPageData(userId, ctx)), {
      user: ctx.user,
      stats: navStats(userId),
    });
  }));

  /**
   * 「上传课表 PDF → 看原图 + 手动录入」。
   *
   * 为什么不做 OCR：这份课表的**主体是一张位图**（实测 3366×1850），
   * 文字层里只有标题和学号姓名，没有任何课程内容。OCR 中文课程名错一个字，
   * 整学期课表就是错的，而且要往服务器上装 poppler + tesseract + 中文包。
   * 所以换成「把原图给用户自己看」—— 用户读自己的课表零误差，
   * 而且换任何学校的版式都能用。
   *
   * 图内联成 data URL 传给页面，**不落盘**：服务器上不留用户的课表图片，
   * 也就不需要新增取图路由和缓存清理。
   */
  router.post('/import/scan', page(async (ctx) => {
    const userId = ctx.user.id;
    const parsed = await readBodyAuto(ctx.req);
    const raw = parsed.data || {};
    const file = parsed.type === 'multipart' ? raw.files?.[0] : null;

    const renderManual = (extra) => output(ctx.res, importManualPage(importPageData(userId, ctx, extra)), {
      user: ctx.user,
      stats: navStats(userId),
    });

    if (!file?.data?.length) {
      return renderManual({
        error: '没有收到文件。请选择教务系统导出的课表 PDF。',
        scan: EMPTY_SCAN,
      });
    }

    let img;
    try {
      // 只处理**解析出来的图**，不看扩展名和 MIME —— 那两个都是用户能随便写的
      img = extractTimetableImage(file.data);
    } catch (err) {
      // 解不出来时要说清楚原因，并指一条别的路。
      // 尤其不能返回一张全黑的图 —— 那会让用户以为「导进来了，只是看不清」。
      return renderManual({ error: err.message, scan: EMPTY_SCAN });
    }

    return renderManual({
      scan: {
        dataUrl: `data:${img.mime};base64,${img.data.toString('base64')}`,
        width: img.width,
        height: img.height,
      },
    });
  }));

  /**
   * 导入（传统表单提交，服务端直接渲染预览页）。
   *
   * 为什么不用 AJAX：预览页是一整页内容，用表单提交更简单可靠，
   * 而且刷新/后退都符合直觉。
   */
  router.post('/import', page(async (ctx) => {
    const userId = ctx.user.id;
    const parsed = await readBodyAuto(ctx.req);

    const raw = parsed.data || {};
    const isMultipart = parsed.type === 'multipart';
    const fields = isMultipart ? raw.fields : raw;
    const file = isMultipart ? raw.files?.[0] : null;

    // 判断是「解析预览」还是「确认导入」
    if (fields.payload) {
      let payload;
      try {
        payload = JSON.parse(String(fields.payload));
      } catch {
        throw badRequest('导入数据损坏，请重新解析');
      }

      let termId = fields.termId;
      if (termId === 'new' || !termId) {
        const start = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.termStart || ''))
          ? String(fields.termStart)
          : startOfWeek(todayStr());
        termId = courses.createTerm(userId, {
          name: courses.guessTermName(start),
          startDate: start,
          weekCount: 18,
          isActive: true,
        });
      }

      const result = importCourses(userId, payload, Number(termId), {
        onConflict: String(fields.onConflict || 'skip'),
      });

      return output(ctx.res, importResultPage({ result, source: fields.source || 'csv' }), {
        user: ctx.user,
        stats: navStats(userId),
      });
    }

    // 解析阶段
    let text = '';
    let source = 'ics';

    if (file) {
      text = decodeTextBuffer(file.data);
      if (!/\.ics$/i.test(file.filename) && !text.includes('BEGIN:VCALENDAR')) {
        source = 'csv';
      }
    } else if (fields.text) {
      text = String(fields.text);
      source = text.includes('BEGIN:VCALENDAR') ? 'ics' : 'csv';
    }

    // 解析失败时要把用户提交的东西**还回去**，不能让他重新粘一遍。
    //
    // 粘贴的内容可以原样回填；上传的文件不行 —— 浏览器出于安全不允许
    // 给 file 输入框赋值，所以那种情况只把文件名带回去，明确告诉用户
    // 「你传的是这个，需要重新选一次」。
    //
    // 文件内容要不要也塞进文本框？只在它确实是文本、而且不太大时才塞：
    // 传错一个二进制文件的话，把乱码倒进文本框比不填还让人困惑，
    // 而几 MB 的 .ics 塞进页面也会明显拖慢渲染。
    const looksLikeText = text.length <= 100_000 && !text.includes('\u0000');
    const draft = {
      text: file ? (looksLikeText ? text : '') : String(fields.text || ''),
      filename: file ? file.filename : '',
    };

    if (!text.trim()) {
      return output(ctx.res, importPage(importPageData(userId, ctx, {
        error: '没有收到文件或表格内容。请选择文件，或把表格内容粘贴到文本框里。',
        draft,
      })), { user: ctx.user, stats: navStats(userId) });
    }

    let parsedResult;
    try {
      parsedResult = source === 'ics'
        ? parseIcsTimetable(text)
        // 节次换算要用用户自己的作息表，不然「第 3-4 节」会套上别人学校的时间
        : parseCourseCsv(text, { periods: getPeriodSchedule(userId) });
    } catch (err) {
      return output(ctx.res, importPage(importPageData(userId, ctx, {
        error: `解析失败：${err.message}`,
        draft,
      })), { user: ctx.user, stats: navStats(userId) });
    }

    // 一门课都没识别出来 —— 别把用户扔到一个「0 门课程」的预览页上。
    //
    // 这才是真正会丢东西的那条路（比审计里说的 catch 分支常见得多）：
    // 两个解析器都**不抛异常**，遇到看不懂的内容只是记一条 warning 然后
    // 返回空结果。于是用户看到的是「解析成功」的横幅 + 一个空表格，
    // 既没人告诉他哪里不对，也没有回到上一步的入口 —— 想改的话只能
    // 重新打开 /import，而刚才粘的那一大段已经没了，得回教务系统重新复制。
    //
    // 现在直接退回选择屏，并把原文回填进文本框，用户可以就地改。
    if (parsedResult.courses.length === 0) {
      const why = (parsedResult.warnings || []).join(' ')
        || '没能从这段内容里识别出课程。';
      return output(ctx.res, importPage(importPageData(userId, ctx, {
        error: `${why}你提交的内容还留在下面的框里，可以直接改。`,
        draft,
      })), { user: ctx.user, stats: navStats(userId) });
    }

    // 标记哪些课程已存在（预览表格里给个提示）
    const existing = new Set(courses.listCourses(userId).map((c) => c.name));
    const conflict = {};
    for (const c of parsedResult.courses) {
      if (existing.has(c.name)) conflict[c.name] = true;
    }

    output(ctx.res, importPage(importPageData(userId, ctx, {
      preview: {
        source,
        parsed: parsedResult,
        warnings: parsedResult.warnings || [],
        termStart: source === 'ics' ? parsedResult.termStart : startOfWeek(todayStr()),
        termName: courses.guessTermName(
          source === 'ics' ? (parsedResult.termStart || todayStr()) : todayStr(),
        ),
        conflict,
      },
    })), { user: ctx.user, stats: navStats(userId) });
  }));

  return router;
}

// ============================================================
// 辅助
// ============================================================

/**
 * 注册闸门。
 *
 * 允许注册的只有两种情形：
 *   1. 站点还没有任何账号 —— 管理员自己得先能建号，这时不要邀请码；
 *   2. .env 里配了 INVITE_CODE —— 凭码注册。
 *
 * 两者都不满足就是关闭注册，而这是**默认状态**。
 * 刻意选这个默认值：这台机器按流量计费、端口开在公网，
 * 敞开的注册入口等于把账单和磁盘交给路过的扫描器。
 * 需要的人多填一行 .env 就能打开；被滥用却是不可逆的。
 *
 * @returns {{isFirst: boolean, open: boolean, inviteRequired: boolean}}
 */
export function registerPolicy() {
  const isFirst = !bootstrapState().initialized;
  const hasInvite = Boolean(config.inviteCode);
  return {
    isFirst,
    open: isFirst || hasInvite,
    inviteRequired: !isFirst && hasInvite,
  };
}

/**
 * 邀请码比对，用时间恒定比较。
 *
 * 不直接用 === 是因为它的耗时随「前几位对上了」增长，
 * 邀请码通常不长，这种差异是可以被量出来的。
 * 长度不同时 timingSafeEqual 会抛错，所以先比长度 ——
 * 长度本身泄露不了内容，可以接受。
 */
export function inviteMatches(input) {
  const expected = String(config.inviteCode || '');
  if (!expected) return false;
  const a = Buffer.from(String(input ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 组装导入页需要的公共数据。
 * 四个分支（首次进入 / 出错 / 解析失败 / 解析成功）都要用同一套，
 * 集中在这里避免漏掉字段——之前就是因为漏了作息表，页面渲染会崩。
 */
function importPageData(userId, ctx, extra = {}) {
  return {
    user: ctx.user,
    terms: courses.listTerms(userId),
    courses: courses.listCourses(userId),
    // 导入页要展示「当前用的是哪套作息时间」
    periodSchedule: getPeriodSchedule(userId),
    hasCustomPeriods: hasCustomPeriodSchedule(userId),
    ...extra,
  };
}

function textHint() {
  return '可以把教务处导出的 .ics 文件传上来，一次把整学期课表导进来。';
}

/** 请求的对外地址，用于生成订阅链接 */
function requestBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  if (host) return `${proto}://${host}`;
  return `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
}

/** 磁盘占用信息 */
function storageInfo() {
  const sum = (dir) => {
    try {
      let total = 0;
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) walk(p);
          else total += fs.statSync(p).size;
        }
      };
      walk(dir);
      return total;
    } catch {
      return 0;
    }
  };

  const materialsBytes = sum(config.uploadDir);
  const cacheBytes = sum(config.cacheDir);
  const dbBytes = (() => {
    try {
      return fs.statSync(config.dbFile).size;
    } catch {
      return 0;
    }
  })();

  return {
    materialsBytes,
    materialsLabel: humanSize(materialsBytes),
    cacheBytes,
    cacheLabel: humanSize(cacheBytes),
    dbBytes,
    dbLabel: humanSize(dbBytes),
    lowSpace: false,
  };
}

/** 文本解码（UTF-8 / GB18030） */
function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

/** 尝试抽取 Office 文本用于网页版预览 */
async function tryExtractOffice(material) {
  try {
    const result = await extractOfficeText(uploadPath(material.stored_name), material.ext);
    if (result.ok) return { data: result.data, text: material.text_cache || '' };
  } catch {
    /* 抽不出来就退回已有的纯文本缓存 */
  }
  return { data: null, text: material.text_cache || '' };
}
