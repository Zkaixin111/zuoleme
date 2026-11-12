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
        /**
         * 深豆绿：**行动主按钮**的底色（新建待办 / 保存 / 去允许）。
         *
         * 刻意与 `accent`(#2F5D50) 并存而不是合并：`accent` 是语义绿（完成、选中、临近），
         * 用在勾选圆圈、开关、选中行底色、徽章、绿框按钮上；`action` 只是「点这里推进流程」
         * 那一类按钮的底色。两者混用会让「选中」和「可点」变成同一个颜色，页面就没有主次了。
         */
        action: '#4A8C76',
        /** 浅蓝灰：次优先级动作（常驻卡的「打开」） */
        info: '#6388A0',
        /** 暖米色：低优先级空心按钮的描边（`border-sand`）与文字（`text-sand-deep`） */
        sand: { DEFAULT: '#BFB8AA', deep: '#7A7468' },
        /** 砖红：只用于逾期 */
        alert: '#B4482F',
        /**
         * 逾期的浅底与描边。
         *
         * 刻意做成两个实色 token，而不是用 `bg-alert/5` 这类半透明叠加：
         * 半透明在纸色底上会混出不确定的颜色，也和「不用半透明叠加」的设计约束冲突。
         */
        'alert-soft': '#FAECE8',
        'alert-line': '#E8C9C1',
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
