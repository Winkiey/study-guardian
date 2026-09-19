/**
 * 日历导出与订阅路由。
 *
 *   /calendar/download.ics   —— 需要登录，下载自己的日历
 *   /calendar/subscribe.ics  —— 用令牌鉴权，供手机日历定期拉取
 *
 * 订阅接口不能用 Cookie 鉴权（手机日历不会带 Cookie），
 * 所以用一个 HMAC 签名令牌放在 URL 里，可以随时失效。
 */

import { sendHtml } from '../lib/http.js';
import { get } from '../db/index.js';
import { currentUser } from '../lib/auth.js';
import { buildCalendar, exportStats, verifyCalendarToken } from '../lib/export/ics-export.js';
import { renderPage, pageHeader, card } from '../web/layout.js';

export function registerCalendarRoutes(router) {
  /** 下载：需要登录 */
  router.get('/calendar/download.ics', async (ctx) => {
    const user = currentUser(ctx.req);
    if (!user) {
      ctx.res.writeHead(302, { Location: '/login' });
      ctx.res.end();
      return;
    }

    const { ics, calendarName } = buildCalendar(user.id, {
      includeCourses: ctx.url.searchParams.get('courses') !== '0',
      includeAssignments: ctx.url.searchParams.get('assignments') !== '0',
      includeAlarms: true,
    });

    const body = Buffer.from(ics, 'utf8');
    ctx.res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(calendarName)}.ics`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(body);
  });

  /**
   * 订阅：令牌鉴权。
   *
   * 注意 iOS 对**订阅**日历会忽略事件里的 VALARM，
   * 所以这条通道只适合「看课表」，不适合当提醒用。README 里有说明。
   */
  router.get('/calendar/subscribe.ics', async (ctx) => {
    const token = ctx.url.searchParams.get('token') || '';
    const payload = verifyCalendarToken(token);

    if (!payload) {
      return sendHtml(ctx.res, invalidTokenPage(), 403);
    }

    const user = get('SELECT id FROM users WHERE id = ?', payload.userId);
    if (!user) return sendHtml(ctx.res, invalidTokenPage(), 403);

    const { ics } = buildCalendar(user.id, { includeAlarms: true });
    const body = Buffer.from(ics, 'utf8');

    ctx.res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      // 手机日历会按这个间隔来轮询；15 分钟是比较合理的值
      'Cache-Control': 'private, max-age=900',
      'Content-Length': body.length,
    });
    ctx.res.end(body);
  });

  /**
   * 给用户看的导出说明页。
   *
   * ⚠️ 这一页以前是手写的一小段裸 HTML，**没有导航栏、也没有「跳到主要内容」**，
   * 和站内其它每一页都不一样。后果很具体：用户从书签或历史记录打开它之后，
   * 页面上没有任何一个能点回站内的入口，只能手动改地址栏。
   * 所以现在走公共布局（renderPage），和别的页面长得一样、也能正常导航。
   */
  router.get('/calendar', async (ctx) => {
    const user = currentUser(ctx.req);
    if (!user) {
      ctx.res.writeHead(302, { Location: '/login' });
      ctx.res.end();
      return;
    }

    const stats = exportStats(user.id);
    const body = `
${pageHeader({
    title: '导出到手机日历',
    subtitle: '把课表和作业 DDL 放进 iPhone 自带的「日历」App。',
  })}

${card({
    body: `
  <p>当前有 <strong>${stats.courseCount}</strong> 门课程、<strong>${stats.sessionCount}</strong> 条上课时间、<strong>${stats.assignmentCount}</strong> 项待办作业。</p>
  <div class="btn-row mt-md">
    <a class="btn btn--primary" href="/calendar/download.ics">下载 .ics 文件</a>
    <a class="btn btn--outline" href="/settings#calendar">查看订阅链接</a>
  </div>
  <p class="field__help mt-md">
    <strong>下载</strong>下来的事件带闹钟，到点会响；用<strong>订阅</strong>方式添加的日历，
    iOS 会忽略事件里的闹钟，只适合用来看课表。作业提醒请用 Bark 或邮箱。
  </p>`,
  })}
`;

    return sendHtml(ctx.res, renderPage({
      title: '导出到手机日历',
      active: 'timetable',
      body,
      user,
      stats: {},
    }));
  });

  return router;
}

function invalidTokenPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>订阅链接无效</title><link rel="stylesheet" href="/static/app.css"></head>
<body><div class="main" style="max-width:520px;margin:80px auto">
<div class="card"><div class="card__body">
<h1 class="page-title">订阅链接无效或已过期</h1>
<p class="muted mt-sm">订阅令牌的有效期是 1 年，或者你可能重新部署过服务（换了密钥）。
请回到「设置 → 课表导入导出」重新复制订阅地址。</p>
<a class="btn btn--primary mt-md" href="/settings#calendar">去获取新链接</a>
</div></div>
</div></body></html>`;
}
