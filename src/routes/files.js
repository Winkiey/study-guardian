/**
 * 课件文件服务。
 *
 * 三个入口：
 *   /materials/:id/raw   —— 原始文件（可 ?download=1 强制下载）
 *   /materials/:id/pdf   —— 转换后的 PDF（PPT/Word 预览用）
 *   /:id/thumb           —— 占位（未来可做缩略图）
 *
 * 关键点：这些接口必须校验归属，否则别人猜到 id 就能下载你的课件。
 */

import path from 'node:path';
import { get } from '../db/index.js';
import { forbidden, notFound, sendFile, unauthorized } from '../lib/http.js';
import { currentUser } from '../lib/auth.js';
import { derivedPath, uploadPath } from '../lib/files.js';
import { canViewMaterial } from '../lib/community.js';

export function registerFileRoutes(router) {
  /** 取资料并校验归属 */
  /**
   * 取一份资料，并判断**当前这个人能不能看**。
   *
   * 这是所有文件服务的唯一入口（raw / pdf / slide 都走它），
   * 所以授权逻辑只写在这一处 —— 散在各路由里的话，早晚有一条会漏掉判断。
   *
   * 规则（用户拍板的）：
   *   · 本人 —— 永远能看，不管有没有公开；
   *   · 同校同学 —— 只有在这份资料**被主动公开**时才能看；
   *   · 其他人 —— 看不到。
   *
   * 判断本身在 src/lib/community.js 的 canViewMaterial 里，"同校"的
   * 定义（精确相等 + 双方都从名单里选过）也只在那一处。
   *
   * ⚠️ 看不到时统一抛 **404 而不是 403**。
   *    403 等于告诉对方「这份资料存在，只是你无权看」——
   *    拿一串 id 试一遍就能数出别人有多少份资料、哪些是真实存在的。
   *    404 让「不存在」和「没权限」长得一模一样。
   */
  function resolveMaterial(req, id) {
    const user = currentUser(req);
    if (!user) throw unauthorized('请先登录');

    // 先只按 id 取，再用可见性规则判断 —— 刻意**不**把 user_id 写进 SQL。
    // 写进 SQL 的话就是"查自己的，查不到就当不存在"，那样加公开功能时
    // 得再写一条平行的查询，两条查询的规则迟早会不一致。
    const material = get('SELECT * FROM materials WHERE id = ?', id);
    if (!material) throw notFound('资料不存在或没有权限');

    const allowed = canViewMaterial(user.id, material.user_id, {
      published: material.published,
    });
    if (!allowed) throw notFound('资料不存在或没有权限');

    return material;
  }

  // 原始文件
  router.get('/materials/:id/raw', async (ctx) => {
    const id = Number.parseInt(ctx.params.id, 10);
    const material = resolveMaterial(ctx.req, id);

    const abs = uploadPath(material.stored_name);
    const download = ctx.url.searchParams.get('download') === '1';

    await sendFile(ctx.req, ctx.res, abs, {
      mime: material.mime || undefined,
      downloadName: download ? material.original_name : undefined,
      inlineName: download ? undefined : material.original_name,
      // 课件基本不会变，允许浏览器缓存；文件名带随机 ID，不会撞车
      cacheControl: 'private, max-age=3600',
    });
  });

  // 转换后的 PDF
  router.get('/materials/:id/pdf', async (ctx) => {
    const id = Number.parseInt(ctx.params.id, 10);
    const material = resolveMaterial(ctx.req, id);

    if (!material.pdf_name) {
      // 没有 PDF 时：如果本身就是 PDF 就直接给原件
      if (material.kind === 'pdf') {
        return sendFile(ctx.req, ctx.res, uploadPath(material.stored_name), {
          downloadName: ctx.url.searchParams.get('download') === '1' ? material.original_name : undefined,
          inlineName: ctx.url.searchParams.get('download') === '1' ? undefined : material.original_name,
        });
      }
      throw notFound('这份资料还没有可用的 PDF 预览');
    }

    // ⚠️ 必须用 derivedPath 而不是 uploadPath。
    // pdf_name 存的是 '../cache/pdf/xxx.pdf'（相对于 uploads 目录），
    // 而 uploadPath() 会把跑出 uploads 的路径判为非法并抛异常 ——
    // 于是 Office 转换成功、PDF 就在磁盘上，点开却是 500。
    // 真实验证过：换回 uploadPath 时，这条路由的 7 项端到端断言全红，
    // 报的就是「非法的存储路径」。
    const abs = derivedPath(material.pdf_name);
    const pdfName = material.original_name.replace(/\.[^.]+$/, '') + '.pdf';
    const download = ctx.url.searchParams.get('download') === '1';

    await sendFile(ctx.req, ctx.res, abs, {
      mime: 'application/pdf',
      downloadName: download ? pdfName : undefined,
      inlineName: download ? undefined : pdfName,
      cacheControl: 'private, max-age=3600',
    });
  });

  /**
   * 幻灯片图片：/materials/:id/slide/3
   *
   * PDF 转不出来时，PPT 会走「每页导出成图片」这条路，
   * 由这个接口把单页图片发给浏览器。页码从 1 开始。
   */
  router.get('/materials/:id/slide/:n', async (ctx) => {
    const id = Number.parseInt(ctx.params.id, 10);
    const n = Number.parseInt(ctx.params.n, 10);
    const material = resolveMaterial(ctx.req, id);

    if (!Number.isInteger(n) || n < 1) throw notFound('页码不对');
    if (!material.slides_dir) throw notFound('这份资料没有幻灯片图片');

    // 只接受纯数字页码，然后自己拼路径。
    // 绝不把 URL 里的字符串拼进路径 —— 那样 ?n=../../secret 就能读到别处去了。
    const dir = derivedPath(material.slides_dir);
    const abs = path.join(dir, `slide-${n}.png`);

    // 再确认一次解析出来的路径确实在这个目录里（双保险）
    if (path.dirname(path.resolve(abs)) !== path.resolve(dir)) {
      throw forbidden('非法路径');
    }

    await sendFile(ctx.req, ctx.res, abs, {
      mime: 'image/png',
      cacheControl: 'private, max-age=3600',
    });
  });

  return router;
}
