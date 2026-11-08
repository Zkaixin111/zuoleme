import { describe, expect, it } from 'vitest';
import {
  createLongPressTracker,
  type LongPressScheduler,
  type PointerPoint,
} from '../src/lib/long-press';

/**
 * 长按判定（需求 3）的状态机。
 *
 * 这一组用例覆盖移动端长按的三个真实陷阱：
 * 1. 短按绝不能触发（否则点一下待办就进选择模式）；
 * 2. 按下后滚动列表必须取消（阈值判定）；
 * 3. 长按触发后必须吞掉紧随其后的 `click`（否则「长按选中」立刻被「点击进编辑」覆盖）。
 *
 * 计时器是注入的：CI 里没有真实时钟，用 `ManualScheduler` 手动推进，
 * 用例因此既确定又快。
 */

/** 手动推进的计时器（替代 setTimeout） */
class ManualScheduler implements LongPressScheduler {
  private readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();
  private nextHandle = 1;
  /** 最近一次安排的延时（用来断言默认 500ms） */
  lastDelayMs = 0;
  /** 被取消的次数（用来断言「取消是真的取消了」） */
  cancelledCount = 0;

  schedule(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { callback, delayMs });
    this.lastDelayMs = delayMs;
    return handle;
  }

  cancel(handle: unknown): void {
    const key = handle as number;
    if (this.tasks.delete(key)) {
      this.cancelledCount += 1;
    }
  }

  /** 待触发的任务数 */
  get pending(): number {
    return this.tasks.size;
  }

  /** 让所有待触发任务立刻执行（模拟「时间到了」） */
  flush(): void {
    const snapshot = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of snapshot) {
      task.callback();
    }
  }
}

/**
 * 造一个「记录回调次数」的判定器。
 *
 * @param options.delayMs 覆盖按压时长
 * @param options.moveTolerance 覆盖抖动阈值
 */
function setup(options: { delayMs?: number; moveTolerance?: number } = {}): {
  scheduler: ManualScheduler;
  fires: () => number;
  tracker: ReturnType<typeof createLongPressTracker>;
} {
  const scheduler = new ManualScheduler();
  let fires = 0;
  const tracker = createLongPressTracker(() => {
    fires += 1;
  }, { ...options, scheduler });
  return { scheduler, fires: () => fires, tracker };
}

const ORIGIN: PointerPoint = { x: 100, y: 200 };

describe('useLongPress 的判定内核：短按 / 长按 / 滚动 / 吞点击', () => {
  it('短按不触发（按下 300ms 就抬手）', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerUp();
    scheduler.flush();

    expect(fires()).toBe(0);
    expect(scheduler.pending).toBe(0);
    expect(tracker.isFired()).toBe(false);
  });

  it('按住不动到时长 → 触发一次', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    expect(fires()).toBe(0);
    scheduler.flush();

    expect(fires()).toBe(1);
    expect(tracker.isFired()).toBe(true);
  });

  it('默认按压时长是 500ms', () => {
    const { scheduler, tracker } = setup();

    tracker.pointerDown(ORIGIN);

    expect(scheduler.lastDelayMs).toBe(500);
  });

  it('按下后位移超过阈值（滚动）→ 取消，计时器不会再触发', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerMove({ x: ORIGIN.x, y: ORIGIN.y + 40 });
    scheduler.flush();

    expect(fires()).toBe(0);
    expect(scheduler.cancelledCount).toBeGreaterThan(0);
    expect(scheduler.pending).toBe(0);
  });

  it('抖动在阈值内（手指没真的划走）→ 仍然触发', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerMove({ x: ORIGIN.x + 3, y: ORIGIN.y + 4 });
    scheduler.flush();

    expect(fires()).toBe(1);
  });

  it('阈值可以配置', () => {
    const { scheduler, fires, tracker } = setup({ moveTolerance: 2 });

    tracker.pointerDown(ORIGIN);
    tracker.pointerMove({ x: ORIGIN.x + 5, y: ORIGIN.y });
    scheduler.flush();

    expect(fires()).toBe(0);
  });

  it('手势被系统打断（pointercancel）→ 取消', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerCancel();
    scheduler.flush();

    expect(fires()).toBe(0);
  });

  it('触发之后吞掉一次 click，且只吞一次', () => {
    const { scheduler, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    scheduler.flush();
    tracker.pointerUp();

    expect(tracker.consumeClick()).toBe(true);
    // 第二次点击必须正常生效，否则长按之后这一行就点不开了
    expect(tracker.consumeClick()).toBe(false);
  });

  it('没触发长按时不吞 click（普通点击要能进编辑页）', () => {
    const { scheduler, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerUp();
    scheduler.flush();

    expect(tracker.consumeClick()).toBe(false);
  });

  it('滚动取消之后也不吞 click（用户可以继续正常点击）', () => {
    const { scheduler, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    tracker.pointerMove({ x: ORIGIN.x, y: ORIGIN.y + 60 });
    tracker.pointerUp();
    scheduler.flush();

    expect(tracker.consumeClick()).toBe(false);
  });

  it('上一次长按的「待吞标记」会被下一次按下复位', () => {
    const { scheduler, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    scheduler.flush();
    tracker.pointerUp();
    // 用户没点击，直接又按住下一次
    tracker.pointerDown(ORIGIN);

    expect(tracker.consumeClick()).toBe(false);
  });

  it('连续两次长按 → 回调两次（不会因为内部状态卡住只响一次）', () => {
    const { scheduler, fires, tracker } = setup();

    tracker.pointerDown(ORIGIN);
    scheduler.flush();
    tracker.pointerUp();
    tracker.consumeClick();

    tracker.pointerDown(ORIGIN);
    scheduler.flush();

    expect(fires()).toBe(2);
  });
});
