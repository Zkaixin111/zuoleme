import { useEffect, useState } from 'react';

/**
 * 每秒推进一次的「当前时间」hook，用于倒计时渲染。
 *
 * @param intervalMs 刷新间隔，默认 1000ms
 */
export function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}
