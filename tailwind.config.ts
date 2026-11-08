import type { Config } from 'tailwindcss';

/**
 * Tailwind 3.x 配置。
 *
 * 配色是「浅色纸感」：暖纸白底 + 纯白卡面 + 极淡的实线描边，
 * 层次靠描边与留白做，**不用阴影、不用渐变、不用半透明叠加**。
 * 圆角刻意收敛（14 / 12 / 10），避免一眼看出是模板生成的「大圆角卡片」。
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
        /** 页面底色：暖纸白，不是纯白 */
        paper: '#F7F6F2',
        /** 卡片面 */
        surface: '#FFFFFF',
        /** 分隔线 / 卡片描边 + 更强的输入框描边 */
        line: {
          DEFAULT: '#E7E4DC',
          strong: '#D8D3C7',
        },
        /** 主文字：近墨黑 */
        ink: '#1B1A17',
        /** 次文字 */
        soft: '#6F6A60',
        /** 三级文字 / 标签 */
        faint: '#A09A8E',
        /** 墨绿：主按钮、倒计时、选中态 */
        accent: {
          DEFAULT: '#2F5D50',
          soft: '#EAF0ED',
        },
        /** 砖红：只用于逾期 */
        alert: '#B4482F',
      },
      borderRadius: {
        card: '14px',
        item: '12px',
        control: '10px',
      },
    },
  },
  plugins: [],
};

export default config;
