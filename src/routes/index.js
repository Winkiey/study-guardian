/**
 * 路由装配。
 *
 * 把所有路由注册到一个 Router 实例上，由 server.js 统一调度。
 */

import { Router } from '../lib/http.js';
import { registerApi } from './api.js';
import { registerPages } from './pages.js';
import { registerFileRoutes } from './files.js';
import { registerCalendarRoutes } from './calendar.js';

export function createRouter() {
  const router = new Router();

  // 顺序无所谓（Router 按注册顺序匹配，但各模块路径不重叠）
  registerCalendarRoutes(router);
  registerFileRoutes(router);
  registerApi(router);
  registerPages(router);

  return router;
}

export { Router };
