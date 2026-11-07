/**
 * VAPID 配置（Web Push 签名所需）。
 *
 * 单独抽出，避免纯加密模块依赖 Worker 的 `Env`（Env 里含 D1Database / Fetcher 等
 * 仅 Workers 环境存在的全局类型，前端程序引用时会报「找不到名称」）。
 */
export interface VapidConfig {
  /** VAPID 公钥：base64url 编码的 65 字节未压缩 P-256 点 */
  VAPID_PUBLIC_KEY: string;
  /** VAPID 私钥：base64url 编码的 32 字节标量 */
  VAPID_PRIVATE_KEY: string;
  /** 联系方式：mailto:you@example.com 或 https://example.com */
  VAPID_SUBJECT: string;
}
