/**
 * JSON API 路由。
 *
 * 约定：
 *   - 所有接口都要登录（除了 auth 相关）
 *   - 出错统一返回 { error: '中文说明' }，HTTP 状态码有意义
 *   - 成功返回具体数据，前端拿去做局部刷新
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  HttpError,
  badRequest,
  notFound,
  readJson,
  readBodyAuto,
  sendJson,
  unauthorized,
} from '../lib/http.js';
import config from '../config.js';
import { all, get, run } from '../db/index.js';
import { changePassword, clearSessionCookie, requireUser, verifyPassword } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import * as courses from '../lib/courses.js';
import * as assignments from '../lib/assignments.js';
import * as materials from '../lib/materials.js';
import {
  DEFAULT_MATERIAL_CATEGORY,
  MATERIAL_CATEGORIES,
  isKnownCategory,
} from '../lib/materials.js';
import * as notify from '../lib/notify/index.js';
import {
  getSettings,
  setSettings,
  settingDefaults,
  getPeriodSchedule,
  savePeriodSchedule,
  clearPeriodSchedule,
  hasCustomPeriodSchedule,
  DEFAULT_PERIOD_SCHEDULE,
} from '../lib/settings.js';
import { detectKind, normalizeExt, sanitizeFilename } from '../lib/files.js';
import { runOnce, schedulerStatus } from '../lib/scheduler.js';
import { parseIcsTimetable, importCourses } from '../lib/import/ics-import.js';
import { parseCourseCsv } from '../lib/import/csv.js';
import { buildCalendar, exportStats, subscriptionUrl } from '../lib/export/ics-export.js';
import { resetConverterCache } from '../lib/convert.js';

/** 包装处理器：统一登录校验与错误处理 */
function guard(handler) {
  return async (ctx) => {
    ctx.user = requireUser(ctx.req);
    return handler(ctx);
  };
}

/** 取整数参数，非法时报 400 */
function intParam(ctx, name) {
  const raw = ctx.params[name];
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`参数 ${name} 不合法`);
  return n;
}

/** 取字符串字段，带长度限制 */
function str(value, maxLength = 2000) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, maxLength);
}

/**
 * 判断 'YYYY-MM-DD' 是不是星期一。
 *
 * 学期起始日必须是周一——课表的周次全部基于「第 1 周周一」推算，
 * 填成别的星期会让所有课的周次整体偏移，而且不容易发现。
 * 用本地时间解析，避免 new Date('YYYY-MM-DD') 按 UTC 解释导致差一天。
 */
function isMonday(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getDay() === 1;
}

/**
 * 解析学分 / 学时这类数字字段。
 *
 * 关键点：填了非数字时要**报错**，不能静默当成空值。
 * 之前的实现是 `Number('abc')` → NaN → 存成 null，
 * 用户看到的现象就是「明明填了、也保存了，但值没变」——很难排查。
 *
 * @returns {number|null|undefined} undefined 表示请求里没带这个字段（保持原值不变）
 */
function parseAmountField(value, label, max) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const s = String(value).trim();
  if (!s) return null;

  // 全角数字转半角，并容忍「3学分」这种带单位的写法
  const normalized = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // 负号不在数字正则里，不显式拦住的话「-1」会被当成「1」——
  // 静默把负数变成正数，比直接报错更糟
  if (normalized.includes('-')) {
    throw badRequest(`${label}「${s}」不能是负数`);
  }

  const m = /(\d+(?:\.\d+)?)/.exec(normalized);
  if (!m) throw badRequest(`${label}「${s}」不是数字，请填例如 3 或 3.5`);

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw badRequest(`${label}「${s}」超出合理范围（0 ~ ${max}）`);
  }
  return n;
}

/** 从请求体里取出并校验学分 / 学时字段 */
function withAmountFields(body) {
  return {
    ...body,
    credits: parseAmountField(body.credits, '学分', 30),
    hours: parseAmountField(body.hours, '学时', 2000),
  };
}

/** 资料分类的参数名，报错时说清楚 */
const CATEGORY_LABEL_TEXT = '分类';

/**
 * 校验资料分类。
 *
 * 空值当成「没填」，用默认分类；填了但不认识就**报错**，不要静默改成默认值 ——
 * 那会让用户以为自己选的生效了（和学分那个坑同一类）。
 */
function normalizeCategory(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (!isKnownCategory(raw)) {
    throw badRequest(
      `${CATEGORY_LABEL_TEXT}「${raw}」不存在。可选：${MATERIAL_CATEGORIES.map((c) => c.key).join(' / ')}`,
    );
  }
  return raw;
}

export function registerApi(router) {
  // ==========================================================
  // 课程
  // ==========================================================

  router.post('/api/courses', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const name = str(body.name, 200).trim();
    if (!name) throw badRequest('课程名称不能为空');

    const existing = courses.findCourseByName(ctx.user.id, name);
    if (existing) throw badRequest(`已经有一门叫「${name}」的课程了`);

    const term = courses.getActiveTerm(ctx.user.id);
    const id = courses.createCourse(ctx.user.id, {
      ...withAmountFields(body),
      name,
      termId: body.termId || term?.id || null,
    });

    sendJson(ctx.res, { ok: true, course: courses.getCourseDetail(ctx.user.id, id) }, 201);
  }));

  router.get('/api/courses', guard(async (ctx) => {
    sendJson(ctx.res, { courses: courses.listCourses(ctx.user.id) });
  }));

  router.get('/api/courses/:id', guard(async (ctx) => {
    const course = courses.getCourseDetail(ctx.user.id, intParam(ctx, 'id'));
    if (!course) throw notFound('课程不存在');
    sendJson(ctx.res, { course });
  }));

  router.patch('/api/courses/:id', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const id = intParam(ctx, 'id');
    if (!courses.getCourseDetail(ctx.user.id, id)) throw notFound('课程不存在');

    courses.updateCourse(ctx.user.id, id, withAmountFields(body));
    sendJson(ctx.res, { ok: true, course: courses.getCourseDetail(ctx.user.id, id) });
  }));

  /**
   * 批量设置学分 / 学时。
   *
   * 校验策略：**所有条目全部校验通过之后，才进事务写库**。
   * 任何一条不合法就整体拒绝，绝不留下「改了一半」的结果——
   * 这是这个功能最容易出 bug 的地方。
   *
   * 返回体里带上最新的课程列表，前端可以直接核对，
   * 不用再发一次请求。
   */
  router.post('/api/courses/batch-credits', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!rawItems.length) throw badRequest('没有选择任何课程');
    if (rawItems.length > 300) {
      throw badRequest(`一次最多修改 300 门课程，当前提交了 ${rawItems.length} 门`);
    }

    const seen = new Set();
    const items = [];

    for (const raw of rawItems) {
      const id = Number.parseInt(raw?.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        throw badRequest('课程编号不合法（本次没有修改任何课程）');
      }

      if (seen.has(id)) {
        throw badRequest(`课程编号 ${id} 重复提交，请刷新页面后重试（本次没有修改任何课程）`);
      }
      seen.add(id);

      // 归属校验：拿不到就说明不存在或不属于当前用户
      const course = courses.getCourseDetail(ctx.user.id, id);
      if (!course) {
        throw badRequest(`课程编号 ${id} 不存在或不属于你（本次没有修改任何课程）`);
      }

      if (!('credits' in raw)) {
        throw badRequest(`「${course.name}」缺少学分值（本次没有修改任何课程）`);
      }

      let credits;
      let hours;
      try {
        credits = parseAmountField(raw.credits, '学分', 30);
        // 学时是可选的：请求里没带这个字段就保持原值，带了才改
        hours = ('hours' in raw) ? parseAmountField(raw.hours, '学时', 2000) : undefined;
      } catch (err) {
        throw badRequest(`「${course.name}」${err.message}（本次没有修改任何课程）`);
      }

      items.push({ id, credits, hours });
    }

    const changed = courses.batchUpdateCourseAmounts(ctx.user.id, items);

    sendJson(ctx.res, {
      ok: true,
      changed,
      courses: courses.listCourses(ctx.user.id).map((c) => ({
        id: c.id,
        name: c.name,
        credits: c.credits,
        hours: c.hours,
      })),
    });
  }));

  router.delete('/api/courses/:id', guard(async (ctx) => {
    const ok = courses.deleteCourse(ctx.user.id, intParam(ctx, 'id'));
    if (!ok) throw notFound('课程不存在');
    sendJson(ctx.res, { ok: true });
  }));

  router.put('/api/courses/:id/sessions', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const id = intParam(ctx, 'id');
    if (!courses.getCourseDetail(ctx.user.id, id)) throw notFound('课程不存在');

    const list = Array.isArray(body.sessions) ? body.sessions : [];
    for (const s of list) {
      const weekday = Number(s.weekday);
      if (!Number.isFinite(weekday) || weekday < 1 || weekday > 7) {
        throw badRequest('星期必须是 1-7 之间的数字');
      }
      if (!/^\d{1,2}:\d{2}$/.test(String(s.startTime)) || !/^\d{1,2}:\d{2}$/.test(String(s.endTime))) {
        throw badRequest('上课时间格式应为 HH:MM');
      }
      // 浏览器端也会拦，但服务端必须自己校验一遍——接口是可以被直接调用的
      if (String(s.startTime) >= String(s.endTime)) {
        throw badRequest(`结束时间（${s.endTime}）必须晚于开始时间（${s.startTime}）`);
      }
      const weeks = String(s.weeks || '').trim();
      if (weeks && !/^[\d,，\-\s单双周第]+$/.test(weeks)) {
        throw badRequest(`周次「${weeks}」格式不对，应该像 1-16、1-16单、1-8,10-16 这样`);
      }
    }

    courses.replaceSessions(id, list);
    sendJson(ctx.res, { ok: true, sessions: courses.listSessions(id) });
  }));

  router.put('/api/courses/:id/grades', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const id = intParam(ctx, 'id');
    if (!courses.getCourseDetail(ctx.user.id, id)) throw notFound('课程不存在');

    const items = Array.isArray(body.items) ? body.items : [];
    const totalWeight = items.reduce((sum, i) => sum + (Number(i.weight) || 0), 0);
    if (totalWeight > 100.5) {
      throw badRequest(`权重合计 ${totalWeight}%，超过了 100%`);
    }

    courses.saveGradeItems(id, items);
    sendJson(ctx.res, { ok: true, gradeItems: courses.listGradeItems(id) });
  }));

  // ==========================================================
  // 作业
  // ==========================================================

  router.post('/api/assignments', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const title = str(body.title, 200).trim();
    if (!title) throw badRequest('作业标题不能为空');

    const result = assignments.createAssignment(ctx.user.id, { ...body, title });
    sendJson(ctx.res, { ok: true, assignment: assignments.getAssignment(ctx.user.id, result) }, 201);
  }));

  router.get('/api/assignments/:id', guard(async (ctx) => {
    const assignment = assignments.getAssignment(ctx.user.id, intParam(ctx, 'id'));
    if (!assignment) throw notFound('作业不存在');
    sendJson(ctx.res, { assignment });
  }));

  router.patch('/api/assignments/:id', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const id = intParam(ctx, 'id');
    const assignment = assignments.updateAssignment(ctx.user.id, id, body);
    sendJson(ctx.res, { ok: true, assignment });
  }));

  router.delete('/api/assignments/:id', guard(async (ctx) => {
    const ok = assignments.deleteAssignment(ctx.user.id, intParam(ctx, 'id'));
    if (!ok) throw notFound('作业不存在');
    sendJson(ctx.res, { ok: true });
  }));

  // ==========================================================
  // 资料
  // ==========================================================

  router.post('/api/materials', guard(async (ctx) => {
    const parsed = await readBodyAuto(ctx.req);
    if (parsed.type !== 'multipart') throw badRequest('上传必须使用 multipart/form-data');

    const file = parsed.data.files.find((f) => f.field === 'file') || parsed.data.files[0];
    if (!file || !file.data?.length) throw badRequest('没有收到文件');

    if (file.data.length > config.maxUploadBytes) {
      throw new HttpError(413, `文件超过大小限制（${Math.round(config.maxUploadBytes / 1024 / 1024)}MB）`);
    }

    const originalName = sanitizeFilename(file.filename);
    if (!originalName || originalName === 'unnamed') throw badRequest('文件名不合法');

    const meta = parsed.data.fields;
    const material = await materials.createMaterialFromUpload(ctx.user.id, file, {
      title: meta.title,
      courseId: meta.courseId,
      category: normalizeCategory(meta.category),
      description: meta.description,
      week: meta.week,
      tags: meta.tags,
      source: meta.source,
    });

    // 预览生成（Office 转 PDF）可能要十几秒，所以不阻塞响应。
    // 前端会看到 preview_status = 'pending'，刷新后变成 ready 或 failed。
    //
    // 用 schedulePreview 而不是直接 buildPreview：它会**排队**，
    // 同时只跑 config.previewConcurrency 个转换。连传几个课件时，
    // 不排队就等于同时起好几个 LibreOffice，小内存服务器会被打爆
    // （详见 materials.js 里那段说明）。它自己也吞掉异常，不会变成未捕获拒绝。
    materials.schedulePreview(material.id);

    sendJson(ctx.res, { ok: true, material }, 201);
  }));

  router.get('/api/materials/:id', guard(async (ctx) => {
    const material = materials.getMaterial(ctx.user.id, intParam(ctx, 'id'));
    if (!material) throw notFound('资料不存在');
    sendJson(ctx.res, { material });
  }));

  router.get('/api/materials/:id/status', guard(async (ctx) => {
    const material = materials.getMaterial(ctx.user.id, intParam(ctx, 'id'));
    if (!material) throw notFound('资料不存在');
    sendJson(ctx.res, {
      status: material.preview_status,
      error: material.preview_error,
      hasPdf: Boolean(material.pdf_name),
      previewMode: material.previewMode,
    });
  }));

  router.patch('/api/materials/:id', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const id = intParam(ctx, 'id');

    // 分类要校验：改资料时下拉框里只可能给出合法值，但直接调接口什么都能传。
    // 放进去一个不认识的分类，那份资料就会从所有筛选标签里消失（只在「全部」里出现），
    // 而且不报错。
    if (body && body.category !== undefined) {
      const category = normalizeCategory(body.category);
      body.category = category === undefined ? DEFAULT_MATERIAL_CATEGORY : category;
    }

    materials.updateMaterial(ctx.user.id, id, body);
    sendJson(ctx.res, { ok: true, material: materials.getMaterial(ctx.user.id, id) });
  }));

  router.delete('/api/materials/:id', guard(async (ctx) => {
    const ok = await materials.deleteMaterial(ctx.user.id, intParam(ctx, 'id'));
    if (!ok) throw notFound('资料不存在');
    sendJson(ctx.res, { ok: true });
  }));

  router.post('/api/materials/:id/rebuild', guard(async (ctx) => {
    const id = intParam(ctx, 'id');
    resetConverterCache();
    const result = await materials.rebuildPreview(ctx.user.id, id);
    sendJson(ctx.res, { ok: true, result });
  }));

  // ==========================================================
  // 通知渠道
  // ==========================================================

  router.get('/api/channels/catalog', guard(async (ctx) => {
    sendJson(ctx.res, { channels: notify.channelCatalog() });
  }));

  router.get('/api/channels', guard(async (ctx) => {
    const list = notify.listChannels(ctx.user.id);
    sendJson(ctx.res, {
      channels: list.map((c) => ({
        ...c,
        config: notify.maskConfig(c.config),
        def: undefined,
      })),
    });
  }));

  router.post('/api/channels', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.type) throw badRequest('缺少渠道类型');

    // 先试发一条，配置错了立刻能发现（但允许用户选择跳过）
    if (body.verify !== false) {
      const test = await notify.testChannelConfig(body.type, body.config || {});
      if (!test.ok) {
        throw badRequest(`配置验证失败：${test.detail}。请检查填写是否正确。`);
      }
    }

    const id = notify.createChannel(ctx.user.id, {
      type: body.type,
      name: body.name,
      config: body.config,
      enabled: body.enabled !== false,
      isDefault: Boolean(body.isDefault),
    });
    sendJson(ctx.res, { ok: true, id }, 201);
  }));

  router.patch('/api/channels/:id', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    notify.updateChannel(ctx.user.id, intParam(ctx, 'id'), {
      type: body.type,
      name: body.name,
      config: body.config,
      enabled: body.enabled,
      isDefault: body.isDefault,
    });
    sendJson(ctx.res, { ok: true });
  }));

  router.delete('/api/channels/:id', guard(async (ctx) => {
    const ok = notify.deleteChannel(ctx.user.id, intParam(ctx, 'id'));
    if (!ok) throw notFound('渠道不存在');
    sendJson(ctx.res, { ok: true });
  }));

  /** 用当前表单里的配置测试（还没保存时也能测） */
  router.post('/api/channels/test', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.type) throw badRequest('缺少渠道类型');
    const result = await notify.testChannelConfig(body.type, body.config || {});
    // 不管成功失败都把规范化之后的配置回给前端。用户可能粘的是整段 Bark
    // 网址，我们把它拆成了「服务器地址 + Key」——如果失败时不回，表单里
    // 还留着那段网址，用户改完 Key 再测一次又会重走一遍同样的困惑。
    if (!result.ok) throw new HttpError(400, result.detail, { config: result.config });
    sendJson(ctx.res, { ok: true, detail: result.detail, config: result.config });
  }));

  /** 测试已保存的某个渠道 */
  router.post('/api/channels/:id/test', guard(async (ctx) => {
    const id = intParam(ctx, 'id');
    const channel = notify.listChannels(ctx.user.id).find((c) => c.id === id);
    if (!channel) throw notFound('渠道不存在');

    const result = await notify.testChannelConfig(channel.type, channel.config);
    notify.logNotify(ctx.user.id, null, channel.type, '测试消息', result.ok, result.detail);

    if (!result.ok) throw new HttpError(400, result.detail);
    sendJson(ctx.res, { ok: true, detail: result.detail, config: result.config });
  }));

  /** 给所有渠道各发一条 */
  router.post('/api/channels/test-all', guard(async (ctx) => {
    const channels = notify.listChannels(ctx.user.id).filter((c) => c.enabled);
    if (!channels.length) throw badRequest('还没有启用任何渠道');

    const results = [];
    for (const channel of channels) {
      const result = await notify.testChannelConfig(channel.type, channel.config);
      notify.logNotify(ctx.user.id, null, channel.type, '测试消息', result.ok, result.detail);
      results.push({
        type: channel.type,
        channelName: channel.name || channel.type,
        ok: result.ok,
        detail: result.detail,
      });
    }
    sendJson(ctx.res, { results });
  }));

  // ==========================================================
  // 学期
  // ==========================================================

  router.get('/api/terms', guard(async (ctx) => {
    sendJson(ctx.res, { terms: courses.listTerms(ctx.user.id) });
  }));

  router.post('/api/terms', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const name = str(body.name, 100).trim();
    if (!name) throw badRequest('学期名称不能为空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate))) {
      throw badRequest('第一周周一必须是 YYYY-MM-DD 格式的日期');
    }
    if (!isMonday(body.startDate)) {
      throw badRequest('「第一周周一」必须是星期一，请检查日期');
    }

    const id = courses.createTerm(ctx.user.id, {
      name,
      startDate: body.startDate,
      weekCount: Number(body.weekCount) || 18,
      isActive: Boolean(body.isActive),
    });
    sendJson(ctx.res, { ok: true, id }, 201);
  }));

  router.patch('/api/terms/:id', guard(async (ctx) => {
    const body = await readJson(ctx.req);

    // 单独校验改动的字段，避免把没传的字段也当非法值拦下来
    if (body.name !== undefined && !String(body.name).trim()) {
      throw badRequest('学期名称不能为空');
    }
    if (body.startDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate))) {
        throw badRequest('第一周周一必须是 YYYY-MM-DD 格式的日期');
      }
      // 起始日不是周一时，整个课表的周次都会偏，这里直接拦住
      if (!isMonday(body.startDate)) {
        throw badRequest('「第一周周一」必须是星期一。填成别的星期会让所有课的周次整体偏移。');
      }
    }
    if (body.weekCount !== undefined) {
      const n = Number(body.weekCount);
      if (!Number.isFinite(n) || n < 1 || n > 30) {
        throw badRequest('总周数应在 1 到 30 之间');
      }
    }

    courses.updateTerm(ctx.user.id, intParam(ctx, 'id'), {
      name: body.name,
      startDate: body.startDate,
      weekCount: body.weekCount,
      isActive: body.isActive,
    });
    sendJson(ctx.res, {
      ok: true,
      terms: courses.listTerms(ctx.user.id),
      // 让前端能立刻提示「改完之后现在是第几周」
      progress: courses.activeTermProgress(ctx.user.id),
    });
  }));

  router.delete('/api/terms/:id', guard(async (ctx) => {
    courses.deleteTerm(ctx.user.id, intParam(ctx, 'id'));
    sendJson(ctx.res, { ok: true });
  }));

  // ==========================================================
  // 设置 / 账号
  // ==========================================================

  router.post('/api/settings', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const allowed = new Set(Object.keys(settingDefaults()));

    const patch = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      // 作息表是结构化数据，有自己的专用接口（/api/periods），这里跳过
      if (key === 'period_schedule') continue;
      patch[key] = str(value, 500);
    }

    // 校验每日简报时间格式
    if (patch.daily_digest_time && !/^\d{2}:\d{2}$/.test(patch.daily_digest_time)) {
      throw badRequest('简报时间格式应为 HH:MM');
    }
    // 校验默认提醒提前量
    if (patch.default_remind_offsets) {
      const parts = patch.default_remind_offsets.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!/^\d+$/.test(p) || Number(p) <= 0) {
          throw badRequest('提醒提前量必须是正整数分钟数，用英文逗号分隔，例如 1440,120');
        }
      }
    }

    setSettings(ctx.user.id, patch);
    sendJson(ctx.res, { ok: true, settings: getSettings(ctx.user.id, settingDefaults()) });
  }));

  // ==========================================================
  // 作息时间表
  //
  // 「第 3-4 节」是几点到几点，每个学校都不一样，
  // 所以这份映射由用户自己维护，导入和课表渲染都用它。
  // ==========================================================

  router.get('/api/periods', guard(async (ctx) => {
    sendJson(ctx.res, {
      periods: getPeriodSchedule(ctx.user.id),
      defaults: DEFAULT_PERIOD_SCHEDULE,
      isCustom: hasCustomPeriodSchedule(ctx.user.id),
    });
  }));

  router.post('/api/periods', guard(async (ctx) => {
    const body = await readJson(ctx.req);

    // 传 null 或空数组 = 恢复默认
    if (body.periods === null || (Array.isArray(body.periods) && body.periods.length === 0)) {
      clearPeriodSchedule(ctx.user.id);
      sendJson(ctx.res, { ok: true, periods: DEFAULT_PERIOD_SCHEDULE, isCustom: false });
      return;
    }

    try {
      const saved = savePeriodSchedule(ctx.user.id, body.periods);
      // savePeriodSchedule 在「内容其实等于默认值」时也会清空设置，这里如实回报
      sendJson(ctx.res, {
        ok: true,
        periods: saved,
        isCustom: hasCustomPeriodSchedule(ctx.user.id),
      });
    } catch (err) {
      throw badRequest(err.message);
    }
  }));

  router.post('/api/password', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!verifyPassword(body.currentPassword || '', user.password_hash)) {
      throw badRequest('当前密码不正确');
    }
    if (String(body.newPassword || '').length < 6) {
      throw badRequest('新密码至少 6 位');
    }
    changePassword(ctx.user.id, body.newPassword);
    sendJson(ctx.res, { ok: true });
  }));

  /**
   * 注销账号。
   *
   * 要两道确认，缺一不可：
   *   1. 密码 —— 证明是本人（比如手机被同学拿去玩的时候挡住他）
   *   2. 把用户名原样敲一遍 —— 证明不是手滑。这个操作**没有回收站**，
   *      课表、作业、课件、发送历史会一起没掉，所以不能让一次误点就生效。
   *
   * 用 POST 而不是 DELETE：删除是要立刻生效、不可重复的操作，
   * 而 DELETE 在浏览器/代理这条链路上被重试、被预取的坑更多，
   * 而且本项目整体就是表单 + fetch 的风格，不为一处破例。
   */
  router.post('/api/account/delete', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    const user = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!user) throw unauthorized('登录状态已失效，请重新登录');

    if (!verifyPassword(body.password || '', user.password_hash)) {
      throw badRequest('密码不正确');
    }

    const typed = String(body.confirmUsername ?? '').trim();
    if (typed !== user.username) {
      // 把期望的用户名回显出来：这里的目的不是考验记忆，
      // 而是逼人确认「我要删的就是这个账号」，所以不该让人靠猜。
      throw badRequest(`请原样输入你的用户名「${user.username}」以确认`);
    }

    const result = await deleteAccount(ctx.user.id);

    // 账号都没了，会话必须立刻失效，否则浏览器还揣着一条指向已删用户的 Cookie，
    // 下一次请求会走进「有令牌但查不到用户」的半登录状态。
    clearSessionCookie(ctx.res);

    sendJson(ctx.res, {
      ok: true,
      username: result.username,
      removedFiles: result.removedFiles,
      counts: result.counts,
    });
  }));

  // ==========================================================
  // 导入
  // ==========================================================

  /** ICS 导入（返回解析结果供确认，不直接写库） */
  router.post('/api/import/ics', guard(async (ctx) => {
    const parsed = await readBodyAuto(ctx.req);
    let text = '';

    if (parsed.type === 'multipart') {
      const file = parsed.data.files[0];
      if (!file) throw badRequest('没有收到文件');
      text = file.data.toString('utf8');
    } else if (parsed.type === 'json') {
      text = str(parsed.data.text, 5_000_000);
    } else if (parsed.type === 'raw') {
      text = parsed.data.toString('utf8');
    }

    if (!text.includes('BEGIN:VCALENDAR')) {
      throw badRequest('这不是一个合法的 .ics 日历文件（缺少 BEGIN:VCALENDAR）');
    }

    const result = parseIcsTimetable(text);
    sendJson(ctx.res, { ok: true, parsed: result, source: 'ics' });
  }));

  /** CSV/粘贴文本导入 */
  router.post('/api/import/csv', guard(async (ctx) => {
    const parsed = await readBodyAuto(ctx.req);
    let text = '';

    if (parsed.type === 'multipart') {
      const file = parsed.data.files[0];
      if (file) text = decodeAny(file.data);
      if (!text && parsed.data.fields.text) text = parsed.data.fields.text;
    } else if (parsed.type === 'json') {
      text = str(parsed.data.text, 5_000_000);
    } else {
      text = parsed.data.toString('utf8');
    }

    if (!text.trim()) throw badRequest('没有收到任何表格内容');

    const result = parseCourseCsv(text, { periods: getPeriodSchedule(ctx.user.id) });
    sendJson(ctx.res, { ok: true, parsed: result, source: 'csv' });
  }));

  /** 确认导入（把预览过的数据真正写库） */
  router.post('/api/import/confirm', guard(async (ctx) => {
    const body = await readJson(ctx.req, 5 * 1024 * 1024);
    const payload = body.payload;
    if (!payload?.courses?.length) throw badRequest('没有要导入的课程');

    let termId = null;
    if (body.termId === 'new' || !body.termId) {
      const name = str(body.termName, 100).trim()
        || courses.guessTermName(body.termStart || new Date().toISOString().slice(0, 10));
      const start = /^\d{4}-\d{2}-\d{2}$/.test(body.termStart || '')
        ? body.termStart
        : new Date().toISOString().slice(0, 10);
      termId = courses.createTerm(ctx.user.id, {
        name,
        startDate: start,
        weekCount: 18,
        isActive: true,
      });
    } else {
      termId = Number(body.termId);
    }

    const result = importCourses(ctx.user.id, payload, termId, {
      onConflict: body.onConflict || 'skip',
    });

    sendJson(ctx.res, { ok: true, result, termId });
  }));

  // ==========================================================
  // 调度器 / 日历 / 杂项
  // ==========================================================

  router.post('/api/scheduler/run', guard(async (ctx) => {
    const result = await runOnce();
    sendJson(ctx.res, { ok: true, result, status: schedulerStatus() });
  }));

  router.get('/api/scheduler/status', guard(async (ctx) => {
    sendJson(ctx.res, { status: schedulerStatus() });
  }));

  router.get('/api/calendar/stats', guard(async (ctx) => {
    sendJson(ctx.res, { stats: exportStats(ctx.user.id) });
  }));

  /** 预览日历内容（前 50 行），方便用户确认导出正确 */
  router.get('/api/calendar/preview', guard(async (ctx) => {
    const { ics, eventCount, calendarName } = buildCalendar(ctx.user.id, {});
    sendJson(ctx.res, {
      calendarName,
      eventCount,
      preview: ics.split('\r\n').slice(0, 50).join('\n'),
    });
  }));

  /** 在文件管理器里打开数据目录 */
  router.post('/api/open-path', guard(async (ctx) => {
    const body = await readJson(ctx.req);
    // 只允许打开数据目录，防止被当成任意命令执行器
    const target = path.resolve(String(body.path || config.dataDir));
    if (target !== path.resolve(config.dataDir)) {
      throw badRequest('只允许打开数据目录');
    }

    const command = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';

    try {
      spawn(command, [target], { detached: true, stdio: 'ignore' }).unref();
      sendJson(ctx.res, { ok: true });
    } catch (err) {
      throw new HttpError(500, `无法打开目录：${err.message}`);
    }
  }));

  return router;
}

/**
 * 文本文件解码：UTF-8 优先，失败退回 GB18030。
 * 教务系统导出的 CSV 经常是 GBK。
 */
function decodeAny(buffer) {
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
