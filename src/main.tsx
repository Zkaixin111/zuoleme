import { Capacitor } from '@capacitor/core';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

/**
 * 应用入口。
 *
 * 只有「浏览器（网页版）」才注册 Service Worker：
 * APK 里页面由 Capacitor 的 WebView 本地加载，没有 HTTP 缓存层，
 * 注册 SW 不仅没用，某些 WebView 版本还会在 register 时抛错。
 */
if (!Capacitor.isNativePlatform()) {
  registerSW({ immediate: true });
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('找不到 #root 挂载节点');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
