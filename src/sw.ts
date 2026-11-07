/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

/**
 * Service Worker（骨架阶段）：只做应用壳预缓存，保证离线可打开。
 * 推送处理（push / notificationclick）在后续阶段接入。
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

/** workbox 注入点（必须保留 self.__WB_MANIFEST 字面量） */
const precacheManifest = (self as unknown as { __WB_MANIFEST: Array<{ url: string; revision: string | null }> })
  .__WB_MANIFEST;

cleanupOutdatedCaches();
precacheAndRoute(precacheManifest);

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});
