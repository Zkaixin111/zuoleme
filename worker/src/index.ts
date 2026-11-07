import type { Env } from './env';

/**
 * Worker 入口（骨架阶段）。
 * 单个 Worker 同时承载：静态资源 + /api/* + Cron。
 * 后续阶段接入 D1、鉴权与 Web Push。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    // 其余请求交给静态资源绑定（含 SPA 回退）
    return await env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
