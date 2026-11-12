import type { PushSubscriptionJson } from '../../shared/types';
import { api, getToken } from './api';

/**
 * Web Push 订阅流程。
 * 任何一步失败都抛出**中文可读**的错误，绝不静默失败（用户明确要求）。
 */

export interface PushEnvironmentStatus {
  ok: boolean;
  /** 不可用时的中文原因 */
  reason: string | null;
}

/** 检测当前环境是否具备接收推送的条件 */
export function checkPushEnvironment(): PushEnvironmentStatus {
  if (typeof window === 'undefined') {
    return { ok: false, reason: '当前环境不支持推送。' };
  }
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: '当前页面不是 HTTPS，浏览器不会下发推送。请用 https:// 地址打开（本地 localhost 除外）。',
    };
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, reason: '当前浏览器不支持 Service Worker，无法接收推送。' };
  }
  if (!('PushManager' in window)) {
    return {
      ok: false,
      reason: '当前浏览器不支持 Web Push（缺少 PushManager）。Android 国内机型请使用 Firefox 打开本站。',
    };
  }
  if (!('Notification' in window)) {
    return { ok: false, reason: '当前浏览器不支持通知（缺少 Notification）。' };
  }
  return { ok: true, reason: null };
}

/** 把 base64url 的 VAPID 公钥转成 applicationServerKey 需要的 Uint8Array */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 给 Promise 加超时，避免 serviceWorker.ready 永久挂起 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

/** 等待 Service Worker 激活（带超时与可读错误） */
export async function waitForServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker，无法接收推送。');
  }
  try {
    return await withTimeout(
      navigator.serviceWorker.ready,
      15_000,
      'Service Worker 未就绪（15 秒超时）。请刷新页面重试；如果一直失败，请确认已通过 https 访问。',
    );
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Service Worker 未就绪');
  }
}

/**
 * 开启通知：申请权限 → 订阅 pushManager → 上报后端。
 *
 * @returns 订阅的 endpoint
 */
export async function subscribeToPush(): Promise<string> {
  const env = checkPushEnvironment();
  if (!env.ok) {
    throw new Error(env.reason ?? '当前环境不支持推送。');
  }

  if (getToken().length === 0) {
    throw new Error('请先在设置里填写 API Token，再开启通知。');
  }

  if (Notification.permission === 'denied') {
    throw new Error('通知权限已被拒绝。请到浏览器的「设置 → 网站权限 → 通知」里允许本站后再试。');
  }

  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('你拒绝了通知权限，收不到提醒。允许通知后才能开启。');
    }
  }

  const registration = await waitForServiceWorker();

  const vapidPublicKey = await api.getVapidPublicKey();
  if (vapidPublicKey.length === 0) {
    throw new Error('服务端没有返回 VAPID 公钥，请检查 Worker 的 VAPID_PUBLIC_KEY secret。');
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // 复制成 ArrayBuffer 支撑的视图，满足 DOM 的 BufferSource 类型要求
      applicationServerKey: new Uint8Array(urlBase64ToUint8Array(vapidPublicKey)),
    }));

  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh ?? '';
  const auth = json.keys?.auth ?? '';

  if (!endpoint || !p256dh || !auth) {
    throw new Error('浏览器没有返回完整的订阅信息，请刷新页面后重试。');
  }

  const payload: PushSubscriptionJson = { endpoint, keys: { p256dh, auth } };
  await api.subscribe(payload);
  return endpoint;
}

/** 关闭通知：先在后端删除订阅，再取消浏览器订阅 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return;
  }
  const registration = await waitForServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }
  const endpoint = subscription.endpoint;
  try {
    await api.unsubscribe(endpoint);
  } catch (error) {
    console.warn('后端删除订阅失败，仍继续取消浏览器订阅', error);
  }
  await subscription.unsubscribe();
}

/**
 * 自检并修复推送订阅（应用打开 / 切回前台时调用，失败只打日志、不打扰用户）。
 *
 * 「通知莫名其妙没了」最常见的两条断裂都在这里修复：
 * 1. 浏览器把订阅轮换/失效了（本地已无订阅）但权限还在 → 静默重新订阅并上报；
 * 2. 浏览器侧订阅还在、但后端已把订阅删了（例如推送曾返回 410 被清理）→
 *    设置页只看本地会显示「已开启」，实际永远收不到 → 把现有订阅重新上报一次
 *    （后端按 endpoint upsert，重复上报无副作用）。
 *
 * @returns 'synced' 已同步 / 'not-granted' 未授权 / 'unsupported' 环境不支持
 */
export async function ensurePushSubscriptionSynced(): Promise<'synced' | 'not-granted' | 'unsupported'> {
  const env = checkPushEnvironment();
  if (!env.ok || getToken().length === 0) {
    return 'unsupported';
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return 'not-granted';
  }

  const registration = await waitForServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (!existing) {
    // 权限还在但订阅没了：subscribeToPush 在已授权时不会再弹系统框，直接重建
    await subscribeToPush();
    return 'synced';
  }

  const json = existing.toJSON();
  const endpoint = json.endpoint ?? existing.endpoint;
  const p256dh = json.keys?.p256dh ?? '';
  const auth = json.keys?.auth ?? '';
  if (!endpoint || !p256dh || !auth) {
    throw new Error('浏览器返回的订阅信息不完整');
  }
  await api.subscribe({ endpoint, keys: { p256dh, auth } });
  return 'synced';
}

/** 读取当前是否已有订阅 */
export async function hasPushSubscription(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }
  try {
    const registration = await waitForServiceWorker();
    const subscription = await registration.pushManager.getSubscription();
    return subscription !== null;
  } catch {
    return false;
  }
}
