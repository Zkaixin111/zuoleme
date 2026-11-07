import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Service Worker push 事件处理测试（重点：payload 解析失败时的降级路径）。
 *
 * 为什么这条重要：如果解析失败时选择「静默 return」，用户什么都不会收到，
 * 而且服务端已经把 reminder 标记成 sent=1 —— 这条提醒就永久消失了。
 * 本文件证明：即使 payload 完全无法解析，也一定会 showNotification。
 */

// workbox 的预缓存依赖真实 Service Worker 环境，这里整体替身掉
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  precacheAndRoute: vi.fn(),
}));

type SwListener = (event: unknown) => void;

/** 记录 showNotification 的调用（被测行为） */
const showNotification = vi.fn(async (_title: string, _options?: Record<string, unknown>) => undefined);
/** 记录 openWindow 的调用（通知点击且无已开窗口时的行为） */
const openWindow = vi.fn(async (_url?: string) => null as unknown as WindowClient);
const listeners = new Map<string, SwListener>();

const fakeSelf = {
  __WB_MANIFEST: [],
  addEventListener: (type: string, listener: SwListener): void => {
    listeners.set(type, listener);
  },
  skipWaiting: vi.fn(async () => undefined),
  registration: { showNotification },
  clients: {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => []),
    openWindow,
  },
};

/** 触发一次 push 事件并等待 waitUntil 里的 promise 完成 */
function dispatchPush(data: { text(): string } | null): Promise<unknown> {
  const listener = listeners.get('push');
  if (!listener) {
    throw new Error('sw 没有注册 push 监听器');
  }
  let pending: Promise<unknown> = Promise.resolve();
  listener({
    data,
    waitUntil: (promise: Promise<unknown>): void => {
      pending = promise;
    },
  });
  return pending;
}

/** 取最近一次 showNotification 的参数 */
function lastNotification(): { title: string; options: Record<string, unknown> } {
  const call = showNotification.mock.calls.at(-1);
  if (!call) {
    throw new Error('showNotification 从未被调用');
  }
  return { title: String(call[0]), options: (call[1] ?? {}) as Record<string, unknown> };
}

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = fakeSelf;
  await import('../src/sw');
});

describe('push 事件：正常 payload', () => {
  it('按 payload 弹出通知，tag 使用 payload.tag（不同事项/档位互不覆盖）', async () => {
    const payload = { title: '交周报', body: '还有 1 小时截止', todoId: 't1', kind: '1h', tag: 'todo:t1:1h' };

    await dispatchPush({ text: () => JSON.stringify(payload) });

    const { title, options } = lastNotification();
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(title).toBe('交周报');
    expect(options.body).toBe('还有 1 小时截止');
    expect(options.tag).toBe('todo:t1:1h');
    expect(options.data).toEqual({ todoId: 't1', kind: '1h', url: '/' });
  });

  it('产品要求「通知不自动消失」：requireInteraction 必须为 true，且带「完成」动作', async () => {
    await dispatchPush({
      text: () => JSON.stringify({ title: '交周报', body: '已到截止时间', todoId: 't1', kind: 'due', tag: 'todo:t1:due' }),
    });

    const { options } = lastNotification();
    expect(options.requireInteraction).toBe(true);
    expect(options.actions).toEqual([expect.objectContaining({ action: 'done' })]);
  });

  it('payload 缺 tag 时按 todo:<id>:<kind> 兜底，two 条不同档位不会互相覆盖', async () => {
    await dispatchPush({ text: () => JSON.stringify({ title: 'A', body: 'B', todoId: 'x', kind: '3h' }) });
    const first = lastNotification().options.tag;

    await dispatchPush({ text: () => JSON.stringify({ title: 'A', body: 'C', todoId: 'x', kind: 'due' }) });
    const second = lastNotification().options.tag;

    expect(first).toBe('todo:x:3h');
    expect(second).toBe('todo:x:due');
    expect(first).not.toBe(second);
  });
});

describe('push 事件：解析失败时的降级路径（不能静默吞掉）', () => {
  it('event.data 为 null → 仍然弹默认文案通知', async () => {
    await dispatchPush(null);

    const { title, options } = lastNotification();
    expect(title).toBe('做了么');
    expect(options.body).toBe('有一件事快到截止时间了');
    expect(options.requireInteraction).toBe(true);
  });

  it('内容是纯文本而非 JSON → 用原始文本当正文，不静默丢弃', async () => {
    await dispatchPush({ text: () => '服务器出问题了' });

    const { title, options } = lastNotification();
    expect(title).toBe('做了么');
    expect(options.body).toBe('服务器出问题了');
  });

  it('JSON 结构不完整（缺 todoId）→ 退化为原始文本，不静默丢弃', async () => {
    const broken = JSON.stringify({ title: '交周报' });
    await dispatchPush({ text: () => broken });

    const { title, options } = lastNotification();
    expect(title).toBe('做了么');
    expect(options.body).toBe(broken);
    // 此时没有 todoId，点击「完成」不会误操作任何待办
    expect(options.data).toEqual(expect.objectContaining({ todoId: '' }));
  });

  it('text() 抛异常 → 仍然弹默认文案通知', async () => {
    await dispatchPush({
      text: () => {
        throw new Error('boom');
      },
    });

    const { options } = lastNotification();
    expect(options.body).toBe('有一件事快到截止时间了');
  });
});

describe('notificationclick：没有已开窗口时打开应用', () => {
  it('带 todoId → 打开 /?todo=<id>', async () => {
    const listener = listeners.get('notificationclick');
    expect(listener).toBeTypeOf('function');
    let pending: Promise<unknown> = Promise.resolve();
    listener?.({
      action: '',
      notification: { close: vi.fn(), data: { todoId: 'abc', kind: '1h', url: '/' } },
      waitUntil: (promise: Promise<unknown>): void => {
        pending = promise;
      },
    });
    await pending;

    expect(openWindow).toHaveBeenCalledWith('/?todo=abc');
  });
});
