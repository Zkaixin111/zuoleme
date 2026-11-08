import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../shared/reminders';
import type { Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import { compileAlarms } from '../src/lib/alarms';

/**
 * 原生桥接层测试（`src/lib/reminder-bridge.ts`）。
 *
 * 这一层是「前端算出的提醒」与「Android AlarmManager」之间唯一的通道，
 * 出错的方式都很隐蔽：字段名错一个（Kotlin 读不到 → 通知标题为空）、
 * 多传一条已过去的提醒、或者在浏览器里误调原生插件。
 * 所以这里把 `@capacitor/core` 换成可控的假实现，逐条验证**真正传给原生的东西**。
 */

interface BridgeMockState {
  /** 是否伪装成原生平台 */
  native: boolean;
  /** 每次 scheduleAll 收到的 alarms */
  scheduled: Array<Array<Record<string, unknown>>>;
  /** 置 true 时 scheduleAll 抛错 */
  fail: boolean;
  /** scheduleAll 声称排上的条数；null 表示不返回数字（走 payload.length 兜底） */
  reported: number | null;
  /** getPendingOpen 的返回值 */
  pendingOpen: string | null;
  /** 被调用的方法名记录 */
  calls: string[];
}

vi.mock('@capacitor/core', () => {
  const state: BridgeMockState = {
    native: false,
    scheduled: [],
    fail: false,
    reported: null,
    pendingOpen: null,
    calls: [],
  };

  const plugin = {
    async scheduleAll(options: { alarms: Array<Record<string, unknown>> }): Promise<unknown> {
      state.calls.push('scheduleAll');
      if (state.fail) {
        throw new Error('原生排程失败');
      }
      state.scheduled.push(options.alarms);
      return state.reported === null ? undefined : { scheduled: state.reported };
    },
    async cancelAll(): Promise<void> {
      state.calls.push('cancelAll');
    },
    async getPermissionState(): Promise<unknown> {
      state.calls.push('getPermissionState');
      return { notifications: true, exactAlarm: false, batteryOptimized: true };
    },
    async requestNotificationPermission(): Promise<unknown> {
      state.calls.push('requestNotificationPermission');
      return { notifications: true };
    },
    async openExactAlarmSettings(): Promise<void> {
      state.calls.push('openExactAlarmSettings');
    },
    async openBatterySettings(): Promise<void> {
      state.calls.push('openBatterySettings');
    },
    async openNotificationSettings(): Promise<void> {
      state.calls.push('openNotificationSettings');
    },
    async getPendingOpen(): Promise<unknown> {
      state.calls.push('getPendingOpen');
      return { todoId: state.pendingOpen };
    },
  };

  return {
    Capacitor: { isNativePlatform: (): boolean => state.native },
    registerPlugin: (): typeof plugin => plugin,
    __state: state,
  };
});

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 访问 mock 的内部状态 */
async function mockState(): Promise<BridgeMockState> {
  const core = (await import('@capacitor/core')) as unknown as { __state: BridgeMockState };
  return core.__state;
}

/**
 * 构造一条待办。
 *
 * @param id 待办 id
 * @param overrides 需要覆盖的字段
 */
function makeTodo(id: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline: NOW + 30 * DAY_MS,
    done: false,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

/** 导入被测模块（必须在 vi.mock 生效之后） */
async function loadBridge(): Promise<typeof import('../src/lib/reminder-bridge')> {
  return import('../src/lib/reminder-bridge');
}

describe('syncAlarms：浏览器环境必须完全空转', () => {
  beforeEach(async () => {
    const state = await mockState();
    state.native = false;
    state.scheduled = [];
    state.fail = false;
    state.reported = null;
    state.calls = [];
  });

  it('非原生平台不调用原生插件，返回 ok 且 scheduled=0', async () => {
    const bridge = await loadBridge();
    const state = await mockState();

    const result = await bridge.syncAlarms([makeTodo('a')], NOW);

    expect(result).toEqual({ ok: true, scheduled: 0, truncated: 0, error: null });
    expect(state.calls).toEqual([]);
    expect(bridge.isNativePlatform()).toBe(false);
  });
});

describe('syncAlarms：原生环境传给 AlarmManager 的内容', () => {
  beforeEach(async () => {
    const state = await mockState();
    state.native = true;
    state.scheduled = [];
    state.fail = false;
    state.reported = null;
    state.calls = [];
  });

  it('条数与 compileAlarms 完全一致，且只带 id/todoId/title/deadline/fireAt 五个字段', async () => {
    const todos = [makeTodo('a'), makeTodo('b', { deadline: NOW + 3 * DAY_MS })];
    const expected = compileAlarms(todos, NOW);

    const bridge = await loadBridge();
    const state = await mockState();
    const result = await bridge.syncAlarms(todos, NOW);

    expect(result).toEqual({ ok: true, scheduled: expected.length, truncated: 0, error: null });
    expect(state.scheduled).toHaveLength(1);

    const payload = state.scheduled[0];
    expect(payload).toHaveLength(expected.length);
    for (const alarm of payload) {
      // 没有 body（正文由原生现算），也没有 content（不进通知）
      expect(Object.keys(alarm).sort()).toEqual(['deadline', 'fireAt', 'id', 'title', 'todoId']);
      expect(alarm.fireAt).toBeTypeOf('number');
      expect(alarm.id).toBeTypeOf('number');
      expect(alarm.deadline).toBeTypeOf('number');
      expect(alarm.todoId).toBeTypeOf('string');
    }
    expect(payload.map((alarm) => alarm.id)).toEqual(expected.map((alarm) => alarm.id));
    expect(payload.map((alarm) => alarm.fireAt)).toEqual(expected.map((alarm) => alarm.fireAt));
    expect(payload.map((alarm) => alarm.deadline)).toEqual(expected.map((alarm) => alarm.deadline));
  });

  it('原生返回 {scheduled} 时以原生数字为准（不拿 payload.length 冒充）', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.reported = 3;

    const result = await bridge.syncAlarms([makeTodo('a')], NOW);

    expect(result.scheduled).toBe(3);
    expect(result.ok).toBe(true);
  });

  it('原生没返回数字时退回 payload.length', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.reported = null;

    const result = await bridge.syncAlarms([makeTodo('a')], NOW);

    expect(result.scheduled).toBe(compileAlarms([makeTodo('a')], NOW).length);
  });

  it('已完成的待办不会被送到系统（完成的事不许再响）', async () => {
    const bridge = await loadBridge();
    const state = await mockState();

    await bridge.syncAlarms([makeTodo('done', { done: true })], NOW);

    expect(state.scheduled[0]).toEqual([]);
  });

  it('已过去的档位不会被送到系统（不补发）', async () => {
    const bridge = await loadBridge();
    const state = await mockState();

    // 只剩 1h 与 due 两档
    await bridge.syncAlarms([makeTodo('near', { deadline: NOW + 90 * 60_000 })], NOW);

    const payload = state.scheduled[0];
    expect(payload).toHaveLength(2);
    for (const alarm of payload) {
      expect(alarm.fireAt as number).toBeGreaterThan(NOW);
    }
  });

  it('原生抛错时返回 ok:false 并给出可直接展示的中文原因（不静默吞掉）', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.fail = true;

    const result = await bridge.syncAlarms([makeTodo('a')], NOW);

    expect(result.ok).toBe(false);
    expect(result.scheduled).toBe(0);
    expect(result.error).toBe('原生排程失败');
  });
});

describe('授权状态读取的字段映射', () => {
  beforeEach(async () => {
    const state = await mockState();
    state.native = true;
    state.scheduled = [];
    state.fail = false;
    state.reported = null;
    state.calls = [];
  });

  it('batteryOptimized 语义是「仍被限制」，不能被取反两次', async () => {
    const bridge = await loadBridge();

    const snapshot = await bridge.readPermissionState();

    expect(snapshot).toEqual({
      supported: true,
      notifications: true,
      exactAlarm: false,
      batteryOptimized: true,
    });
  });

  it('非原生平台的默认状态是 supported=false（界面据此提示「仅 APK 可用」）', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.native = false;

    const snapshot = await bridge.readPermissionState();

    expect(snapshot.supported).toBe(false);
    expect(snapshot.notifications).toBe(false);
  });

  it('requestNotificationPermission 在浏览器里返回 false 且不触碰插件', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.native = false;

    expect(await bridge.requestNotificationPermission()).toBe(false);
    expect(state.calls).toEqual([]);
  });
});

describe('consumePendingOpen：点通知直达详情页', () => {
  beforeEach(async () => {
    const state = await mockState();
    state.native = true;
    state.scheduled = [];
    state.fail = false;
    state.reported = null;
    state.pendingOpen = null;
    state.calls = [];
  });

  it('有待处理点击时返回 todoId', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.pendingOpen = 'todo-42';

    expect(await bridge.consumePendingOpen()).toBe('todo-42');
    expect(state.calls).toContain('getPendingOpen');
  });

  it('没有待处理点击（null / 空串）时返回 null', async () => {
    const bridge = await loadBridge();
    const state = await mockState();

    expect(await bridge.consumePendingOpen()).toBeNull();

    state.pendingOpen = '';
    expect(await bridge.consumePendingOpen()).toBeNull();
  });

  it('浏览器环境不触碰插件', async () => {
    const bridge = await loadBridge();
    const state = await mockState();
    state.native = false;

    expect(await bridge.consumePendingOpen()).toBeNull();
    expect(state.calls).toEqual([]);
  });
});
