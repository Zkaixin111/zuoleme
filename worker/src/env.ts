import type { VapidConfig } from './vapid';

/**
 * 运行环境绑定。密钥全部来自 `wrangler secret`，
 * 本地开发放在 `.dev.vars`（已 gitignore）。
 */
export interface Env extends VapidConfig {
  /** 静态资源绑定（dist/） */
  ASSETS: Fetcher;
  /** D1 数据库 */
  DB: D1Database;
  /** 接口访问令牌，前端在设置里填写 */
  API_TOKEN: string;
}
