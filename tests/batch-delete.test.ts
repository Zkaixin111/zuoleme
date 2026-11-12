import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import { api, readTodos } from '../src/lib/api';
import { compileAlarms } from '../src/lib/alarms';
import { installMemoryStorage } from './helpers/memory-storage';

/**
 * 长按选中 → 批量删除（需求 3）的数据链路。
 *
 * 项目没有 jsdom，点不到「长按 → 勾选 → 删」这套手势，所以这里测**它落到数据层之后
 * 真正重要的一件事**：删完之后提醒必须跟着消失。
 * 反过来说，只要 App 的批量删除走的是「逐条 deleteTodo → 全量 load → 全量重排提醒」，
 * 就不可能出现「删了待办但手机到点还响」的残留 —— 这条断言就是钉这个的。
 *
 * 另外会静态守卫 App.tsx 里批量删除的实现方式（逐条删除 + 重排），
 * 因为一旦有人为了「性能」改成只操作本地 state，提醒就会漏取消。
 */

const storage = installMemoryStorage();
const ROOT = new URL('../', import.meta.url);

/**
 * 读一份源码。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

beforeEach(() => {
  storage.clear();
});

describe('批量删除：数据与提醒同步', () => {
  it('选中两条删除后，对应提醒从编译结果里消失，剩下的待办提醒不变', async () => {
    const keep = await api.createTodo({ title: '留下的', deadline: Date.now() + 10 * DAY_MS });
    const dropA = await api.createTodo({ title: '要删的 A', deadline: Date.now() + 10 * DAY_MS });
    const dropB = await api.createTodo({ title: '要删的 B', deadline: Date.now() + 3 * DAY_MS });

    const before = compileAlarms(await api.listTodos(), Date.now());
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((alarm) => alarm.todoId === dropA.id)).toBe(true);
    expect(before.some((alarm) => alarm.todoId === dropB.id)).toBe(true);

    // 批量删除走的是同一条「逐条删除」路径（App.handleDeleteSelected）
    for (const id of [dropA.id, dropB.id]) {
      await api.deleteTodo(id);
    }
    const after = compileAlarms(await api.listTodos(), Date.now());

    expect(after.some((alarm) => alarm.todoId === dropA.id)).toBe(false);
    expect(after.some((alarm) => alarm.todoId === dropB.id)).toBe(false);
    // 没被删的那条一条提醒都不能少
    expect(after.filter((alarm) => alarm.todoId === keep.id)).toHaveLength(
      before.filter((alarm) => alarm.todoId === keep.id).length,
    );
    expect(readTodos().map((todo) => todo.id)).toEqual([keep.id]);
  });

  it('选中的待办里混着「不设时间」的也不会卡住（它本来就没有提醒）', async () => {
    const undated = await api.createTodo({ title: '无期限', deadline: null });
    const dated = await api.createTodo({ title: '有期限', deadline: Date.now() + HOUR_MS });

    expect(compileAlarms([undated], Date.now())).toHaveLength(0);

    for (const id of [undated.id, dated.id]) {
      await api.deleteTodo(id);
    }

    expect(await api.listTodos()).toHaveLength(0);
    expect(compileAlarms(await api.listTodos(), Date.now())).toHaveLength(0);
  });

  it('全选后删除 = 清空列表，提醒清零（不留孤儿闹钟）', async () => {
    await api.createTodo({ title: 'A', deadline: Date.now() + DAY_MS });
    await api.createTodo({ title: 'B', deadline: Date.now() + 2 * DAY_MS });
    const all = await api.listTodos();

    for (const todo of all) {
      await api.deleteTodo(todo.id);
    }

    expect(await api.listTodos()).toHaveLength(0);
    expect(compileAlarms(await api.listTodos(), Date.now())).toHaveLength(0);
  });
});

describe('App 的批量删除实现（源码守卫）', () => {
  const app = readSource('src/App.tsx');

  it('逐条 deleteTodo，然后重新 load（load 里会全量重排提醒）', () => {
    expect(app).toContain('await api.deleteTodo(id);');
    expect(app).toContain('await load();');
  });

  it('删除前必须二次确认，文案里点明「提醒会一起取消」', () => {
    expect(app).toContain('这些事的提醒会一起取消');
  });

  it('删除完成后退出选择模式并清空选中集合', () => {
    expect(app).toContain('exitSelection();');
    expect(app).toContain('setSelectedIds(new Set());');
  });

  it('已选为空时直接返回（不会弹一个「删除 0 件事」的确认框）', () => {
    expect(app).toMatch(/if \(ids\.length === 0\) \{\s*return;/);
  });
});
