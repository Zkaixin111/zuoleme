/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import type { PushPayload, ReminderKind, SwClientMessage } from '../shared/types';
import { IDB_TOKEN_KEY } from './lib/constants';
import { idbGet } from './lib/idb';

/**
 * Service Worker。
 *
 * 四件事：
 * 1. 预缓存应用壳 → 离线也能打开。
 * 2. push 事件 → showNotification（requireInteraction: true = 尽量让通知不自动消失，
 *    但 Firefox for Android 不支持该属性，最终是否保留由系统/浏览器决定，本应用没有
 *    Android 原生前台服务，无法像原生应用那样保证一条通知永不消失）。
 * 3. notificationclick → 聚焦已有窗口 / 打开新窗口；带 done 动作时直接调接口标记完成。
 * 4. pushsubscriptionchange → 订阅被浏览器轮换时自动重订阅并同步回后端，
 *    避免「后端订阅被 410 清理后通知永久停摆、页面却仍显示已开启」。
 */

const sw = self as unknown as ServiceWorkerGlobalScope;

/** workbox 注入点：构建时会把预缓存清单替换到这里（必须保留 self.__WB_MANIFEST 字面量） */
const precacheManifest = (self as unknown as { __WB_MANIFEST: Array<{ url: string; revision: string | null }> })
  .__WB_MANIFEST;

const ICON_URL = '/icons/icon-192.png';
const DEFAULT_TITLE = '做了么';

cleanupOutdatedCaches();
precacheAndRoute(precacheManifest);

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') {
    void sw.skipWaiting();
  }
});

interface ParsedPush {
  payload: PushPayload | null;
  rawText: string;
}

/** 解析推送体；异常时保留原始文本作为降级内容 */
function readPushData(event: PushEvent): ParsedPush {
  if (!event.data) {
    return { payload: null, rawText: '' };
  }

  let rawText = '';
  try {
    rawText = event.data.text();
  } catch {
    rawText = '';
  }

  try {
    const raw = JSON.parse(rawText) as Partial<PushPayload>;
    if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || typeof raw.todoId !== 'string') {
      return { payload: null, rawText };
    }
    const kind: ReminderKind = raw.kind ?? 'due';
    return {
      payload: {
        title: raw.title,
        body: raw.body,
        todoId: raw.todoId,
        kind,
        tag: typeof raw.tag === 'string' && raw.tag.length > 0 ? raw.tag : `todo:${raw.todoId}:${kind}`,
      },
      rawText,
    };
  } catch {
    return { payload: null, rawText };
  }
}

sw.addEventListener('push', (event: PushEvent) => {
  const { payload, rawText } = readPushData(event);

  const options: NotificationOptions & Record<string, unknown> = {
    body: payload ? payload.body : rawText || '有一件事快到截止时间了',
    // requireInteraction：让通知停留，不自动消失（Android 上系统通知本身也会保留在通知栏）
    requireInteraction: true,
    // tag：不同事项、不同档位各自独立一条，互不覆盖
    tag: payload?.tag ?? `zuoleme:${Date.now()}`,
    icon: ICON_URL,
    badge: ICON_URL,
    vibrate: [180, 80, 180],
    actions: [{ action: 'done', title: '完成', icon: ICON_URL }],
    data: {
      todoId: payload?.todoId ?? '',
      kind: payload?.kind ?? 'due',
      url: '/',
    },
  };

  event.waitUntil(sw.registration.showNotification(payload?.title ?? DEFAULT_TITLE, options));
});

interface PushSubscriptionChangeEventLike {
  oldSubscription?: PushSubscription | null;
  newSubscription?: PushSubscription | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * 订阅被浏览器轮换/失效时自动重订阅并同步回后端。
 *
 * 没有这个处理时的表现正是「通知动不动就没了、且毫无提示」：浏览器换掉订阅后，
 * 后端还拿着旧 endpoint 发推送 → 收到 410 → 删掉旧订阅 → 从此再也不发，
 * 而设置页只看本地订阅仍显示「已开启」。这里在轮换事件里就把新订阅补上报，
 *  token 从 IndexedDB 读（页面保存 token 时已镜像一份）。
 */
async function resubscribeAfterChange(event: PushSubscriptionChangeEventLike): Promise<void> {
  try {
    let subscription = event.newSubscription ?? null;
    if (!subscription) {
      const options = event.oldSubscription?.options;
      if (!options) {
        console.warn('[sw] pushsubscriptionchange 没有旧订阅参数，无法自动重订阅，请在应用里重开一次通知开关');
        return;
      }
      subscription = await sw.registration.pushManager.subscribe(options);
    }

    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    const endpoint = json.endpoint ?? subscription.endpoint;
    const p256dh = json.keys?.p256dh ?? '';
    const auth = json.keys?.auth ?? '';
    if (!endpoint || !p256dh || !auth) {
      console.warn('[sw] 重订阅返回的信息不完整，无法同步到后端');
      return;
    }

    const token = (await idbGet(IDB_TOKEN_KEY).catch(() => null)) ?? '';
    if (token.length === 0) {
      console.warn('[sw] 没有 API Token，无法同步新订阅（请先在应用设置里保存 Token）');
      return;
    }

    const response = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': token },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    });
    if (!response.ok) {
      console.warn(`[sw] 同步新订阅失败 status=${response.status}，下次打开应用时会自动重试同步`);
    }
  } catch (error) {
    console.error('[sw] pushsubscriptionchange 自动重订阅失败（下次打开应用时会自动重试同步）', error);
  }
}

sw.addEventListener('pushsubscriptionchange', (event: Event) => {
  const changeEvent = event as unknown as PushSubscriptionChangeEventLike;
  changeEvent.waitUntil(resubscribeAfterChange(changeEvent));
});

interface NotificationClickData {
  todoId?: string;
  kind?: ReminderKind;
}

/** 用 IndexedDB 里的 token 调后端接口（Service Worker 读不到 localStorage） */
async function markTodoDoneInBackground(todoId: string): Promise<void> {
  const token = (await idbGet(IDB_TOKEN_KEY)) ?? '';
  if (token.length === 0) {
    console.warn('[sw] 没有 API Token，无法标记完成（请先在应用设置里保存 Token）');
    return;
  }

  try {
    const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': token,
      },
      body: JSON.stringify({ done: true }),
    });
    if (!response.ok) {
      console.warn(`[sw] 标记完成失败 status=${response.status}`);
      return;
    }
    await notifyClients({ type: 'todo-completed', todoId });
  } catch (error) {
    console.error('[sw] 标记完成请求异常', error);
  }
}

/** 给所有已打开的窗口发消息（页面据此刷新列表） */
async function notifyClients(message: SwClientMessage): Promise<void> {
  const clientList = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage(message);
  }
}

/** 已有窗口则聚焦，否则新开一个 */
async function focusOrOpenWindow(todoId: string, kind: ReminderKind): Promise<void> {
  const clientList = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if ('focus' in client) {
      await client.focus();
      client.postMessage({ type: 'notification-clicked', todoId, kind } satisfies SwClientMessage);
      return;
    }
  }
  await sw.clients.openWindow(todoId.length > 0 ? `/?todo=${encodeURIComponent(todoId)}` : '/');
}

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  const data = (event.notification.data ?? {}) as NotificationClickData;
  const todoId = typeof data.todoId === 'string' ? data.todoId : '';
  const kind: ReminderKind = data.kind ?? 'due';

  if (event.action === 'done' && todoId.length > 0) {
    event.waitUntil(markTodoDoneInBackground(todoId));
    return;
  }

  event.waitUntil(focusOrOpenWindow(todoId, kind));
});
