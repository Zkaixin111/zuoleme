/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import type { PushPayload, ReminderKind, SwClientMessage } from '../shared/types';
import { IDB_TOKEN_KEY } from './lib/constants';
import { idbGet } from './lib/idb';

/**
 * Service Worker。
 *
 * 三件事：
 * 1. 预缓存应用壳 → 离线也能打开。
 * 2. push 事件 → showNotification（requireInteraction: true = 通知不自动消失）。
 * 3. notificationclick → 聚焦已有窗口 / 打开新窗口；带 done 动作时直接调接口标记完成。
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
