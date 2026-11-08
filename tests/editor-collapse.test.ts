import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatDeadline, toDateTimeLocalValue } from '../shared/format';
import { repeatLabel } from '../shared/repeat';
import { NO_REPEAT, type RepeatRule } from '../shared/types';
import { api, readTodos } from '../src/lib/api';
import { EDITOR_SECTION_KEYS, defaultExpanded, sectionSummaries } from '../src/lib/editor-sections';
import { installMemoryStorage } from './helpers/memory-storage';

/**
 * 编辑页「截止时间 / 重复 / 提前提醒」三块折叠（本轮需求 1）。
 *
 * 折叠是**展示层**开关，最容易出的 bug 是「收起后保存被重置」——
 * 因为收起时控件被卸载，如果值存在控件里（非受控）就会丢。
 * 所以这里分三层锁：
 *
 * 1. 纯函数层：默认展开策略 + 摘要文案（`src/lib/editor-sections.ts`）；
 * 2. 数据层：模拟「展开→改→收起→保存」的最终写入，断言落盘值与预期一致；
 * 3. 源码层：区块只受控、`children` 收起时不渲染、表单状态在 `TodoEditor` 顶层、
 *    提交读的是 state 而不是 DOM。
 */

const ROOT = new URL('../', import.meta.url);
const HOUR_MS = 3_600_000;
const NOW = new Date(2026, 10, 8, 20, 0, 0, 0).getTime();

/**
 * 读取仓库内的源码文件。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const EDITOR = readSource('src/components/TodoEditor.tsx');
const SECTION = readSource('src/components/CollapsibleSection.tsx');

const storage = installMemoryStorage();

beforeEach(() => {
  storage.clear();
});

/**
 * 构造摘要输入。
 *
 * @param overrides 覆盖字段
 */
function summaryInput(overrides: Partial<Parameters<typeof sectionSummaries>[0]> = {}) {
  return {
    hasDeadline: true,
    deadlineInput: toDateTimeLocalValue(NOW + 2 * HOUR_MS),
    repeat: NO_REPEAT,
    advanceReminder: true,
    now: NOW,
    ...overrides,
  };
}

describe('defaultExpanded：编辑全收，新建只展截止时间', () => {
  it('编辑已有待办 → 三块全部折叠', () => {
    expect(defaultExpanded(false)).toEqual({ deadline: false, repeat: false, advance: false });
  });

  it('新建 → 只展开「截止时间」（否则用户看不到默认的「1 小时后」）', () => {
    expect(defaultExpanded(true)).toEqual({ deadline: true, repeat: false, advance: false });
  });

  it('三块的 key 齐全（少一个就会有块永远打不开）', () => {
    expect([...EDITOR_SECTION_KEYS].sort()).toEqual(['advance', 'deadline', 'repeat']);
    expect(Object.keys(defaultExpanded(false)).sort()).toEqual([...EDITOR_SECTION_KEYS].sort());
  });
});

describe('sectionSummaries：摘要必须与表单值同步', () => {
  it('不设时间 → 截止时间「不设时间」，另外两块「不可用」', () => {
    const summaries = sectionSummaries(summaryInput({ hasDeadline: false }));

    expect(summaries).toEqual({ deadline: '不设时间', repeat: '不可用', advance: '不可用' });
  });

  it('截止时间摘要与 formatDeadline 同源（今天 / 明天 / 同年 / 跨年）', () => {
    const cases: Array<[number, string]> = [
      [NOW + 2 * HOUR_MS, '今天 22:00'],
      [new Date(2026, 10, 9, 9, 0, 0, 0).getTime(), '明天 09:00'],
      [new Date(2026, 11, 12, 9, 0, 0, 0).getTime(), '12月12日 09:00'],
      [new Date(2027, 0, 3, 9, 5, 0, 0).getTime(), '2027年1月3日 09:05'],
    ];

    for (const [timestamp, expected] of cases) {
      const input = toDateTimeLocalValue(timestamp);
      expect(sectionSummaries(summaryInput({ deadlineInput: input })).deadline).toBe(expected);
      // 与列表用的是同一套文案，不允许出现第二套格式
      expect(sectionSummaries(summaryInput({ deadlineInput: input })).deadline).toBe(
        formatDeadline(new Date(input).getTime(), NOW),
      );
    }
  });

  it('输入框被清空 → 「未选择」，不显示 NaN', () => {
    const summaries = sectionSummaries(summaryInput({ deadlineInput: '' }));

    expect(summaries.deadline).toBe('未选择');
    expect(summaries.deadline).not.toContain('NaN');
  });

  it('重复摘要用 repeatLabel 的同一套文案', () => {
    const rules: RepeatRule[] = [
      { kind: 'none' },
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 4] },
      { kind: 'monthly', dayOfMonth: 25 },
      { kind: 'interval', intervalMs: 6 * HOUR_MS },
    ];

    for (const repeat of rules) {
      expect(sectionSummaries(summaryInput({ repeat })).repeat).toBe(repeatLabel(repeat));
    }
  });

  it('改成「每周三」后摘要立刻是「每周三」（收起状态下用户只能看到这行字）', () => {
    const before = sectionSummaries(summaryInput({ repeat: { kind: 'daily' } }));
    const after = sectionSummaries(summaryInput({ repeat: { kind: 'weekly', weekdays: [3] } }));

    expect(before.repeat).toBe('每天');
    expect(after.repeat).toBe('每周三');
  });

  it('提前提醒摘要：开启 / 仅到点 / 不可用', () => {
    expect(sectionSummaries(summaryInput({ advanceReminder: true })).advance).toBe('已开启');
    expect(sectionSummaries(summaryInput({ advanceReminder: false })).advance).toBe('仅到点提醒');
    expect(sectionSummaries(summaryInput({ hasDeadline: false })).advance).toBe('不可用');
  });
});

describe('折叠不影响提交值（数据层端到端）', () => {
  it('编辑「每天 · 明天 20:00 · 提前提醒开启」→ 什么都不改直接保存 → 三个值原样保留', async () => {
    const deadline = new Date(2026, 10, 9, 20, 0, 0, 0).getTime();
    const created = await api.createTodo({
      title: '吃药',
      content: '饭后',
      deadline,
      advanceReminder: true,
      repeat: { kind: 'daily' },
    });

    // 模拟 TodoEditor.handleSubmit 在「三块都收起、用户没动」时提交的值
    const saved = await api.updateTodo(created.id, {
      title: '吃药',
      content: '饭后',
      deadline,
      advanceReminder: true,
      repeat: { kind: 'daily' },
    });

    expect(saved.deadline).toBe(deadline);
    expect(saved.repeat).toEqual({ kind: 'daily' });
    expect(saved.advanceReminder).toBe(true);
    // 落盘也要一致（别只改了返回值）
    const persisted = readTodos()[0];
    expect(persisted.deadline).toBe(deadline);
    expect(persisted.repeat).toEqual({ kind: 'daily' });
    expect(persisted.advanceReminder).toBe(true);
  });

  it('展开「重复」改成「每周三」→ 收起 → 保存 → 落盘是 weekly[3]，其它字段不受影响', async () => {
    const deadline = new Date(2026, 10, 9, 20, 0, 0, 0).getTime();
    const created = await api.createTodo({
      title: '复盘',
      content: '',
      deadline,
      advanceReminder: true,
      repeat: { kind: 'daily' },
    });

    const saved = await api.updateTodo(created.id, {
      title: '复盘',
      content: '',
      deadline,
      advanceReminder: true,
      repeat: { kind: 'weekly', weekdays: [3] },
    });

    expect(saved.repeat).toEqual({ kind: 'weekly', weekdays: [3] });
    expect(saved.deadline).toBe(deadline);
    expect(saved.advanceReminder).toBe(true);
    expect(sectionSummaries(summaryInput({ repeat: saved.repeat })).repeat).toBe('每周三');
  });

  it('只改标题（三块都收起）→ 时间 / 重复 / 提前提醒都不动', async () => {
    const deadline = new Date(2026, 10, 9, 20, 0, 0, 0).getTime();
    const created = await api.createTodo({
      title: '旧标题',
      content: '说明',
      deadline,
      advanceReminder: false,
      repeat: { kind: 'weekly', weekdays: [1, 4] },
    });

    const saved = await api.updateTodo(created.id, {
      title: '新标题',
      content: '说明',
      deadline,
      advanceReminder: false,
      repeat: { kind: 'weekly', weekdays: [1, 4] },
    });

    expect(saved.title).toBe('新标题');
    expect(saved.deadline).toBe(deadline);
    expect(saved.repeat).toEqual({ kind: 'weekly', weekdays: [1, 4] });
    expect(saved.advanceReminder).toBe(false);
  });
});

describe('CollapsibleSection：受控、收起不渲染、可访问性', () => {
  it('开合状态受控（组件自己没有 useState）', () => {
    // 注意：组件 KDoc 里出现的是「而不是自己 `useState` 管开合」这句话本身，
    // 所以不能直接断言源码不含 'useState' 这个词 —— 要断言的是「没有真正的调用/引入」。
    expect(SECTION).not.toMatch(/useState[<(]/);
    expect(SECTION).not.toMatch(/import\s*\{[^}]*\buseState\b/);
    expect(SECTION).not.toContain('setOpen');
    expect(SECTION).toContain('open: boolean;');
    expect(SECTION).toContain('onToggle: () => void;');
  });

  it('header 是整行 button，44px，左标题右摘要 + chevron', () => {
    expect(SECTION).toContain('className={`flex h-11 w-full items-center justify-between gap-3 text-left');
    expect(SECTION).toContain('<span className="text-[13px] text-soft">{title}</span>');
    expect(SECTION).toContain('truncate text-[13px] text-ink');
    expect(SECTION).toContain('h-4 w-4 shrink-0 text-faint');
  });

  it('展开时 chevron 旋转 180°', () => {
    expect(SECTION).toContain("open ? 'rotate-180' : ''");
  });

  it('可访问性：aria-expanded / aria-controls / aria-disabled', () => {
    expect(SECTION).toContain('aria-expanded={open}');
    expect(SECTION).toContain('aria-controls={sectionId}');
    expect(SECTION).toContain('aria-disabled={disabled}');
    expect(SECTION).toContain('disabled={disabled}');
  });

  it('收起时 children 不渲染（不是 hidden），内容区带 id', () => {
    expect(SECTION).toContain('{open ? (');
    expect(SECTION).toContain('<div id={sectionId} className="pb-4">');
  });

  it('分隔线用 border-t，不套卡片', () => {
    expect(SECTION).toContain('<div className="border-t border-line">');
    expect(SECTION).not.toContain('card');
  });
});

describe('TodoEditor：三块接进折叠组件、状态留在顶层', () => {
  it('三块按「截止时间 → 重复 → 提前提醒」排列', () => {
    const deadline = EDITOR.indexOf('title="截止时间"');
    const repeat = EDITOR.indexOf('title="重复"');
    const advance = EDITOR.indexOf('title="提前提醒"');

    expect(deadline).toBeGreaterThan(-1);
    expect(repeat).toBeGreaterThan(deadline);
    expect(advance).toBeGreaterThan(repeat);
  });

  it('默认展开由 defaultExpanded 决定（不是散落的字面量）', () => {
    expect(EDITOR).toContain('useState<EditorSectionState>(() => defaultExpanded(todo === null))');
    expect(EDITOR).toContain('setExpanded(defaultExpanded(todo === null))');
  });

  it('「重复」「提前提醒」在没有截止时间时不可展开：disabled + open 强制 false', () => {
    expect(EDITOR).toContain('open={hasDeadline && expanded.repeat}');
    expect(EDITOR).toContain('open={hasDeadline && expanded.advance}');
    // 只数「传给 CollapsibleSection 的 disabled」这两个（`RepeatPicker` 自己也有一个同名 prop）
    expect(EDITOR.match(/disabled=\{!hasDeadline\}\s*\n\s*sectionId="section-(?:repeat|advance)"/g))
      .toHaveLength(2);
  });

  it('三个区块 id 唯一（aria-controls 必须指向真实存在的元素）', () => {
    expect(EDITOR).toContain('sectionId="section-deadline"');
    expect(EDITOR).toContain('sectionId="section-repeat"');
    expect(EDITOR).toContain('sectionId="section-advance"');
  });

  it('表单状态全部在 TodoEditor 顶层（控件卸载不丢值）', () => {
    expect(EDITOR).toContain('const [hasDeadline, setHasDeadline] = useState<boolean>');
    expect(EDITOR).toContain('const [deadlineValue, setDeadlineValue] = useState<string>');
    expect(EDITOR).toContain('const [advanceReminder, setAdvanceReminder] = useState<boolean>');
    expect(EDITOR).toContain('const [repeat, setRepeat] = useState<RepeatRule>');
    // 控件是受控的：值从 state 来，改动回写 state
    expect(EDITOR).toContain('value={deadlineValue}');
    expect(EDITOR).toContain('<RepeatPicker value={repeat} onChange={setRepeat}');
  });

  it('提交读的是 state（不是 DOM / 控件），所以收起不影响保存', () => {
    expect(EDITOR).toContain('deadline: draft.deadline,');
    expect(EDITOR).toContain('advanceReminder: hasDeadline ? advanceReminder : true,');
    expect(EDITOR).toContain('repeat: hasDeadline ? repeat : { kind: \'none\' },');
    // 组件里不出现任何从 DOM 读值的手法
    expect(EDITOR).not.toContain('querySelector');
    expect(EDITOR).not.toContain('getElementById');
  });

  it('切换编辑对象时重置表单的依赖是 todo?.id（对象身份变了不代表换了一条待办）', () => {
    expect(EDITOR).toContain('}, [todo?.id]);');
  });
});
