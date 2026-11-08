import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LogEntry, PrefsSnapshot } from './helpers/reminder-store-mirror';
import {
  DEFAULT_TITLE,
  FORMAT_VERSION,
  findLegacyBody,
  loadWithStats,
  parseRecord,
  save,
} from './helpers/reminder-store-mirror';

/**
 * P1-2 回归测试：**覆盖安装之后旧提醒必须还能响**。
 *
 * 事故现场（QA 实测）：旧版本存的提醒是 `{id, title, body, fireAt}`，
 * 新版本 `load()` 一看到 `version != FORMAT_VERSION` 就 `return emptyList()`。
 * 而覆盖安装时系统会清掉所有 AlarmManager 闹钟，紧接着 `MY_PACKAGE_REPLACED`
 * 把 `BootReceiver` 叫起来 → 读盘 → 读到空 → **一条提醒都不响，且没有任何日志**。
 * 用户不主动打开应用就永远发现不了。
 *
 * 验证方式（Kotlin 侧无法在 CI 里跑，见 `tests/helpers/reminder-store-mirror.ts` 的说明）：
 * 1. **行为层**：用 `tests/fixtures/*.json` 这份「真实的旧磁盘数据」喂给逐行 JS 移植的解析器；
 * 2. **契约层**：对 Kotlin 源码做静态断言，保证移植没有跑偏、且被改掉的坏分支不会悄悄回来。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读取仓库内的源码文件。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

/**
 * 读取磁盘 fixture（内容是 `SharedPreferences.getString("alarms")` 的**原文**）。
 *
 * @param name 文件名
 */
function readFixture(name: string): string {
  return readFileSync(new URL(`tests/fixtures/${name}`, ROOT), 'utf8');
}

const KOTLIN_DIR = 'android/app/src/main/java/com/zkaixin/zuoleme/';
const STORE = readSource(`${KOTLIN_DIR}ReminderStore.kt`);
const RECEIVER = readSource(`${KOTLIN_DIR}AlarmReceiver.kt`);
const NOTIFIER = readSource(`${KOTLIN_DIR}ReminderNotifier.kt`);
const PLUGIN = readSource(`${KOTLIN_DIR}ReminderAlarmPlugin.kt`);
const BOOT = readSource(`${KOTLIN_DIR}BootReceiver.kt`);
const BRIDGE = readSource('src/lib/reminder-bridge.ts');

/** 旧格式磁盘数据（4 条，带 `body`，没有 `todoId` / `deadline`；旧版本不写 `alarms_version`） */
const LEGACY_RAW = readFixture('legacy-alarms.json');

/** 新旧混装的磁盘数据（4 条旧 + 2 条新，`alarms_version` 已经是 2） */
const MIXED_RAW = readFixture('mixed-alarms.json');

/**
 * 构造一份磁盘快照。
 *
 * @param version `alarms_version` 的值
 * @param alarms `alarms` 的原始字符串
 */
function prefs(version: number, alarms: string | null): PrefsSnapshot {
  return { version, alarms };
}

/**
 * 收日志的小工具：跑一次 load 并把日志一起取回来。
 *
 * @param snapshot 磁盘快照
 */
function load(snapshot: PrefsSnapshot): { result: ReturnType<typeof loadWithStats>; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  return { result: loadWithStats(snapshot, logs), logs };
}

/**
 * Kotlin `ReminderNotifier.durationText` 的移植（只为算「反事实」文案）。
 *
 * @param remainingMs 剩余毫秒
 */
function durationText(remainingMs: number): string {
  const totalMinutes = Math.trunc(remainingMs / 60_000);
  if (totalMinutes < 1) {
    return '不到1分钟';
  }
  const days = Math.trunc(totalMinutes / 1_440);
  const minutesAfterDays = totalMinutes % 1_440;
  const hours = Math.trunc(minutesAfterDays / 60);
  const minutes = minutesAfterDays % 60;
  if (days > 0 && hours > 0) {
    return `${days}天${hours}小时`;
  }
  if (days > 0) {
    return `${days}天`;
  }
  if (hours > 0 && minutes > 0) {
    return `${hours}小时${minutes}分钟`;
  }
  if (hours > 0) {
    return `${hours}小时`;
  }
  return `${minutes}分钟`;
}

/**
 * Kotlin `ReminderNotifier.remainingText` 的移植。
 *
 * @param remainingMs 剩余毫秒
 */
function remainingText(remainingMs: number): string {
  if (remainingMs > 0) {
    return `还有${durationText(remainingMs)}截止`;
  }
  const overdue = -remainingMs;
  return overdue >= 60_000 ? `已逾期 ${durationText(overdue)}` : '刚刚到点';
}

/**
 * `AlarmReceiver.onReceive` 里「正文怎么来」的那三行的移植。
 *
 * @param deadline 记录里的 deadline（旧记录为 0）
 * @param now 当前时间
 * @param legacyBody 旧记录里已经算好的正文
 */
function receiverBody(deadline: number, now: number, legacyBody: string | null): string {
  const remaining = deadline > 0 ? deadline - now : 0;
  const legacy = deadline > 0 ? null : legacyBody;
  return legacy ?? remainingText(remaining);
}

describe('P1-2 旧格式磁盘数据：宽容解析，一条都不许丢', () => {
  it('旧版本根本没写 alarms_version（读到 0）：4 条全部读出来，字段不错位', () => {
    const { result, logs } = load(prefs(0, LEGACY_RAW));

    expect(result.records).toHaveLength(4);
    expect(result.dropped).toBe(0);
    // 旧记录没有 error 级日志——它本来就是能读的
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);

    // fireAt 是排程时刻的唯一依据，一个字节都不能变
    expect(result.records.map((record) => record.fireAt)).toEqual([
      1767225600000, 1767229200000, 1767571200000, 1767916800000,
    ]);
    expect(result.records.map((record) => record.id)).toEqual([100101, 100102, 100103, 100104]);
    // 旧格式里已经算好的正文必须原样带进 legacyBody（通知正文就用它）
    expect(result.records.map((record) => record.legacyBody)).toEqual([
      '还有 1 小时截止',
      '已到截止时间',
      '还有 3 天截止',
      '还有 7 天截止',
    ]);
    // 旧格式没有这两个字段：deadline 保持 0（表示「不知道」），todoId 为空串
    for (const record of result.records) {
      expect(record.deadline).toBe(0);
      expect(record.todoId).toBe('');
    }
  });

  it('旧记录 title 为空串时给出兜底标题（否则通知横幅上什么都没有）', () => {
    const { result } = load(prefs(0, LEGACY_RAW));
    expect(result.records[3].title).toBe(DEFAULT_TITLE);
    expect(result.records[0].title).toBe('交房租');
  });

  it('v1（写的是 1，不是 0）：仍然照常解析，只多一行 info 日志', () => {
    const { result, logs } = load(prefs(1, LEGACY_RAW));

    expect(result.records).toHaveLength(4);
    expect(logs).toContainEqual({ level: 'info', message: '读到旧格式提醒记录（v1），按宽容模式解析' });
  });

  it('新旧混装（version 已是 2）：6 条一起读出来，旧记录保留 legacyBody、新记录不伪造', () => {
    const { result } = load(prefs(FORMAT_VERSION, MIXED_RAW));

    expect(result.records).toHaveLength(6);
    expect(result.dropped).toBe(0);

    const legacy = result.records.slice(0, 4);
    for (const record of legacy) {
      expect(record.legacyBody).not.toBeNull();
      expect(record.deadline).toBe(0);
    }

    const fresh = result.records.slice(4);
    expect(fresh.map((record) => record.todoId)).toEqual(['t-9f2c', 't-9f2c']);
    expect(fresh.map((record) => record.deadline)).toEqual([1768000000000, 1768000000000]);
    expect(fresh.map((record) => record.fireAt)).toEqual([1767971200000, 1768000000000]);
    // 新记录绝不能凭空带上 legacyBody，否则 24 小时后的补发会一直说那句旧文案
    expect(fresh.map((record) => record.legacyBody)).toEqual([null, null]);
  });

  it('未来版本（3 > 2）：明确放弃并留下 ERROR 日志（这时的空列表是有意的，不是 bug）', () => {
    const { result, logs } = load(prefs(3, MIXED_RAW));

    expect(result.records).toEqual([]);
    expect(logs.filter((entry) => entry.level === 'error')).toHaveLength(1);
    expect(logs[0].message).toContain('高于本版本');
  });

  it('磁盘上有数据但一条都解析不出来：dropped 如实计数 + ERROR 日志（界面据此弹琥珀色横幅）', () => {
    // 全部缺 fireAt：这是「格式又变了」的典型症状
    const broken = JSON.stringify([{ id: 1, title: 'a', body: 'b' }, { id: 2, title: 'c' }, {}, [1, 2]]);
    const { result, logs } = load(prefs(FORMAT_VERSION, broken));

    expect(result.records).toEqual([]);
    expect(result.dropped).toBe(4);
    const errors = logs.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('一条都没能解析');
  });

  it('单条坏记录只丢那一条，绝不让整张表一起消失', () => {
    const mixed = JSON.parse(MIXED_RAW) as Record<string, unknown>[];
    mixed.splice(2, 0, { id: 0, title: '坏记录', fireAt: 1767571200000 });
    const { result } = load(prefs(FORMAT_VERSION, JSON.stringify(mixed)));

    expect(result.records).toHaveLength(6);
    expect(result.dropped).toBe(1);
    expect(result.records.map((record) => record.id)).not.toContain(0);
  });

  it('alarms 是一个对象（不是数组）：当作读盘失败，返回空且不抛异常', () => {
    const { result, logs } = load(prefs(FORMAT_VERSION, '{"id":1}'));

    expect(result.records).toEqual([]);
    expect(logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('没有 alarms 键 / 空串：静默返回空（不是异常，也不该报警）', () => {
    expect(load(prefs(0, null)).result).toEqual({ records: [], dropped: 0 });
    expect(load(prefs(FORMAT_VERSION, '')).result).toEqual({ records: [], dropped: 0 });
    expect(load(prefs(0, null)).logs).toEqual([]);
  });

  it('save 之后重新读：旧记录的 legacyBody 仍然在（重启/开机重建不会退回现算口径）', () => {
    const { result } = load(prefs(0, LEGACY_RAW));
    const written = save(result.records);

    expect(written.version).toBe(FORMAT_VERSION);

    const { result: reread } = load(written);
    expect(reread.records).toHaveLength(4);
    expect(reread.dropped).toBe(0);
    expect(reread.records.map((record) => record.legacyBody)).toEqual(
      result.records.map((record) => record.legacyBody),
    );
    expect(reread.records.map((record) => record.fireAt)).toEqual(
      result.records.map((record) => record.fireAt),
    );
  });

  /**
   * 主守卫：**同一份 fixture 往返一次，存盘再读回来不退化**。
   *
   * 为什么必须用行为测试而不是源码正则：正则只能证明「源码里有
   * `alarm.legacyBody?.let { item.put("body", it) }` 这行」，
   * 证明不了「跑起来真的保住了」——而这正是 P1-2 这类事故的形态：
   * 代码看起来该做的都做了，实际数据在某个环节丢了，用户只看到文案变成「已逾期 56 年」。
   *
   * 尤其关键的是 mixed 这一份：旧记录被 `save()` 之后，磁盘上是
   * 「v2 形状 + 多一个 body 键」（`todoId`/`deadline` 都写了），
   * 所以下次 `load()` 必须在**同一个解析函数**里继续读 `body`，
   * 否则 legacyBody 在第一次存盘后就丢了。
   */
  it('mixed fixture 往返：load → save → load，6 条全在且旧记录的 legacyBody 一字不差', () => {
    const first = load(prefs(FORMAT_VERSION, MIXED_RAW));
    expect(first.result.records).toHaveLength(6);

    const written = save(first.result.records);
    expect(written.version).toBe(FORMAT_VERSION);

    const second = load(written);

    // 条数不变：不能因为一次存盘就少了几条
    expect(second.result.records).toHaveLength(6);
    expect(second.result.dropped).toBe(0);

    // 4 条旧记录：legacyBody 与第一次完全一致（这就是「正文不会退回现算口径」的保证）
    expect(second.result.records.slice(0, 4).map((record) => record.legacyBody)).toEqual(
      first.result.records.slice(0, 4).map((record) => record.legacyBody),
    );
    expect(second.result.records.slice(0, 4).map((record) => record.legacyBody)).toEqual([
      '还有 1 小时截止',
      '已到截止时间',
      '还有 3 天截止',
      '还有 7 天截止',
    ]);
    // 旧记录的 deadline 仍是 0（不知道），所以 AlarmReceiver 只能靠 legacyBody，不能拿 0 去算
    expect(second.result.records.slice(0, 4).map((record) => record.deadline)).toEqual([0, 0, 0, 0]);

    // 2 条新记录：往返之后仍然是新记录（不会莫名其妙长出 legacyBody）
    expect(second.result.records.slice(4).map((record) => record.legacyBody)).toEqual([null, null]);
    expect(second.result.records.slice(4).map((record) => record.todoId)).toEqual(['t-9f2c', 't-9f2c']);
    expect(second.result.records.slice(4).map((record) => record.deadline)).toEqual([
      1768000000000, 1768000000000,
    ]);

    // fireAt 是排程的唯一依据，往返一次一个字节都不许变
    expect(second.result.records.map((record) => record.fireAt)).toEqual(
      first.result.records.map((record) => record.fireAt),
    );

    // 再往返第二次（开机 → 排程 → 又开机），保证不是「只能扛一次」
    const third = load(save(second.result.records));
    expect(third.result.records).toEqual(second.result.records);
  });

  it('新记录 save 时不写 body 键（否则会被下一版误判成旧格式）', () => {
    const fresh = {
      id: 300301,
      todoId: 't-new',
      title: '体检',
      deadline: 1768000000000,
      fireAt: 1768000000000,
      legacyBody: null,
    };
    const parsed = JSON.parse(save([fresh]).alarms ?? '[]') as Record<string, unknown>[];

    expect(Object.keys(parsed[0]).sort()).toEqual(['deadline', 'fireAt', 'id', 'title', 'todoId']);
  });

  it('findLegacyBody 能按 id 取回旧正文，取不到时给 null', () => {
    expect(findLegacyBody(prefs(0, LEGACY_RAW), 100103)).toBe('还有 3 天截止');
    expect(findLegacyBody(prefs(0, LEGACY_RAW), 999999)).toBeNull();
    // 新记录的 legacyBody 本身是 null
    expect(findLegacyBody(prefs(FORMAT_VERSION, MIXED_RAW), 200201)).toBeNull();
  });

  it('非法条目（id 或 fireAt ≤ 0）不会被排进系统（宁可不响也不排错时间）', () => {
    expect(parseRecord({ id: 0, title: 'a', fireAt: 1 })).toBeNull();
    expect(parseRecord({ id: 5, title: 'a', fireAt: 0 })).toBeNull();
    expect(parseRecord({ id: 5, title: 'a' })).toBeNull();
    expect(parseRecord({ id: 5, fireAt: 1 })).not.toBeNull();
  });
});

describe('P1-2 AlarmReceiver：旧记录绝不能拿 deadline=0 去算剩余时间', () => {
  /** 一个「2026 年」的当前时刻（旧记录是 2026 年 1 月排的） */
  const NOW = new Date(2026, 5, 1, 9, 0, 0, 0).getTime();

  it('deadline 为 0 且有 legacyBody 时，正文用旧正文', () => {
    expect(receiverBody(0, NOW, '还有 1 小时截止')).toBe('还有 1 小时截止');
    expect(receiverBody(0, NOW, '已到截止时间')).toBe('已到截止时间');
  });

  it('反事实：如果照旧算法算 0 - now，会得到「已逾期两万多天」这种荒谬文案', () => {
    const absurd = remainingText(0 - NOW);
    // 0 - 2026-06-01 ≈ -56.9 年 → 「已逾期 20757天…」，正是 QA 说的「已逾期 56 年」
    expect(absurd).toMatch(/^已逾期 \d{5}天/);
    // 而正确实现永远走不到这条路
    expect(receiverBody(0, NOW, '还有 1 小时截止')).not.toBe(absurd);
  });

  it('v2 记录（deadline > 0）不受影响：仍然现算剩余时间', () => {
    const deadline = NOW + 40 * 60_000;
    expect(receiverBody(deadline, NOW, null)).toBe('还有40分钟截止');
    // 就算记录里意外带了 legacyBody，v2 记录也一律现算（否则补发文案会失真）
    expect(receiverBody(deadline, NOW, '还有 1 小时截止')).toBe('还有40分钟截止');
    expect(receiverBody(NOW - 90_000, NOW, null)).toBe('已逾期 1分钟');
    expect(receiverBody(NOW - 30_000, NOW, null)).toBe('刚刚到点');
  });
});

describe('P1-2 静态契约：Kotlin 侧的形状不许再改回去', () => {
  it('AlarmRecord 有 legacyBody: String? = null（本机内部字段，不跨 JS 桥）', () => {
    expect(STORE).toMatch(/val legacyBody: String\? = null/);
    expect(BRIDGE).not.toMatch(/legacyBody/);
  });

  it('parseRecord 同时读 v2 与旧格式的键（body 一定被读）', () => {
    expect(STORE).toMatch(/optString\("body", ""\)/);
    expect(STORE).toMatch(/optString\("todoId", ""\)/);
    expect(STORE).toMatch(/optLong\("deadline", 0L\)/);
  });

  it('save/load 对称：解析**不分版本分支**，只有一条 parseRecord 路径', () => {
    // 拆成「v2 分支 / 旧格式分支」并且只让旧分支读 body，就等于
    // 「旧记录存盘一次之后再读回来，legacyBody 丢了」→ 正文变「已逾期 56 年」
    const parseBody = STORE.slice(STORE.indexOf('private fun parseRecord'), STORE.indexOf('fun save('));
    expect(parseBody).toMatch(/optString\("body", ""\)/);
    expect(parseBody).not.toMatch(/if\s*\(\s*version/);
    // load 的循环对每一条都走同一个解析函数
    expect(STORE).toMatch(/val record = if \(item == null\) null else parseRecord\(item\)/);
  });

  it('load 不再因为版本不等于当前版本就整体丢盘（P1-2 的病灶）', () => {
    expect(STORE).not.toMatch(/version != FORMAT_VERSION/);
    // 只有「未来版本」才允许返回空
    expect(STORE).toMatch(/version > FORMAT_VERSION/);
  });

  it('两处 ERROR 日志都在：读盘异常 / 有数据但一条没解析出来', () => {
    expect(STORE).toMatch(/Log\.e\(TAG, "读取本地提醒记录失败，按空列表处理"/);
    expect(STORE).toMatch(/Log\.e\(TAG, "存盘里有 \$dropped 条提醒记录，但一条都没能解析/);
    expect(STORE).toMatch(/Log\.e\(TAG, "存盘格式版本 \$version 高于本版本/);
  });

  it('save 把 legacyBody 透传回 body 键（否则下次开机文案就回到现算口径）', () => {
    expect(STORE).toMatch(/alarm\.legacyBody\?\.let \{ item\.put\("body", it\) \}/);
  });

  it('AlarmReceiver 的 remaining 计算**必须**有 deadline > 0L 守卫（这行 JS 镜像测不出来）', () => {
    // 为什么这条只能靠源码断言：`receiverBody()` 是我们在本文件里手写的 JS 镜像，
    // 它「自带」了这个守卫。所以就算有人把 Kotlin 里这行改成 `deadline - now`（不做判空），
    // 镜像测试依然全绿——而真机上，一条 deadline=0 的旧记录会走现算分支，
    // 算出 0 - now ≈ -57 年，通知正文变成「已逾期 20757天…」。
    // 这正是 P1-2 事故的形态：逻辑正确、文本正确、但真的少了一层守卫。
    expect(RECEIVER).toMatch(
      /val remaining = if \(deadline > 0L\) deadline - System\.currentTimeMillis\(\) else 0L/,
    );
    // 不允许出现「直接相减」的写法（无论出现在哪一行）
    expect(RECEIVER).not.toMatch(/val remaining = deadline - /);
  });

  it('AlarmReceiver 先算 remaining，再取旧正文，最后才决定 body（顺序不能反）', () => {
    expect(RECEIVER).toMatch(
      /val legacyBody = if \(deadline > 0L\) null else ReminderStore\.findLegacyBody\(context, alarmId\)/,
    );
    expect(RECEIVER).toMatch(/val body = legacyBody \?\: ReminderNotifier\.remainingText\(remaining\)/);

    // 真比较先后，而不是「都出现过」——后者是假守卫（注释说检查了顺序，实际什么都没查）。
    // 先取 legacyBody 再算 remaining 是错的：`0 - now` 这时候已经执行过了。
    const remainingAt = RECEIVER.indexOf('val remaining = ');
    const legacyAt = RECEIVER.indexOf('val legacyBody = ');
    const bodyAt = RECEIVER.indexOf('val body = legacyBody');

    expect(remainingAt).toBeGreaterThan(-1);
    expect(legacyAt).toBeGreaterThan(remainingAt);
    expect(bodyAt).toBeGreaterThan(legacyAt);
  });

  it('死掉的旧分支不许回来：不再有「直接 return emptyList() 因为版本不符」的写法', () => {
    const loadBody = STORE.slice(STORE.indexOf('fun loadWithStats'), STORE.indexOf('fun parseRecord'));
    expect(loadBody).toMatch(/getString\(KEY_ALARMS, null\)/);
    // 版本检查必须早于读盘（未来版本连解析都不尝试）
    expect(loadBody.indexOf('version > FORMAT_VERSION')).toBeLessThan(loadBody.indexOf('getString(KEY_ALARMS'));
  });

  it('dropped 计数一路报到界面：LoadResult → 插件 → JS 桥 → PermissionSnapshot', () => {
    expect(STORE).toMatch(/data class LoadResult\(/);
    expect(PLUGIN).toMatch(/droppedAlarmCount/);
    expect(BRIDGE).toMatch(/droppedAlarmCount/);
  });

  it('BootReceiver 走的仍是 load → scheduleAll（宽容解析才有意义）', () => {
    expect(BOOT).toMatch(/ReminderStore\.load\(context\)/);
    expect(BOOT).toMatch(/ReminderStore\.scheduleAll\(context, alarms\)/);
  });

  it('Kotlin 剩余时间文案与 TS 一致：逾期不足 1 分钟说「刚刚到点」，否则「已逾期 X」', () => {
    expect(NOTIFIER).toMatch(/"刚刚到点"/);
    expect(NOTIFIER).toMatch(/"已逾期 \$\{durationText\(overdue\)\}"/);
  });
});
