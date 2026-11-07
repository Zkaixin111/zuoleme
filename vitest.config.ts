import { defineConfig } from 'vitest/config';

/**
 * 测试配置与 vite.config.ts 分离：单元测试只跑纯函数，
 * 不需要 react 插件和 PWA 插件，避免额外副作用。
 *
 * fileParallelism 关闭：测试文件很少（毫秒级），串行执行可以避免多个 worker
 * 争用 Vite 的临时缓存目录（在受限环境里会偶发 EPERM 导致某个测试文件被跳过）。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    cache: false,
    reporters: 'default',
  },
});
