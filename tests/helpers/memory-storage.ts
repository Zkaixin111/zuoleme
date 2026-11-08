/**
 * Node 环境下的 `localStorage` 垫片。
 *
 * `src/lib/api.ts` 只在函数体内访问 `window.localStorage`，所以只要在调用前
 * 把它挂到 `globalThis` 上就能跑。多个测试文件都需要它，抽到这里避免三份拷贝走样。
 */
export class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/**
 * 把垫片挂到全局 `window.localStorage` 上。
 *
 * @returns 挂上去的实例（可继续 `clear()` 等）
 */
export function installMemoryStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window = { localStorage: storage };
  return storage;
}
