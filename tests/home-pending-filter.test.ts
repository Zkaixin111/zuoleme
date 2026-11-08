import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_REPEAT, type Todo } from '../shared/types';
import { groupTodos } from '../src/lib/group-todos';

/**
 * 主页只显示未完成的待办（需求 5）。
 *
 * 组件本身在项目里没有 jsdom 可渲染，所以分两层锁：
 * 1. 静态守卫 —— HomeView **在分组之前**就把 `done` 过滤掉，且渲染只走 `pending`；
 * 2. 行为兜底 —— 说明「不过滤会怎样」：`groupTodos` 会把已完成项塞进「以后」组，
 *    于是完成过的事会重新出现在待办清单里（正是用户报的那条问题）。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读一份源码。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const NOW = new Date(2026, 10, 8, 20, 0, 0, 0).getTime();
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 构造待办。
 *
 * @param id 待办 id
 * @param deadline 截止时间
 * @param done 是否已完成
 * @param completedAt 完成时刻
 */
function makeTodo(id: string, deadline: number | null, done: boolean, completedAt: number | null = null): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline,
    advanceReminder: true,
    done,
    completedAt,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
  };
}

describe('HomeView 的过滤（源码守卫）', () => {
  const home = readSource('src/components/HomeView.tsx');

  it('分组前先过滤掉已完成的待办', () => {
    expect(home).toContain('const pending = todos.filter((todo) => !todo.done);');
    expect(home).toContain('groupTodos(pending, now)');
  });

  it('渲染只走 pending（没有一处把 todos 直接铺到列表里）', () => {
    // `group.todos.map` 里的 `.todos` 是分组内的数组，这里要盯的是「组件级 todos 被直接铺开」
    expect(home).not.toMatch(/[\s{(]todos\.map\(/);
    expect(home).toContain('group.todos.map');
  });

  it('顶部计数与空状态也用 pending（否则会显示「12 件待办」却只列 8 条）', () => {
    expect(home).toContain('{pending.length} 件待办');
    expect(home).toMatch(/pending\.length === 0/);
  });

  it('历史入口显示已完成数量', () => {
    expect(home).toContain('历史任务 · {doneCount}');
  });
});

describe('行为兜底：不过滤的话已完成项会混进列表', () => {
  it('已完成的待办会被 groupTodos 放进「以后」组（所以必须过滤）', () => {
    const done = makeTodo('done', NOW + HOUR_MS, true, NOW - 1000);
    const groups = groupTodos([done], NOW);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('later');
    expect(groups[0].todos.map((todo) => todo.id)).toEqual(['done']);
  });

  it('过滤之后，同一批数据在任意分组里都找不到已完成项', () => {
    const todos = [
      makeTodo('a', NOW + HOUR_MS, false),
      makeTodo('b', null, false),
      makeTodo('c', NOW - HOUR_MS, true, NOW - 500),
      makeTodo('d', NOW + DAY_MS, true, NOW - 600),
    ];

    const groups = groupTodos(todos.filter((todo) => !todo.done), NOW);
    const visible = groups.flatMap((group) => group.todos.map((todo) => todo.id));

    expect(visible).toEqual(['a', 'b']);
    expect(visible).not.toContain('c');
    expect(visible).not.toContain('d');
  });
});

describe('HistoryView 只收已完成的待办', () => {
  const history = readSource('src/components/HistoryView.tsx');

  it('按 done 过滤后再交给 sortCompleted', () => {
    expect(history).toContain('sortCompleted(todos.filter((todo) => todo.done))');
  });

  it('空状态文案与入口一致', () => {
    expect(history).toContain('还没有完成的任务');
  });
});
