import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import { STORAGE_KEY, api, readTodos } from '../src/lib/api';
import { resolveDeadlineDraft } from '../src/lib/deadline-draft';
import { installMemoryStorage } from './helpers/memory-storage';

/**
 * 「逾期待办改不了标题」的回归测试。
 *
 * 事故形态（旧版就有，用户会立刻撞到）：一条昨天到期的待办，用户只想改标题，
 * 没动时间就保存 → 命中「截止时间必须晚于现在」的校验 → 弹错、**永远改不了标题**。
 *
 * 为什么之前没有测试拦住它：这条规则原先写在 `TodoEditor.handleSubmit` 里，
 * 要验证只能「渲染组件 → 点保存」，而项目没有 jsdom / RTL。
 * 所以规则被抽成了 `resolveDeadlineDraft` 这个纯函数：
 * 输入是「用户到底动没动过时间」，输出是「能不能保存、保存成什么」，可以直接逐组合断言。
 */

const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();

/** 昨天这个点（已经过去） */
const YESTERDAY = NOW - DAY_MS;

/**
 * 把时间戳转成 `datetime-local` 的文本（与 `shared/format.ts` 的 `toDateTimeLocalValue` 同格式）。
 *
 * @param timestamp 毫秒时间戳
 */
function toInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

describe('resolveDeadlineDraft：逾期待办只改标题必须能保存', () => {
  it('编辑 + 没动过时间 + 原始时间在昨天 → 允许保存，且原值原样带回', () => {
    const draft = resolveDeadlineDraft({
      isNew: false,
      hasDeadline: true,
      dirty: false,
      originalDeadline: YESTERDAY,
      inputValue: toInputValue(YESTERDAY),
      now: NOW,
    });

    expect(draft).toEqual({ ok: true, deadline: YESTERDAY });
  });

  it('编辑 + 没动过时间 → 原值带秒也不被分钟精度截断（P2-4 的回归）', () => {
    const withSeconds = YESTERDAY + 37_000;
    const draft = resolveDeadlineDraft({
      isNew: false,
      hasDeadline: true,
      dirty: false,
      originalDeadline: withSeconds,
      // 输入框里只有分钟精度，"昨天 19:60"→ 已丢掉 37 秒
      inputValue: toInputValue(withSeconds),
      now: NOW,
    });

    expect(draft).toEqual({ ok: true, deadline: withSeconds });
    expect(draft.ok && draft.deadline).not.toBe(new Date(toInputValue(withSeconds)).getTime());
  });

  it('新建 + 时间在过去 → 仍然拦（新建路径的校验一点没放松）', () => {
    expect(
      resolveDeadlineDraft({
        isNew: true,
        hasDeadline: true,
        dirty: false,
        originalDeadline: null,
        inputValue: toInputValue(YESTERDAY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'past' });
  });

  it('编辑 + 用户动过时间 + 改到过去 → 仍然拦（主动设过去没有意义）', () => {
    expect(
      resolveDeadlineDraft({
        isNew: false,
        hasDeadline: true,
        dirty: true,
        originalDeadline: NOW + DAY_MS,
        inputValue: toInputValue(YESTERDAY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'past' });
  });

  it('编辑 + 用户动过时间 + 改到未来 → 用输入值', () => {
    const future = NOW + 3 * HOUR_MS;
    expect(
      resolveDeadlineDraft({
        isNew: false,
        hasDeadline: true,
        dirty: true,
        originalDeadline: YESTERDAY,
        inputValue: toInputValue(future),
        now: NOW,
      }),
    ).toEqual({ ok: true, deadline: new Date(toInputValue(future)).getTime() });
  });

  it('「不设时间」→ 直接通过，不需要任何时间校验（哪怕输入框里留着过去的文本）', () => {
    expect(
      resolveDeadlineDraft({
        isNew: false,
        hasDeadline: false,
        dirty: false,
        originalDeadline: YESTERDAY,
        inputValue: toInputValue(YESTERDAY),
        now: NOW,
      }),
    ).toEqual({ ok: true, deadline: null });
  });

  it('输入框空串 / 无法解析 → 报「请选择截止时间」而不是「必须晚于现在」', () => {
    expect(
      resolveDeadlineDraft({
        isNew: false,
        hasDeadline: true,
        dirty: true,
        originalDeadline: null,
        inputValue: '',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('原本无期限 → 切换到「设置截止时间」必须给未来时间（此时没有原始值可沿用）', () => {
    expect(
      resolveDeadlineDraft({
        isNew: false,
        hasDeadline: true,
        dirty: false,
        originalDeadline: null,
        inputValue: toInputValue(YESTERDAY),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'past' });
  });
});

describe('端到端：逾期任务只改标题能落盘，且 deadline 不变', () => {
  const storage = installMemoryStorage();

  beforeEach(() => {
    storage.clear();
  });

  it('直接构造一条昨天到期的待办 → 只改 title 保存成功 → deadline 原值不变', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'overdue-1',
            title: '旧标题',
            content: '',
            deadline: YESTERDAY,
            advanceReminder: true,
            done: false,
            repeat: { kind: 'none' },
            createdAt: YESTERDAY - DAY_MS,
            updatedAt: YESTERDAY - DAY_MS,
          },
        ],
      }),
    );

    // 存储层本身不校验「晚于现在」（那是编辑页的 UI 规则），所以这条一定能过
    const updated = await api.updateTodo('overdue-1', { title: '新标题' });

    expect(updated.title).toBe('新标题');
    expect(updated.deadline).toBe(YESTERDAY);

    const persisted = readTodos().find((todo) => todo.id === 'overdue-1');
    expect(persisted?.title).toBe('新标题');
    expect(persisted?.deadline).toBe(YESTERDAY);
  });

  it('逾期 + 重复的待办改标题：deadline 不变，重复规则也不被顺手改掉', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'overdue-repeat',
            title: '旧标题',
            content: '',
            deadline: YESTERDAY,
            advanceReminder: false,
            done: false,
            repeat: { kind: 'daily' },
            createdAt: YESTERDAY - DAY_MS,
            updatedAt: YESTERDAY - DAY_MS,
          },
        ],
      }),
    );

    const updated = await api.updateTodo('overdue-repeat', { title: '改个名' });

    expect(updated.deadline).toBe(YESTERDAY);
    expect(updated.repeat).toEqual({ kind: 'daily' });
    expect(updated.advanceReminder).toBe(false);
  });
});

describe('源码守卫：校验不许被搬回组件里', () => {
  const editor = readFileSync(new URL('../src/components/TodoEditor.tsx', import.meta.url), 'utf8');

  it('TodoEditor 走 resolveDeadlineDraft，且自己不再写「deadline <= Date.now()」', () => {
    expect(editor).toContain('resolveDeadlineDraft(');
    // 这句话一旦回到组件里，就等于绕过 dirty 标记，逾期任务又会改不了标题
    expect(editor).not.toMatch(/deadline\s*<=\s*Date\.now\(\)/);
    expect(editor).toContain('dirty: deadlineDirty.current');
    expect(editor).toContain('isNew: todo === null');
  });
});
