/**
 * 极简 IndexedDB KV：页面把 API Token 同步一份到 IDB，
 * 这样 Service Worker 在通知里点「完成」时也能调接口（SW 读不到 localStorage）。
 */

const DB_NAME = 'zuoleme';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
  });
}

/**
 * 写入一个键值。
 *
 * @param key 键
 * @param value 值（字符串）
 */
export async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('写入 IndexedDB 失败'));
  });
  db.close();
}

/**
 * 读取一个键值。
 *
 * @param key 键
 * @returns 值；不存在时返回 null
 */
export async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  const value = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const result: unknown = request.result;
      resolve(typeof result === 'string' ? result : null);
    };
    request.onerror = () => reject(request.error ?? new Error('读取 IndexedDB 失败'));
  });
  db.close();
  return value;
}
