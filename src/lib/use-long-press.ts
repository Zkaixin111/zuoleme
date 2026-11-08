import { useCallback, useMemo, useRef } from 'react';
import type { PointerPoint } from './long-press';
import { createLongPressTracker } from './long-press';

/** 长按需要绑到元素上的事件处理器 */
export interface LongPressHandlers {
  onPointerDown: (event: { clientX: number; clientY: number }) => void;
  onPointerMove: (event: { clientX: number; clientY: number }) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
}

export interface UseLongPressResult {
  /** 展开到元素上 */
  handlers: LongPressHandlers;
  /** 在 `onClick` 开头调用：长按刚触发过就返回 true，调用方应立即 return */
  consumeClick: () => boolean;
}

/**
 * 长按手势 hook（判定逻辑全部在 `long-press.ts` 的纯状态机里）。
 *
 * 用法：
 * ```tsx
 * const press = useLongPress(() => enterSelection(todo.id));
 * <button {...press.handlers} onClick={() => {
 *   if (press.consumeClick()) return;
 *   open(todo);
 * }} />
 * ```
 *
 * @param onLongPress 长按成立时的回调
 * @param delayMs 按压时长，默认 500ms
 */
export function useLongPress(onLongPress: () => void, delayMs = 500): UseLongPressResult {
  // 回调用 ref 兜住：父组件每次渲染都会传新的箭头函数，直接进 useMemo 依赖会让判定器重建、
  // 正在计时的按压就丢了（表现为「长按有时候没反应」）
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const tracker = useMemo(
    () => createLongPressTracker(() => callback.current(), { delayMs }),
    [delayMs],
  );

  const point = (event: { clientX: number; clientY: number }): PointerPoint => ({
    x: event.clientX,
    y: event.clientY,
  });

  const onPointerDown = useCallback(
    (event: { clientX: number; clientY: number }) => tracker.pointerDown(point(event)),
    [tracker],
  );
  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => tracker.pointerMove(point(event)),
    [tracker],
  );
  const onPointerUp = useCallback(() => tracker.pointerUp(), [tracker]);
  const onPointerCancel = useCallback(() => tracker.pointerCancel(), [tracker]);
  const onPointerLeave = useCallback(() => tracker.pointerCancel(), [tracker]);
  const consumeClick = useCallback(() => tracker.consumeClick(), [tracker]);

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave },
    consumeClick,
  };
}
