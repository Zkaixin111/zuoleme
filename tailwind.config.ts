import type { Config } from 'tailwindcss';

/**
 * Tailwind 3.x 配置（4.x 已移除经典配置方式，故锁 3.x）。
 * content 只扫描真实用到的源码，避免产物无谓膨胀。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'sans-serif',
        ],
      },
      colors: {
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        ink: {
          900: '#0b1020',
          800: '#111827',
          700: '#1f2937',
          500: '#6b7280',
          300: '#d1d5db',
          100: '#f3f4f6',
        },
      },
      boxShadow: {
        card: '0 10px 30px -12px rgba(15, 23, 42, 0.25)',
      },
    },
  },
  plugins: [],
};

export default config;
