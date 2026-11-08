import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * - `webDir: 'dist'`：`npm run build` 的产物目录，`npx cap sync` 会把它拷进 Android 工程的 assets；
 * - `appId` 一旦装到手机上就不要再改，否则会被当成另一个应用（旧数据留在旧包里）；
 * - 不开 `server.url`：APK 必须完全离线自包含，不能指向任何远程地址。
 */
const config: CapacitorConfig = {
  appId: 'com.zkaixin.zuoleme',
  appName: '做了么',
  webDir: 'dist',
  android: {
    // 本地文件不需要混合内容，保持默认关闭，避免任何远程请求被放行
    allowMixedContent: false,
  },
};

export default config;
