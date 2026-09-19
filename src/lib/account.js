/**
 * 账号注销。
 *
 * 「注销」必须是**真的删干净**，不能只是让人登不进来：
 *   - 数据库：所有带 user_id 的表，包括 notify_log（发送历史能还原出
 *     一个人的作息与地理位置级别的行为，属于隐私，不能注销后还留着）
 *   - 磁盘：上传的课件、转换出来的 PDF、导出的幻灯片图片
 *
 * 这两边的删除方式完全不同 —— 数据库靠外键级联，磁盘只能自己动手，
 * 而且有先后顺序，所以整体放在一个模块里，别散在路由里。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { all, get, run, tx } from '../db/index.js';
import { derivedPath, uploadPath } from './files.js';
import { slidesDirFor } from './materials.js';

/**
 * 注销时要清点的表。
 *
 * 顺序是按「被引用 → 引用方」排的，读起来顺；实际删除不依赖这个顺序，
 * 因为最终删的是 users 那一行，剩下的交给 ON DELETE CASCADE。
 */
const USER_TABLES = [
  ['terms', '学期'],
  ['courses', '课程'],
  ['materials', '课件'],
  ['assignments', '作业'],
  ['reminders', '提醒'],
  ['notify_channels', '通知渠道'],
  ['notify_log', '发送日志'],
  ['settings', '设置'],
];

/**
 * 算出这个用户名下所有要删的磁盘路径（课件、PDF、幻灯片图片目录）。
 *
 * 必须在**删数据库之前**调用：行一旦删掉，这些路径就再也问不出来了。
 *
 * @returns {{files: string[], dirs: string[]}}
 */
export function collectUserFiles(userId) {
  const materials = all(
    'SELECT stored_name, pdf_name, slides_dir FROM materials WHERE user_id = ?',
    userId,
  );

  const files = [];
  const dirs = [];

  for (const m of materials) {
    const stored = String(m.stored_name || '');
    const base = stored ? path.basename(stored, path.extname(stored)) : '';

    // 上传的原件
    if (stored) {
      try { files.push(uploadPath(stored)); } catch { /* 路径异常就跳过 */ }
    }

    // 转换出来的 PDF。两种来源都要覆盖：
    // pdf_name 是权威记录，但转换器是按「stored_name 的主名 + .pdf」生成的，
    // 万一某次转换写完文件却没来得及更新 pdf_name（进程被杀），
    // 只认 pdf_name 就会漏掉一个再也无人认领的 PDF。
    if (m.pdf_name) {
      try { files.push(derivedPath(m.pdf_name)); } catch { /* 忽略 */ }
    }
    if (base) files.push(path.join(config.cacheDir, 'pdf', `${base}.pdf`));

    // 每页导出的幻灯片图片是一个目录
    if (m.slides_dir && stored) dirs.push(slidesDirFor(stored));
  }

  // 去重：万一 pdf_name 和推导出来的路径是同一个
  return { files: [...new Set(files)], dirs: [...new Set(dirs)] };
}

/**
 * 删除一个账号及其全部数据。
 *
 * 顺序：查文件清单 → 事务里删库 → 提交后删文件。
 *
 * 为什么文件删除放在最后：这是唯一会失败（而且失败不致命）的一步。
 * 如果先删文件再删库，中途出错就会留下「文件没了、记录还在」的脏状态 ——
 * 用户看到一堆点不开的课件，还得手工收拾。
 * 反过来最多在磁盘上剩几个孤儿文件，不影响任何人使用，事后还能清。
 *
 * @returns {Promise<{ok: boolean, counts: Record<string, number>, removedFiles: number, username: string}>}
 */
export async function deleteAccount(userId) {
  const id = Number(userId);
  const user = get('SELECT id, username FROM users WHERE id = ?', id);
  if (!user) return { ok: false, counts: {}, removedFiles: 0, username: '' };

  const { files, dirs } = collectUserFiles(id);

  const counts = tx(() => {
    const before = {};
    for (const [table] of USER_TABLES) {
      before[table] = Number(get(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`, id)?.c || 0);
    }

    // 删 users 这一行会级联清掉带外键的那批表
    run('DELETE FROM users WHERE id = ?', id);

    // 这两张表没有外键（建表时没加），级联管不到，必须显式删。
    // 漏掉的后果不是报错，而是「注销了，历史还在库里」—— 不会有人发现。
    run('DELETE FROM notify_log WHERE user_id = ?', id);
    run('DELETE FROM settings WHERE user_id = ?', id);

    return before;
  });

  let removedFiles = 0;
  for (const dir of dirs) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      removedFiles += 1;
    } catch { /* 目录可能不存在 */ }
  }
  for (const file of files) {
    try {
      await fsp.unlink(file);
      removedFiles += 1;
    } catch { /* 文件可能不存在 */ }
  }

  return { ok: true, counts, removedFiles, username: user.username };
}
