import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatDeadline, formatRemaining, toDateTimeLocalValue } from '../shared/format';
import { groupTodos } from '../src/lib/group-todos';
import { repeatLabel } from '../shared/repeat';
import type { Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';

/**
 * QA 独立复验：界面依赖的纯逻辑（分组边界、时间格式化、重复文案）。
 *
 * 组件本身在 node 环境渲染不了（没有 jsdom），所以这里测两件事：
 * 1. 组件拿到的**数据**是否正确（分组边界、文案）；
 * 2. 组件模板里是否具备必要的样式钩子（`break-words` / `whitespace-pre-wrap`），用静态断言兜住。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读取仓库内源码。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 构造待办。
 *
 * @param id 待办 id
 * @param deadline 截止时间
 * @param done 是否已完成
 */
function makeTodo(id: string, deadline: number, done: boolean = false): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    advanceReminder: true,
    deadline,
    done,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
  };
}

/**
 * 取一条待办落在哪个分组。
 *
 * @param todos 待办列表
 * @param id 待办 id
 */
function groupOf(todos: readonly Todo[], id: string): string | null {
  for (const group of groupTodos(todos, NOW)) {
    if (group.todos.some((todo) => todo.id === id)) {
      return group.key;
    }
  }
  return null;
}

describe('分组边界：今天 23:59 / 明天 00:01 / 已逾期', () => {
  const todayEnd = new Date(2026, 2, 3, 23, 59, 0, 0).getTime();
  const tomorrowStart = new Date(2026, 2, 4, 0, 1, 0, 0).getTime();

  it('今天 23:59 → 「今天」；明天 00:01 → 「明天」', () => {
    const todos = [makeTodo('today-late', todayEnd), makeTodo('tomorrow-early', tomorrowStart)];

    expect(groupOf(todos, 'today-late')).toBe('today');
    expect(groupOf(todos, 'tomorrow-early')).toBe('tomorrow');
  });

  it('明天 00:00 整 → 「明天」（不能因为差 1 毫秒就分到「今天」）', () => {
    const exactMidnight = new Date(2026, 2, 4, 0, 0, 0, 0).getTime();
    expect(groupOf([makeTodo('midnight', exactMidnight)], 'midnight')).toBe('tomorrow');
  });

  it('已逾期（deadline 比 now 早 1 毫秒）→ 「已逾期」，且排在最前', () => {
    const todos = [
      makeTodo('later', NOW + 10 * DAY_MS),
      makeTodo('overdue', NOW - 1),
      makeTodo('today', NOW + HOUR_MS),
    ];
    const groups = groupTodos(todos, NOW);

    expect(groups[0].key).toBe('overdue');
    expect(groups[0].todos[0].id).toBe('overdue');
  });

  it('分组顺序固定：已逾期 → 今天 → 明天 → 本周 → 以后，空分组不出现', () => {
    const todos = [
      makeTodo('o', NOW - HOUR_MS),
      makeTodo('t', NOW + HOUR_MS),
      makeTodo('m', NOW + 1 * DAY_MS + HOUR_MS),
      makeTodo('w', NOW + 3 * DAY_MS),
      makeTodo('l', NOW + 20 * DAY_MS),
    ];

    expect(groupTodos(todos, NOW).map((group) => group.key)).toEqual(['overdue', 'today', 'tomorrow', 'week', 'later']);
  });

  it('已完成的待办统一落在「以后」，不插在今天里干扰视线', () => {
    const todos = [makeTodo('done-today', NOW + HOUR_MS, true)];
    expect(groupOf(todos, 'done-today')).toBe('later');
  });

  it('组内按 deadline 升序排列', () => {
    const todos = [
      makeTodo('b', NOW + 2 * HOUR_MS),
      makeTodo('a', NOW + 1 * HOUR_MS),
      makeTodo('c', NOW + 3 * HOUR_MS),
    ];
    const today = groupTodos(todos, NOW).find((group) => group.key === 'today');
    expect(today?.todos.map((todo) => todo.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('时间文案：formatDeadline / formatRemaining 边界', () => {
  it('今天 / 明天 / 昨天 三个相对日', () => {
    const today = new Date(2026, 2, 3, 9, 5, 0, 0).getTime();
    const tomorrow = new Date(2026, 2, 4, 9, 5, 0, 0).getTime();
    const yesterday = new Date(2026, 2, 2, 9, 5, 0, 0).getTime();

    expect(formatDeadline(today, NOW)).toBe('今天 09:05');
    expect(formatDeadline(tomorrow, NOW)).toBe('明天 09:05');
    expect(formatDeadline(yesterday, NOW)).toBe('昨天 09:05');
  });

  it('跨年：往年日期带年份，同一年只带月日', () => {
    expect(formatDeadline(new Date(2026, 11, 31, 9, 0, 0, 0).getTime(), NOW)).toBe('12月31日 09:00');
    expect(formatDeadline(new Date(2027, 0, 1, 9, 0, 0, 0).getTime(), NOW)).toBe('2027年1月1日 09:00');
  });

  it('剩余时间四段：不到 1 分钟 / 分钟 / 小时 / 天', () => {
    expect(formatRemaining(59_999)).toBe('不到1分钟');
    expect(formatRemaining(MINUTE_MS)).toBe('1分钟');
    expect(formatRemaining(45 * MINUTE_MS)).toBe('45分钟');
    expect(formatRemaining(HOUR_MS)).toBe('1小时');
    expect(formatRemaining(HOUR_MS + 30 * MINUTE_MS)).toBe('1小时30分钟');
    expect(formatRemaining(DAY_MS)).toBe('1天');
    expect(formatRemaining(DAY_MS + 2 * HOUR_MS)).toBe('1天2小时');
    // 有天数时不再显示小时以下的零头（刻意的收敛）
    expect(formatRemaining(DAY_MS + 30 * MINUTE_MS)).toBe('1天');
  });

  it('超大时长不溢出、不出现 NaN', () => {
    expect(formatRemaining(3650 * DAY_MS)).toBe('3650天');
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('编辑回填：datetime-local 的本地时区换算', () => {
  it('整分钟的时间戳往返不丢信息', () => {
    const timestamp = new Date(2026, 2, 3, 23, 45, 0, 0).getTime();
    expect(new Date(toDateTimeLocalValue(timestamp)).getTime()).toBe(timestamp);
  });

  it('已知损失（已上报 P2）：带秒的时间戳回填后被截断到分钟，保存会悄悄改截止时间', () => {
    const withSeconds = new Date(2026, 2, 3, 23, 45, 37, 0).getTime();
    const roundTrip = new Date(toDateTimeLocalValue(withSeconds)).getTime();

    expect(roundTrip).toBe(withSeconds - 37_000);
    expect(roundTrip).not.toBe(withSeconds);
  });

  it('datetime-local 字符串的格式是 YYYY-MM-DDTHH:mm（少一位浏览器就报空值）', () => {
    expect(toDateTimeLocalValue(new Date(2026, 0, 5, 7, 8, 0, 0).getTime())).toBe('2026-01-05T07:08');
  });
});

describe('重复规则文案（详情页/列表第二行）', () => {
  it('五种规则的中文短语', () => {
    expect(repeatLabel({ kind: 'none' })).toBe('不重复');
    expect(repeatLabel({ kind: 'daily' })).toBe('每天');
    expect(repeatLabel({ kind: 'weekly', weekdays: [1, 4] })).toBe('每周一、四');
    expect(repeatLabel({ kind: 'monthly', dayOfMonth: 1 })).toBe('每月 1 日');
    expect(repeatLabel({ kind: 'interval', intervalMs: 6 * HOUR_MS })).toBe('每 6 小时');
    expect(repeatLabel({ kind: 'interval', intervalMs: 2 * DAY_MS })).toBe('每 2 天');
  });

  it('每周选满 7 天时显示「每天」（不要显示「每周日、一、二…」）', () => {
    expect(repeatLabel({ kind: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('每天');
  });

  it('空星期集合退化为「不重复」（读盘兜底，不显示空的「每周」）', () => {
    expect(repeatLabel({ kind: 'weekly', weekdays: [] })).toBe('不重复');
  });
});

describe('布局健壮性：超长标题与多行内容的样式钩子', () => {
  it('详情页标题与正文都有断行保护，内容保留换行', () => {
    const detail = readSource('src/components/DetailView.tsx');
    expect(detail).toMatch(/break-words text-\[22px\] font-semibold leading-snug text-ink/);
    expect(detail).toContain('whitespace-pre-wrap break-words');
  });

  it('列表行标题 break-words + min-w-0（否则长英文单词会把布局撑破）', () => {
    const row = readSource('src/components/TodoRow.tsx');
    expect(row).toContain('break-words');
    expect(row).toContain('min-w-0 flex-1');
  });

  it('标题/内容输入框有 maxLength，超长内容进不了存储层', () => {
    const editor = readSource('src/components/TodoEditor.tsx');
    expect(editor).toContain('maxLength={TITLE_MAX_LENGTH}');
    expect(editor).toContain('maxLength={CONTENT_MAX_LENGTH}');
  });

  it('常驻卡片也做了断行保护', () => {
    expect(readSource('src/components/PinnedCard.tsx')).toContain('break-words');
  });
});

describe('浅色纸感：配色 token 与禁用样式', () => {
  const TAILWIND = readSource('tailwind.config.ts');

  it('十个配色 token 的色值必须与产品规格逐字一致', () => {
    expect(TAILWIND).toContain("paper: '#F7F6F2'");
    expect(TAILWIND).toContain("surface: '#FFFFFF'");
    expect(TAILWIND).toContain("DEFAULT: '#E7E4DC'");
    expect(TAILWIND).toContain("strong: '#D8D3C7'");
    expect(TAILWIND).toContain("ink: '#1B1A17'");
    expect(TAILWIND).toContain("soft: '#6F6A60'");
    expect(TAILWIND).toContain("faint: '#A09A8E'");
    expect(TAILWIND).toContain("DEFAULT: '#2F5D50'");
    expect(TAILWIND).toContain("soft: '#EAF0ED'");
    expect(TAILWIND).toContain("alert: '#B4482F'");
  });

  it('tailwind 里没有 shadow / gradient / 旧色板 brand', () => {
    expect(TAILWIND).not.toMatch(/boxShadow|backdropBlur|backgroundImage/);
    expect(TAILWIND).not.toContain('brand');
  });

  it('源码里没有阴影 / 渐变 / 半透明白底 / 全大写小标签 / 毛玻璃', () => {
    const files = [
      'src/App.tsx',
      'src/components/HomeView.tsx',
      'src/components/DetailView.tsx',
      'src/components/TodoEditor.tsx',
      'src/components/TodoRow.tsx',
      'src/components/PinnedCard.tsx',
      'src/components/RepeatPicker.tsx',
      'src/components/HealthPanel.tsx',
      'src/index.css',
      'index.html',
    ];
    for (const file of files) {
      const source = readSource(file);
      expect(source, `${file} 命中禁用样式`).not.toMatch(
        /\bshadow-|\bbg-gradient-|bg-white\/\d|tracking-widest|uppercase|backdrop-blur/,
      );
    }
  });

  it('禁止引用的 class 必须在 tailwind 里真实存在（引用不存在的 class 会静默失效）', () => {
    /** 结构性工具类（不是颜色）：边框方向、字号、对齐 */
    const STRUCTURAL = new Set([
      't',
      'b',
      'l',
      'r',
      'x',
      'y',
      's',
      'e',
      'b-0',
      'none',
      'xs',
      'sm',
      'base',
      'lg',
      'xl',
      'center',
      'left',
      'right',
      'start',
      'end',
      'justify',
      'ellipsis',
      'wrap',
      'nowrap',
      'balance',
      'pretty',
    ]);

    const used = new Set<string>();
    for (const file of [
      'src/App.tsx',
      'src/components/HomeView.tsx',
      'src/components/DetailView.tsx',
      'src/components/TodoEditor.tsx',
      'src/components/TodoRow.tsx',
      'src/components/PinnedCard.tsx',
      'src/components/RepeatPicker.tsx',
      'src/components/HealthPanel.tsx',
    ]) {
      for (const match of readSource(file).matchAll(
        /(?:^|[\s"'`:])(?:bg|text|border|divide)-([a-z][a-z0-9-]*)(?:\/\d+)?/g,
      )) {
        used.add(match[1]);
      }
    }

    const palette = new Set([
      'paper',
      'surface',
      'line',
      'line-strong',
      'ink',
      'soft',
      'faint',
      'accent',
      'accent-soft',
      'alert',
      // 淡色告警底色：刻意用「实色」而不是 alert/5 这种透明度写法，
      // 因为半透明叠在纸感底色上会随背景漂移，看起来像没对齐的贴纸
      'alert-soft',
      'alert-line',
      'transparent',
      'white',
    ]);
    const unknown = [...used].filter((name) => !palette.has(name) && !STRUCTURAL.has(name));

    expect(unknown, `引用了不存在的颜色 class: ${unknown.join(', ')}`).toEqual([]);
  });
});
