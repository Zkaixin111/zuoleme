/**
 * 长按判定（纯状态机，无 React / 无 DOM，便于单测）。
 *
 * 为什么不用 `onContextMenu` 或 `touchstart + setTimeout` 直接写在组件里：
 * 移动端长按有三个必须处理的细节，任何一个漏掉都会让「长按选中」变成灾难：
 * 1. **滚动时不能误触发**：手指按下后开始滚动（`pointermove` 位移超过阈值）必须取消计时，
 *    否则用户每次滚动列表都会莫名其妙进入选择模式；
 * 2. **触发之后要吞掉紧随其后的 click**：浏览器在长按抬手后通常还会派发一次 `click`，
 *    不吞掉的话「长按进入选择」会立刻被「点击进入编辑」覆盖，等于长按无效；
 * 3. **计时器要能被外部注入**：CI 里没有真实时钟，`setTimeout` 注入成手动触发才能测。
 *
 * 把它写成与框架无关的状态机，`useLongPress` 只是薄薄一层事件绑定，
 * 这样上面三条都能直接断言。
 */

/** 长按判定的一次指针坐标 */
export interface PointerPoint {
  x: number;
  y: number;
}

/** 可注入的计时器（默认用全局 `setTimeout` / `clearTimeout`） */
export interface LongPressScheduler {
  /** 安排一次回调，返回可用于取消的句柄 */
  schedule: (callback: () => void, delayMs: number) => unknown;
  /** 取消安排 */
  cancel: (handle: unknown) => void;
}

export interface LongPressOptions {
  /** 判定为长按的按压时长，默认 500ms */
  delayMs?: number;
  /** 允许的手指抖动半径（像素），超过就取消，默认 10px */
  moveTolerance?: number;
  /** 计时器实现，测试可替换 */
  scheduler?: LongPressScheduler;
}

export interface LongPressTracker {
  /** 手指按下（记录起点并开始计时） */
  pointerDown: (point: PointerPoint) => void;
  /** 手指移动（超过抖动半径则取消） */
  pointerMove: (point: PointerPoint) => void;
  /** 手指抬起（未到时长则取消） */
  pointerUp: () => void;
  /** 手势被打断（来电、系统手势等） */
  pointerCancel: () => void;
  /**
   * 是否应该吞掉这一次 `click`。
   *
   * 长按触发后调用一次返回 `true` 并复位；之后返回 `false`。
   */
  consumeClick: () => boolean;
  /** 当前是否已经触发过长按（调试 / 断言用） */
  isFired: () => boolean;
}

/** 默认计时器：包一层，避免在模块顶层直接引用 `setTimeout`（Node 与浏览器都可用） */
const defaultScheduler: LongPressScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 创建一个长按判定器。
 *
 * @param onLongPress 判定成立时执行的回调
 * @param options 时长 / 抖动阈值 / 计时器
 */
export function createLongPressTracker(
  onLongPress: () => void,
  options: LongPressOptions = {},
): LongPressTracker {
  const delayMs = options.delayMs ?? 500;
  const moveTolerance = options.moveTolerance ?? 10;
  const scheduler = options.scheduler ?? defaultScheduler;

  let handle: unknown = null;
  let origin: PointerPoint | null = null;
  let fired = false;

  /**
   * 停止计时（不清 `fired`）。
   */
  const stopTimer = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    origin = null;
  };

  const pointerDown = (point: PointerPoint): void => {
    stopTimer();
    fired = false;
    origin = { x: point.x, y: point.y };
    handle = scheduler.schedule(() => {
      handle = null;
      fired = true;
      onLongPress();
    }, delayMs);
  };

  const pointerMove = (point: PointerPoint): void => {
    if (origin === null) {
      return;
    }
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    // 位移超过阈值 = 用户在滚动 / 拖动，不是长按
    if (Math.hypot(dx, dy) > moveTolerance) {
      stopTimer();
    }
  };

  return {
    pointerDown,
    pointerMove,
    pointerUp: stopTimer,
    pointerCancel: stopTimer,
    consumeClick: (): boolean => {
      if (!fired) {
        return false;
      }
      // 只吞一次：否则长按之后用户再点同一行会一直没反应
      fired = false;
      return true;
    },
    isFired: (): boolean => fired,
  };
}
