/**
 * `ReminderStore.kt` 解析路径的**逐行 JS 移植**（用于在 CI 里验证 P1-2 的宽容解析）。
 *
 * 为什么要有这个文件：Kotlin 侧无法在 Node 里跑单测——
 * - `~/.gradle/caches` 里没有 junit，加依赖要联网；
 * - `android.jar` 里的 `org.json` 全是 `throw new RuntimeException("Stub!")`，
 *   即使勉强跑起来，`JSONObject` 也只会抛异常。
 *
 * 所以做法是：**用同一份磁盘数据，喂给一份与 Kotlin 逐行对应的 JS 实现**，
 * 对账「旧格式能不能被读出来、字段有没有错位、legacyBody 有没有透传」。
 * 这份移植不是被测代码，它和 Kotlin 的一致性由
 * `tests/legacy-alarm-parse.test.ts` 里的静态断言（字段名、键名、分支顺序）保证：
 * 一旦 Kotlin 侧改了形状而这里忘了跟，静态断言会红。
 *
 * 移植时**刻意保留了 org.json 的宽松语义**（`optXxx` 遇缺失/类型不符时返回 fallback），
 * 因为真实行为正是由这些语义决定的；换成「严格 JSON.parse」会掩盖掉真实差异。
 */

/** 与 `ReminderStore.FORMAT_VERSION` 对应 */
export const FORMAT_VERSION = 2;

/** 与 `ReminderStore.DEFAULT_TITLE` / `AlarmReceiver.DEFAULT_TITLE` 对应 */
export const DEFAULT_TITLE = '做了么';

/** 与 Kotlin `AlarmRecord` 一一对应（多出来的 `legacyBody` 不跨 JS 桥） */
export interface AlarmRecord {
  id: number;
  todoId: string;
  title: string;
  deadline: number;
  fireAt: number;
  legacyBody: string | null;
}

/** 日志级别（对应 `Log.i` / `Log.w` / `Log.e`） */
export type LogLevel = 'info' | 'warn' | 'error';

/** 一条被记录的日志 */
export interface LogEntry {
  level: LogLevel;
  message: string;
}

/** `SharedPreferences` 的一次快照，字段与 Kotlin 里读的键一一对应 */
export interface PrefsSnapshot {
  /** `alarms_version`；旧版本根本没写过这个键，读出来是 0 */
  version: number;
  /** `alarms` 的原始字符串；null 表示没有这个键 */
  alarms: string | null;
}

/** 与 Kotlin `LoadResult` 对应 */
export interface LoadResult {
  records: AlarmRecord[];
  dropped: number;
}

/**
 * `JSONObject.optInt(name, fallback)` / `optLong(name, fallback)` 的等价实现。
 *
 * org.json 的语义：键不存在、或值无法转成该数值类型 → 返回 fallback；
 * 数字与**数字字符串**都能转。
 *
 * @param item 单条 JSON 对象
 * @param key 键名
 * @param fallback 兜底值
 */
function optNumber(item: Record<string, unknown>, key: string, fallback: number): number {
  if (!Object.prototype.hasOwnProperty.call(item, key)) {
    return fallback;
  }
  const value = item[key];
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}

/**
 * `JSONObject.optString(name, fallback)` 的等价实现。
 *
 * 键不存在或值为 null → fallback；其余情况取 `toString()`。
 *
 * @param item 单条 JSON 对象
 * @param key 键名
 * @param fallback 兜底值
 */
function optString(item: Record<string, unknown>, key: string, fallback: string): string {
  if (!Object.prototype.hasOwnProperty.call(item, key)) {
    return fallback;
  }
  const value = item[key];
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

/**
 * 解析单条提醒记录（对应 Kotlin `ReminderStore.parseRecord`）。
 *
 * v2 形状：`{id, todoId, title, deadline, fireAt}`。
 * 旧格式：`{id, title, body, fireAt}` —— 有 `body`，没有 `todoId` / `deadline`。
 *
 * @param item 单条 JSON
 * @returns 解析结果；非法条目返回 null
 */
export function parseRecord(item: Record<string, unknown>): AlarmRecord | null {
  const id = optNumber(item, 'id', 0);
  const fireAt = optNumber(item, 'fireAt', 0);
  if (id <= 0 || fireAt <= 0) {
    return null;
  }
  const rawTitle = optString(item, 'title', '');
  const title = rawTitle === '' ? DEFAULT_TITLE : rawTitle;
  const todoId = optString(item, 'todoId', '');
  // v2 记录才有 deadline；旧格式没有，保持 0 表示「不知道」
  const deadline = optNumber(item, 'deadline', 0);
  // 旧格式的已算好正文；新记录不会有这个键
  const rawBody = optString(item, 'body', '');
  const legacyBody = rawBody === '' ? null : rawBody;

  return { id, todoId, title, deadline, fireAt, legacyBody };
}

/**
 * 读取磁盘上的提醒列表（对应 Kotlin `ReminderStore.loadWithStats`）。
 *
 * 分支顺序必须与 Kotlin 完全一致：
 * 1. `version > FORMAT_VERSION` → 记 error 日志、返回空；
 * 2. `1 <= version < FORMAT_VERSION` → 记 info 日志，**继续**按宽容模式解析；
 * 3. 没有 `alarms` 键或空串 → 空；
 * 4. 整体 JSON 解析失败 → 记 error 日志、返回空；
 * 5. 逐条解析，单条失败只丢那一条；若「有数据但一条都没解析出来」→ 记 error 日志。
 *
 * @param prefs 磁盘快照
 * @param logs 日志收集数组（会被就地追加）
 */
export function loadWithStats(prefs: PrefsSnapshot, logs: LogEntry[]): LoadResult {
  if (prefs.version > FORMAT_VERSION) {
    logs.push({
      level: 'error',
      message: `存盘格式版本 ${prefs.version} 高于本版本 ${FORMAT_VERSION}，本次无法解析（提醒会缺失）`,
    });
    return { records: [], dropped: 0 };
  }
  if (prefs.version >= 1 && prefs.version < FORMAT_VERSION) {
    logs.push({ level: 'info', message: `读到旧格式提醒记录（v${prefs.version}），按宽容模式解析` });
  }

  const raw = prefs.alarms;
  if (raw === null || raw === '') {
    return { records: [], dropped: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // 对应 `JSONArray(raw)` 抛 JSONException（内容是一个对象而不是数组）
      throw new Error('不是数组');
    }
  } catch (error) {
    logs.push({ level: 'error', message: '读取本地提醒记录失败，按空列表处理' });
    return { records: [], dropped: 0 };
  }

  const records: AlarmRecord[] = [];
  let dropped = 0;
  for (const entry of parsed as unknown[]) {
    // 对应 `array.optJSONObject(index)`：不是对象就是 null
    const item =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null;
    const record = item === null ? null : parseRecord(item);
    if (record === null) {
      dropped += 1;
      continue;
    }
    records.push(record);
  }
  if (records.length === 0 && dropped > 0) {
    logs.push({ level: 'error', message: `存盘里有 ${dropped} 条提醒记录，但一条都没能解析（格式可能已变）` });
  }
  return { records, dropped };
}

/**
 * 覆盖写入提醒列表（对应 Kotlin `ReminderStore.save`）。
 *
 * 永远写 v2 形状；`legacyBody` 非空时额外写回 `body` 键（这就是「旧记录救回来之后再开机还在」的保证）。
 *
 * @param records 待保存的提醒
 */
export function save(records: readonly AlarmRecord[]): PrefsSnapshot {
  const array = records.map((alarm) => {
    const item: Record<string, unknown> = {
      id: alarm.id,
      todoId: alarm.todoId,
      title: alarm.title,
      deadline: alarm.deadline,
      fireAt: alarm.fireAt,
    };
    if (alarm.legacyBody !== null) {
      item.body = alarm.legacyBody;
    }
    return item;
  });
  return { version: FORMAT_VERSION, alarms: JSON.stringify(array) };
}

/**
 * 取某条提醒在旧格式里保存的、已经算好的正文（对应 Kotlin `ReminderStore.findLegacyBody`）。
 *
 * @param prefs 磁盘快照
 * @param alarmId 提醒 id
 */
export function findLegacyBody(prefs: PrefsSnapshot, alarmId: number): string | null {
  const { records } = loadWithStats(prefs, []);
  return records.find((record) => record.id === alarmId)?.legacyBody ?? null;
}
