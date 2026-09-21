/**
 * 课件资料：入库、预览流水线、检索。
 *
 * 「点进去能直接看 PPT」是这个平台最核心的体验，
 * 所以这里有一整条预览流水线：
 *
 *   PDF / 图片 / 音视频 / 文本  → 浏览器原生就能渲染，直接内嵌
 *   PPT / Word / Excel          → 先用 LibreOffice/Office 转成 PDF，内嵌 PDF
 *                                 PDF 转不出来时，PPT 再试「每页导出成图片」
 *                                 都不行才抽文本，渲染成网页版预览
 *   其它                        → 只能下载
 *
 * 为什么要留「导出图片」这一条：Office 导 PDF 依赖打印管线，
 * 没有可用打印机的会话里 PowerPoint 会直接崩，而导出图片是正常的。
 * 两条路的成败并不一致，多一条就多一分「能看见课件」的机会。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { all, get, run } from '../db/index.js';
import { notFound } from './http.js';
import config from '../config.js';
import {
  KIND,
  KIND_ICONS,
  KIND_LABELS,
  derivedPath,
  detectKind,
  extractOfficeText,
  flattenOfficeText,
  humanSize,
  inferSlideCount,
  isConvertible,
  normalizeExt,
  readTextFile,
  removeUpload,
  sanitizeFilename,
  saveUpload,
  uploadPath,
} from './files.js';
import { convertToPdf, discardConvertedPdf, exportSlidesToImages } from './convert.js';

// ============================================================
// 查询
// ============================================================

/**
 * 资料分类。**这是全项目唯一的一份清单** —— 标签页、上传表单的下拉框、
 * 编辑表单的下拉框、统计、显示时的中文名，全部从这里生成。
 *
 * 为什么要强调「唯一」：这份清单以前在三个地方各写了一遍
 * （这里、资料库页顶部的筛选标签、两个表单的下拉框），然后慢慢走散了 ——
 * 「教材」这一项在标签页和下拉框里都没有，于是就出现
 * 「能显示成教材（老数据里有），但选不了也筛不出来」这种半截状态。
 * 而且谁也不会发现，因为不报任何错。
 *
 * 顺序就是界面上显示的顺序，别随手排序。
 */
export const MATERIAL_CATEGORIES = [
  { key: 'courseware', label: '课件' },
  { key: 'handout', label: '讲义' },
  { key: 'assignment', label: '作业' },
  { key: 'exam', label: '试卷' },
  { key: 'reference', label: '资料' },
  { key: 'book', label: '教材' },
  { key: 'other', label: '其他' },
];

/** 表单里默认选中的分类 */
export const DEFAULT_MATERIAL_CATEGORY = 'courseware';

const CATEGORY_LABELS = Object.fromEntries(MATERIAL_CATEGORIES.map((c) => [c.key, c.label]));

export { CATEGORY_LABELS };

/**
 * 分类的中文名。
 *
 * 空值单独说成「未分类」，而不是混进「其他」—— 「其他」是用户主动选的，
 * 「未分类」是没选，两者混在一起会让用户以为是自己选错了。
 * 认不出的值原样显示：宁可露出一个奇怪的名字，也不要谎称它属于某一类。
 */
export function categoryLabel(value) {
  const key = String(value ?? '').trim();
  if (!key) return '未分类';
  return CATEGORY_LABELS[key] || key;
}

/** 这个分类是不是我们认识的（写入前校验用，避免库里混进乱七八糟的值） */
export function isKnownCategory(value) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, String(value ?? '').trim());
}

/**
 * 资料列表。
 * @param {object} opts { courseId, category, keyword, kind, limit, offset }
 */
export function listMaterials(userId, opts = {}) {
  const where = ['m.user_id = ?'];
  const params = [userId];

  if (opts.courseId) {
    where.push('m.course_id = ?');
    params.push(Number(opts.courseId));
  }
  if (opts.category) {
    where.push('m.category = ?');
    params.push(opts.category);
  }
  if (opts.kind) {
    where.push('m.kind = ?');
    params.push(opts.kind);
  }
  if (opts.keyword) {
    // 标题、描述、标签、以及抽取出来的正文一起搜
    where.push('(m.title LIKE ? OR m.description LIKE ? OR m.tags LIKE ? OR m.text_cache LIKE ?)');
    const like = `%${opts.keyword}%`;
    params.push(like, like, like, like);
  }
  if (opts.since) {
    where.push('m.created_at >= ?');
    params.push(opts.since);
  }

  const limit = Math.min(Number(opts.limit) || 100, 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const rows = all(
    `SELECT m.*, c.name AS course_name, c.color AS course_color
       FROM materials m
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );

  return rows.map(decorateMaterial);
}

/** 给资料行补上展示用的派生字段 */
export function decorateMaterial(row) {
  if (!row) return row;
  return {
    ...row,
    kindLabel: KIND_LABELS[row.kind] || '文件',
    kindIcon: KIND_ICONS[row.kind] || '📎',
    // 用 categoryLabel() 而不是直接查表：空值要说「未分类」，
    // 而不是被兜底成「其他」—— 那是用户主动选的另一个意思
    categoryLabel: categoryLabel(row.category),
    sizeLabel: humanSize(row.size),
    hasPdf: Boolean(row.pdf_name),
    // 能否在站内直接看
    canPreview: canPreview(row),
    previewMode: previewMode(row),
  };
}

/**
 * 按 id 取一份资料，**不带任何归属校验**。
 *
 * ⚠️ 这个函数自己**不判断**"这个人能不能看"。调用方必须先过一道
 *    `community.canViewMaterial(viewerId, row.user_id, row)`，
 *    否则就是把别人的资料（包括没公开的）直接端出去。
 *
 * 为什么需要它：校友社区里同校同学要能**打开**别人公开的资料，
 * 所以「按 id 取」和「按 id + user_id 取」是两件事，不能混成一个函数。
 * 自己的入口（列表、编辑、删除）一律用下面那个 getMaterial ——
 * 它的 WHERE 里带着 user_id，是硬约束。
 */
export function getMaterialById(id) {
  const row = get(
    `SELECT m.*, c.name AS course_name, c.color AS course_color
       FROM materials m
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE m.id = ?`,
    Number(id),
  );
  return decorateMaterial(row);
}

/**
 * 取**自己的**一份资料。
 *
 * WHERE 里的 `m.user_id = ?` 是硬约束：所以「读别人的东西」在数据层就
 * 命中不到，不用指望上层记得判断 —— 这也是它能安全地给编辑/删除用的原因。
 * 要读别人公开的资料，用上面的 getMaterialById + canViewMaterial。
 */
export function getMaterial(userId, id) {
  const row = get(
    `SELECT m.*, c.name AS course_name, c.color AS course_color
       FROM materials m
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE m.id = ? AND m.user_id = ?`,
    id,
    userId,
  );
  return decorateMaterial(row);
}

/** 资料所属课程里的其它资料，用于预览页的「同课程资料」侧栏 */
export function siblingMaterials(userId, materialId, courseId, limit = 30) {
  if (!courseId) return [];
  return all(
    `SELECT id, title, kind, created_at FROM materials
      WHERE user_id = ? AND course_id = ? AND id != ?
      ORDER BY created_at DESC LIMIT ?`,
    userId,
    courseId,
    materialId,
    limit,
  ).map((r) => ({ ...r, kindIcon: KIND_ICONS[r.kind] || '📎', kindLabel: KIND_LABELS[r.kind] || '文件' }));
}

/** 能直接在浏览器里渲染的类型 */
export function canPreview(row) {
  if (row.pdf_name) return true;
  return [KIND.PDF, KIND.IMAGE, KIND.VIDEO, KIND.AUDIO, KIND.TEXT].includes(row.kind)
    || row.kind === KIND.PPT
    || row.kind === KIND.WORD
    || row.kind === KIND.EXCEL;
}

/**
 * 预览方式，前端据此选渲染组件：
 *   pdf      内嵌 PDF（浏览器自带阅读器）
 *   slides   一页一张图片，拼成幻灯片列表
 *   image    图片
 *   video    视频
 *   audio    音频
 *   text     纯文本
 *   office   网页版 Office 预览（文本抽取结果）
 *   none     无法预览
 */
export function previewMode(row) {
  if (row.pdf_name) return 'pdf';
  if (row.kind === KIND.PDF) return 'pdf';
  // 导出了幻灯片图片就走图片模式。
  // 用 slides_dir 这个字段判断，而不是去查文件系统 ——
  // 列表页会对每一行都调用一次，不该每次都碰磁盘。
  if (row.slides_dir) return 'slides';
  if (row.kind === KIND.IMAGE) return 'image';
  if (row.kind === KIND.VIDEO) return 'video';
  if (row.kind === KIND.AUDIO) return 'audio';
  if (row.kind === KIND.TEXT) return 'text';
  if ([KIND.PPT, KIND.WORD, KIND.EXCEL].includes(row.kind)) return 'office';
  return 'none';
}

// ============================================================
// 入库
// ============================================================

/**
 * 保存一个上传的文件并建立资料记录。
 *
 * @param {number} userId
 * @param {{filename:string, mime:string, data:Buffer}} file
 * @param {object} meta { title, courseId, category, description, week, tags, source }
 */
export async function createMaterialFromUpload(userId, file, meta = {}) {
  const originalName = sanitizeFilename(file.filename);
  const ext = normalizeExt(originalName);
  const kind = detectKind(originalName);

  const saved = await saveUpload(file.data, ext);

  const { lastInsertRowid } = run(
    `INSERT INTO materials
       (user_id, course_id, title, description, category, source, week, tags,
        original_name, stored_name, ext, mime, size, kind, preview_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    userId,
    meta.courseId ? Number(meta.courseId) : null,
    String(meta.title || '').trim() || originalName.replace(/\.[^.]+$/, ''),
    meta.description || '',
    meta.category || 'courseware',
    meta.source || '',
    meta.week ? Number(meta.week) : null,
    meta.tags || '',
    originalName,
    saved.relPath,
    ext,
    file.mime || '',
    saved.size,
    kind,
  );

  return getMaterial(userId, lastInsertRowid);
}

// ============================================================
// 预览生成的并发闸门
//
// 上传接口把转换丢到后台就立刻返回给浏览器，而浏览器传下一个文件时
// 上一个转换还在跑 —— 于是「一次选 5 个课件」就等于让 5 个 LibreOffice
// 同时起来。它每个实例要几百 MB 内存，2 核 2G 的服务器上 3 个就打满，
// 然后被 OOM 杀掉：转换失败、预览退化成纯文字。
//
// 给人的感觉非常有迷惑性 ——「以前传的课件都能正常看，今天新传的
// 全都没排版了」，因为老课件的 PDF 早就躺在缓存里，根本不用重转。
// ============================================================

/** 正在跑的转换数量 */
let previewRunning = 0;
/** 排队等着开始的转换（存的是「启动」函数） */
const previewWaiting = [];

/** 现在的排队情况，诊断和测试用 */
export function previewQueueState() {
  return { running: previewRunning, waiting: previewWaiting.length };
}

/**
 * 让 fn 排队执行，保证同时在跑的转换不超过 config.previewConcurrency 个。
 *
 * 用 FIFO：先进先出最好解释，也不会让某一份课件永远排在后面。
 */
function withPreviewSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      previewRunning += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          previewRunning -= 1;
          const next = previewWaiting.shift();
          if (next) next();
        });
    };

    if (previewRunning < config.previewConcurrency) start();
    else previewWaiting.push(start);
  });
}

/**
 * 跑预览流水线。上传后异步调用（不阻塞响应），
 * 所以资料刚上传时 preview_status 是 pending，前端会轮询或下次刷新看到结果。
 *
 * 注意：它会**排队**。并发上限见 config.previewConcurrency。
 */
export async function buildPreview(materialId) {
  return withPreviewSlot(() => buildPreviewNow(materialId));
}

/**
 * 排队生成预览，但不等结果、也不抛错 —— 给上传接口用。
 *
 * 上传接口关心的是「尽快把 201 还回去」，转换排多久都不该影响它。
 */
export function schedulePreview(materialId) {
  return withPreviewSlot(() => buildPreviewNow(materialId))
    .then(() => undefined)
    .catch((err) => {
      console.error(`[预览] 资料 ${materialId} 生成失败：`, err.message);
    });
}

/**
 * 找出卡在 pending 的课件。
 *
 * 为什么需要：进程在转换途中被重启（pm2 restart、断电、OOM），
 * 那份课件就永远停在 pending，界面上一直转圈，谁也不会再去动它。
 * 启动时把它们重新排进队列，就自愈了。
 */
export function pendingPreviewMaterials(limit = 50) {
  return all(
    `SELECT id FROM materials
      WHERE preview_status = 'pending'
      ORDER BY id ASC LIMIT ?`,
    limit,
  ).map((r) => r.id);
}

async function buildPreviewNow(materialId) {
  const row = get('SELECT * FROM materials WHERE id = ?', materialId);
  if (!row) return { ok: false, error: '资料不存在' };

  const absPath = uploadPath(row.stored_name);

  try {
    // 1. 需要转换的 Office 文档
    if (isConvertible(row.ext)) {
      const converted = await convertToPdf(absPath, row.ext);
      if (converted.ok) {
        const pdfName = path.relative(config.uploadDir, converted.pdfPath).replace(/\\/g, '/');
        run(
          `UPDATE materials SET pdf_name = ?, slides_dir = '', preview_status = 'ready', preview_error = '',
                  updated_at = datetime('now','localtime')
            WHERE id = ?`,
          pdfName,
          materialId,
        );
        return { ok: true };
      }

      // PDF 转不出来时，先试「把每页导出成图片」。
      // 这两条路的成败并不一致：Office 导 PDF 依赖打印管线，
      // 没有打印机的会话里 PowerPoint 会直接崩，但导出图片完全正常。
      // 实测过一份 71 页的课件就是这种情况。
      const slides = await tryBuildSlidesPreview(materialId, row, absPath, converted.error);
      if (slides.ok) return { ok: true };

      // 图片也不行，才退到「抽文本 + 网页版预览」
      await buildOfficeTextPreview(materialId, absPath, row.ext, slides.error);
      return { ok: true };
    }

    // 2. 纯文本：读出来存进 text_cache，方便全文检索
    if (row.kind === KIND.TEXT) {
      const text = await readTextFile(absPath, 500_000);
      run(
        `UPDATE materials SET text_cache = ?, preview_status = 'ready', preview_error = '',
                updated_at = datetime('now','localtime')
          WHERE id = ?`,
        text.slice(0, 200_000),
        materialId,
      );
      return { ok: true };
    }

    // 3. 其它类型浏览器本来就能渲染，无需处理
    run(
      `UPDATE materials SET preview_status = 'ready', preview_error = ''
        WHERE id = ?`,
      materialId,
    );
    return { ok: true };
  } catch (err) {
    run(
      `UPDATE materials SET preview_status = 'failed', preview_error = ?
        WHERE id = ?`,
      String(err.message || err).slice(0, 500),
      materialId,
    );
    return { ok: false, error: err.message };
  }
}

/**
 * 试着把 PPT 每一页导出成图片。
 *
 * 存在的理由：Office 导 PDF 走打印管线，需要可用打印机；
 * 没有打印机的会话里 PowerPoint 会直接崩（RPC 失败），
 * 但同一份文件导出图片完全正常。用户要的是「能看见课件长什么样」，
 * 图片和 PDF 都能满足，那就别在 PDF 这一棵树上吊死。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function tryBuildSlidesPreview(materialId, row, absPath, pdfError) {
  // 只有幻灯片有「一页一图」的概念
  if (row.kind !== KIND.PPT) {
    return { ok: false, error: pdfError };
  }

  // 产物按 stored_name 派生，重跑时直接覆盖，不需要额外记录
  const outDir = slidesDirFor(row.stored_name);
  await fsp.rm(outDir, { recursive: true, force: true });

  const result = await exportSlidesToImages(absPath, row.ext, outDir);

  if (!result.ok) {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      error: `${pdfError || 'PDF 转换失败'}；改用图片渲染也没成功：${result.error}`,
    };
  }

  const rel = path.relative(config.uploadDir, outDir).replace(/\\/g, '/');

  // 导出中途 PowerPoint 崩掉时，产物是残缺的。这时候照样让用户看，
  // 但必须说清楚少了几页 —— 否则用户会以为后面几页本来就空。
  const note = result.partial
    ? `只导出了 ${result.count} / ${result.total} 页（导出过程中 PowerPoint 中断了）。`
      + '点「重新转换」可以再试一次，也可以直接下载原件。'
    : '';

  run(
    `UPDATE materials
        SET slides_dir = ?, slide_count = ?, text_cache = '',
            preview_status = 'ready', preview_error = ?,
            updated_at = datetime('now','localtime')
      WHERE id = ?`,
    rel,
    result.count,
    note,
    materialId,
  );

  return { ok: true };
}

/** 某份资料的幻灯片图片目录（绝对路径，在缓存目录下） */
export function slidesDirFor(storedName) {
  // 用 stored_name 去掉扩展名当目录名：它本身就是随机 ID，不会撞车
  const base = path.basename(storedName, path.extname(storedName));
  return path.join(config.cacheDir, 'slides', base);
}

/** 列出某份资料已经导出的幻灯片图片（绝对路径，按页码排序） */
export function listSlideImages(row) {
  if (!row.slides_dir) return [];

  let dir;
  try {
    // 和 PDF 走同一套解析：派生文件在 cache 目录，
    // 用 uploadPath() 会因为「跑出 uploads」直接抛异常
    dir = derivedPath(row.slides_dir);
  } catch {
    return [];
  }

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => path.join(dir, f));
}

/**
 * Office 转 PDF 失败时的兜底：抽取文本，存成 JSON 供网页版预览渲染。
 * 存进 text_cache 时用一个特殊前缀标记，便于区分。
 */
async function buildOfficeTextPreview(materialId, absPath, ext, convertError) {
  const result = await extractOfficeText(absPath, ext);

  if (!result.ok) {
    run(
      `UPDATE materials SET preview_status = 'failed', preview_error = ?
        WHERE id = ?`,
      `${convertError || ''}；${result.error || '文本抽取失败'}`.slice(0, 500),
      materialId,
    );
    return;
  }

  const plain = flattenOfficeText(ext, result.data);
  const slideCount = inferSlideCount(result.data);

  run(
    `UPDATE materials
        SET text_cache = ?, preview_status = 'ready', preview_error = ?,
            slide_count = COALESCE(?, slide_count)
      WHERE id = ?`,
    plain.slice(0, 200_000),
    convertError ? `已降级为网页版预览：${convertError}`.slice(0, 500) : '',
    slideCount,
    materialId,
  );
}

/** 重新生成预览（课件页的「重新转换」按钮） */
export async function rebuildPreview(userId, materialId) {
  const row = get('SELECT * FROM materials WHERE id = ? AND user_id = ?', materialId, userId);
  if (!row) throw notFound('资料不存在');

  // 把上一次的产物一并清掉。
  //
  // 两样都要删，缺一不可：
  //   幻灯片目录 —— 否则旧的图片会和新生成的混在一起；
  //   **PDF** —— convertToPdf 看到同名 PDF 存在就直接复用，不删的话
  //   「重新转换」会原样返回上一次的文件：界面报成功、内容一个字没变。
  //   用户为修「中文字体缺失」装了字体再点这个按钮，看到的还是乱码，
  //   只会得出「装字体没用」的结论，根本想不到是没重转。
  if (row.slides_dir) {
    await fsp.rm(slidesDirFor(row.stored_name), { recursive: true, force: true }).catch(() => {});
  }
  await discardConvertedPdf(uploadPath(row.stored_name));

  run(
    `UPDATE materials SET pdf_name = '', slides_dir = '', preview_status = 'pending', preview_error = ''
      WHERE id = ?`,
    materialId,
  );
  return buildPreview(materialId);
}

/**
 * 批量设置「公开给同校」。按**当前的筛选条件**作用，不是无脑全库。
 *
 * 为什么按筛选而不是"全部公开"：资料库里往往混着老师发的东西、带答案的、
 * 自己整理的笔记。一刀切全公开是这一批里最容易出事的一个按钮 ——
 * 所以设计成「公开我正在看的这一类」：先筛到某个课程或某个分类，再批量。
 * 想全公开也行，但那时用户至少是在「全部」这一屏上按的。
 *
 * ⚠️ `WHERE user_id = ?` 是第一条件，不是可选项。
 *    漏了它就是**任何登录用户都能公开/取消公开别人的资料** ——
 *    这个接口比单份的 PATCH 危险得多，因为它一次影响一片。
 *
 * @param {number} userId
 * @param {{published: boolean|number|string, category?: string, courseId?: number, kind?: string}} opts
 * @returns {number} 实际改动的行数
 */
export function setPublishedBulk(userId, opts = {}) {
  const where = ['user_id = ?'];
  const params = [Number(userId)];
  if (opts.courseId) {
    where.push('course_id = ?');
    params.push(Number(opts.courseId));
  }
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }

  const value = toBool01(opts.published, 0);
  const result = run(
    `UPDATE materials SET published = ?, updated_at = datetime('now','localtime')
      WHERE ${where.join(' AND ')}`,
    value, ...params,
  );
  return Number(result?.changes) || 0;
}

/** 按同样的筛选条件数一下有多少份（给界面显示"这一类共 N 份"） */
export function countMaterials(userId, opts = {}) {
  const where = ['user_id = ?'];
  const params = [Number(userId)];
  if (opts.courseId) { where.push('course_id = ?'); params.push(Number(opts.courseId)); }
  if (opts.category) { where.push('category = ?'); params.push(opts.category); }
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }
  const row = get(
    `SELECT COUNT(*) AS c FROM materials WHERE ${where.join(' AND ')}`,
    ...params,
  );
  return Number(row?.c) || 0;
}

// ============================================================
// 管理员用途（只有命令行脚本调，网页那边一律走上面那些带 userId 的）
// ============================================================

/**
 * 【管理用途】列出**所有人**公开出来的资料（含用户名）。
 *
 * ⚠️ 这个函数故意**不带 userId**，也故意把 username 带出来 ——
 *    它是给站点管理员在自己终端上看的（`node scripts/unpublish.mjs`），
 *    用来回答"现在社区里到底有什么、是谁放的"。
 *    任何**网页**入口都不许调用它：网页那边看到别人数据的地方只有社区，
 *    而社区永远不显示用户名（有一条自测专门钉这一点）。
 *
 * 名字里的 admin 前缀不是装饰：以后如果有人想"顺手"在页面上加一个
 * 「管理」视图，grep 一下 admin 就能看到这段注释和这条界线。
 */
export function adminListPublished({ limit = 500 } = {}) {
  return all(
    `SELECT m.id, m.title, m.category, m.kind, m.size, m.published,
            m.updated_at, m.created_at,
            u.id AS owner_id, u.username, u.display_name,
            c.name AS course_name
       FROM materials m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN courses c ON c.id = m.course_id
      WHERE m.published = 1
      ORDER BY m.updated_at DESC
      LIMIT ?`,
    Math.min(Math.max(Number(limit) || 500, 1), 5000),
  ).map((r) => ({
    id: r.id,
    title: r.title || '',
    category: r.category || '',
    size: r.size,
    updatedAt: r.updated_at || r.created_at || '',
    ownerId: r.owner_id,
    username: r.username || '',
    displayName: r.display_name || '',
    courseName: r.course_name || '',
  }));
}

/**
 * 【管理用途】收回公开 —— 按**资料 id**（单份）或按**用户 id**（某人全部）。
 *
 * ⚠️ 这里**没有 user_id 归属校验**，这是这个函数存在的唯一理由：
 *    网页那边的公开/收回必须是"只能动自己的"（setPublishedBulk 的第一条
 *    WHERE 就是 user_id），而管理员要能下架**别人**的东西 ——
 *    否则遇到"有人公开了不该公开的"就只能删掉整个账号。
 *    所以：**只有命令行脚本调它**，永远不要从路由里调。
 *
 * @param {{id?: number, userId?: number, published?: boolean|number}} opts
 * @returns {number} 实际**改变**的行数
 */
export function adminSetPublished(opts = {}) {
  const value = toBool01(opts.published, 0);
  const sql = `UPDATE materials SET published = ?, updated_at = datetime('now','localtime')
                WHERE `;
  // ⚠️ 末尾的 `AND published <> ?` 不是多余的：不加的话，`changes` 会把
  //    **本来就是这个状态**的行也算进去。按 userId 下架时，那个人可能只有
  //    1 份是公开的、另外 20 份早就没公开，脚本就会打印「已下架 21 份」——
  //    管理员据此以为下掉了 21 份东西，实际上只动了 1 份。
  //    顺带也避免了给没变化的行白写一次 updated_at。
  if (opts.id) {
    const result = run(`${sql}id = ? AND published <> ?`, value, Number(opts.id), value);
    return Number(result?.changes) || 0;
  }
  if (opts.userId) {
    const result = run(`${sql}user_id = ? AND published <> ?`, value, Number(opts.userId), value);
    return Number(result?.changes) || 0;
  }
  // 两个都没给：什么都不做，而不是"匹配全部行"。
  // （没有 WHERE 的 UPDATE 会把整站资料一次改掉，这种默认值不能有。）
  return 0;
}

/** 更新资料元信息（不改文件） */
export function updateMaterial(userId, id, patch) {
  const row = get('SELECT * FROM materials WHERE id = ? AND user_id = ?', id, userId);
  // 404 而不是 500：这一行不是你的 / 不存在，都该如实回「找不到」。
  // 抛普通 Error 会被接口层当成服务器故障，日志里还会留一堆假错误。
  if (!row) throw notFound('资料不存在');

  run(
    `UPDATE materials SET
       title = ?, description = ?, category = ?, course_id = ?, week = ?, tags = ?, source = ?,
       published = ?,
       updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ?`,
    patch.title ?? row.title,
    patch.description ?? row.description,
    patch.category ?? row.category,
    patch.courseId === undefined ? row.course_id : (patch.courseId ? Number(patch.courseId) : null),
    patch.week === undefined ? row.week : (patch.week === '' || patch.week === null ? null : Number(patch.week)),
    patch.tags ?? row.tags,
    patch.source ?? row.source,
    // 公开开关：只认真正的布尔输入，**不要**写成 `patch.published ?? row.published` ——
    // 那样传字符串 '0' 会被当成真值（非空字符串在 JS 里是真的），
    // 于是「取消公开」这个动作会静默失败，而用户以为已经收回了。
    toBool01(patch.published, row.published),
    id,
    userId,
  );
}

/** 把各种写法（true / '1' / 'on' / 1 / 0 / '0' / ''）统一成 1 或 0 */
function toBool01(value, fallback) {
  if (value === undefined || value === null) return Number(fallback) ? 1 : 0;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value === '') return 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return 1;
  if (['0', 'false', 'off', 'no'].includes(s)) return 0;
  // 认不出来就沿用原值，别猜 —— 猜错的方向可能是"本该收回却公开了"
  return Number(fallback) ? 1 : 0;
}

export async function deleteMaterial(userId, id) {
  const row = get('SELECT * FROM materials WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return false;
  // 幻灯片图片是按 stored_name 派生出来的目录，得单独删，
  // 否则删掉课件后缓存目录里会一直留着这一堆图片
  await fsp.rm(slidesDirFor(row.stored_name), { recursive: true, force: true }).catch(() => {});
  await removeUpload(row.stored_name, row.pdf_name);
  run('DELETE FROM materials WHERE id = ? AND user_id = ?', id, userId);
  return true;
}

// ============================================================
// 统计
// ============================================================

/** 按类型、按分类统计，资料页顶部的筛选标签用 */
export function materialStats(userId, courseId) {
  const params = [userId];
  let extra = '';
  if (courseId) {
    extra = ' AND course_id = ?';
    params.push(Number(courseId));
  }

  const byKind = all(
    `SELECT kind, COUNT(*) AS count, SUM(size) AS bytes
       FROM materials WHERE user_id = ?${extra}
      GROUP BY kind ORDER BY count DESC`,
    ...params,
  );

  // 顶部那排筛选标签按**分类**筛选，所以数字也必须按分类统计。
  // 以前这里只有 byKind，标签却拿它去比对分类键 —— 两边根本不是一个东西，
  // 永远匹配不上，于是标签上的数字一次都没显示出来（而且是静默的）。
  const byCategory = all(
    `SELECT category, COUNT(*) AS count
       FROM materials WHERE user_id = ?${extra}
      GROUP BY category`,
    ...params,
  );

  const total = get(
    `SELECT COUNT(*) AS count, SUM(size) AS bytes FROM materials WHERE user_id = ?${extra}`,
    ...params,
  );

  return {
    total: Number(total?.count || 0),
    totalBytes: Number(total?.bytes || 0),
    totalLabel: humanSize(Number(total?.bytes || 0)),
    byKind: byKind.map((r) => ({
      ...r,
      count: Number(r.count),
      bytes: Number(r.bytes || 0),
      label: KIND_LABELS[r.kind] || r.kind,
      icon: KIND_ICONS[r.kind] || '📎',
    })),
    byCategory: byCategory.map((r) => ({
      category: r.category || '',
      count: Number(r.count),
    })),
  };
}

/** 检查资料文件是否还在磁盘上（文件可能被手动删了） */
export async function materialFileExists(row) {
  try {
    await fsp.access(uploadPath(row.stored_name));
    return true;
  } catch {
    return false;
  }
}

/** 抽取出的纯文本（网页版预览用） */
export function materialText(row) {
  return row?.text_cache || '';
}
