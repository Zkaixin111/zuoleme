import { handleApi } from './api';
import { runCron } from './cron';
import type { Env } from './env';

/**
 * Worker 入口。
 *
 * 一个 Worker 同时承载三件事（单域名、无 CORS、一次 deploy 全搞定）：
 * 1. 静态资源：`env.ASSETS` 提供 dist/ 下的 PWA 前端（含 SPA 回退）
 * 2. REST API：/api/*（wrangler.jsonc 里用 run_worker_first 保证先到 Worker）
 * 3. 定时任务：每分钟的 Cron 扫到期提醒并发 Web Push
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return await handleApi(request, env);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    // 其余全部交给静态资源绑定（未命中的路径按 SPA 规则回退到 index.html）
    return await env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 用 scheduledTime 作为 now，让扫描基准与触发时间一致
    const now = typeof controller.scheduledTime === 'number' ? controller.scheduledTime : Date.now();
    ctx.waitUntil(runCron(env, now));
  },
} satisfies ExportedHandler<Env>;
