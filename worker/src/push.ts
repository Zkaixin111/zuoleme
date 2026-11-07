import type { PushPayload, SubRow } from '../../shared/types';
import type { Env } from './env';
import { buildPushRequest } from './webpush';

/**
 * 推送发送层：把一条推送体发给单个订阅。
 * 只负责「尽力发送 + 判定订阅是否失效」，不做重试编排（由 Cron 下一轮兜底）。
 */

export interface SendResult {
  subscriptionId: string;
  ok: boolean;
  status: number;
  /** 订阅已失效（404/410），调用方应删除 */
  gone: boolean;
  error?: string;
}

/**
 * 向单个订阅发送推送。
 *
 * @param env 运行环境
 * @param sub 订阅记录
 * @param payload 推送体
 * @param now 当前时间（毫秒）
 */
export async function sendPushToSub(
  env: Env,
  sub: SubRow,
  payload: PushPayload,
  now: number,
): Promise<SendResult> {
  try {
    const request = await buildPushRequest(env, { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, now);

    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    if (response.status >= 200 && response.status < 300) {
      return { subscriptionId: sub.id, ok: true, status: response.status, gone: false };
    }

    const gone = response.status === 404 || response.status === 410;
    const text = await response.text().catch(() => '');
    console.warn(`[push] 发送失败 status=${response.status} gone=${gone} body=${text.slice(0, 200)}`);
    return { subscriptionId: sub.id, ok: false, status: response.status, gone, error: text.slice(0, 200) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[push] 发送异常 endpoint=${sub.endpoint} error=${message}`);
    // 网络/加密异常无法判定订阅失效，保留订阅等下一轮重试
    return { subscriptionId: sub.id, ok: false, status: 0, gone: false, error: message };
  }
}
