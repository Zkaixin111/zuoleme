import { useEffect, useRef } from 'react';
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, normalizeWeekdays } from '../../shared/repeat';
import type { RepeatRule } from '../../shared/types';

export interface RepeatPickerProps {
  value: RepeatRule;
  onChange: (value: RepeatRule) => void;
  /** 禁用（没有截止时间时重复规则无意义） */
  disabled?: boolean;
}

/** 分段控件的五个选项 */
const MODES: ReadonlyArray<{ key: RepeatRule['kind']; label: string }> = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'interval', label: '每隔' },
];

/** 星期单字 */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 间隔的单位 */
type IntervalUnit = 'minute' | 'hour' | 'day';

/** 单位 → 毫秒 */
const UNIT_MS: Record<IntervalUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * 把毫秒拆成「数值 + 单位」（给输入框回显用）。
 *
 * 优先用能整除的最大单位，这样「每 2 小时」不会显示成「每 120 分钟」。
 *
 * @param intervalMs 间隔毫秒
 */
function splitInterval(intervalMs: number): { amount: number; unit: IntervalUnit } {
  if (intervalMs % UNIT_MS.day === 0) {
    return { amount: intervalMs / UNIT_MS.day, unit: 'day' };
  }
  if (intervalMs % UNIT_MS.hour === 0) {
    return { amount: intervalMs / UNIT_MS.hour, unit: 'hour' };
  }
  const minutes = Math.max(1, Math.round(intervalMs / UNIT_MS.minute));
  return { amount: minutes, unit: 'minute' };
}

/**
 * 重复规则选择器。
 *
 * 五段：不重复 / 每天 / 每周 / 每月 / 每隔。
 * 选「每周」露出 7 个周几；选「每月」露出 1–31；选「每隔」露出数字 + 单位。
 * 所有取值都在 15 分钟 ~ 30 天之间被夹紧，避免产生排不出来的规则。
 *
 * 两个容易被用户骂的细节在这里处理：
 * 1. **每种类型记住上一次的选择**：「每周 → 不重复 → 每周」不该把已选的星期重置成今天；
 * 2. **不允许把周几全部取消**：空数组在存储层是非法的（会退化成「不重复」），
 *    与其让用户点半天最后被一个错误拦住，不如点掉最后一天时直接不动。
 */
export function RepeatPicker({ value, onChange, disabled = false }: RepeatPickerProps): JSX.Element {
  const interval =
    value.kind === 'interval'
      ? splitInterval(value.intervalMs)
      : { amount: 1, unit: 'day' as IntervalUnit };

  // 每种类型最后一次的合法选择（切走再切回来时恢复，而不是重置成默认值）
  const lastWeekly = useRef<number[]>([]);
  const lastMonthly = useRef<number | null>(null);
  const lastInterval = useRef<number | null>(null);

  useEffect(() => {
    if (value.kind === 'weekly') {
      const weekdays = normalizeWeekdays(value.weekdays);
      if (weekdays.length > 0) {
        lastWeekly.current = weekdays;
      }
    } else if (value.kind === 'monthly') {
      lastMonthly.current = value.dayOfMonth;
    } else if (value.kind === 'interval') {
      lastInterval.current = value.intervalMs;
    }
  }, [value]);

  const handleMode = (mode: RepeatRule['kind']): void => {
    if (disabled) {
      return;
    }
    switch (mode) {
      case 'none':
        onChange({ kind: 'none' });
        break;
      case 'daily':
        onChange({ kind: 'daily' });
        break;
      case 'weekly': {
        // 有历史选择就恢复它；第一次进来才默认「今天」
        const remembered = lastWeekly.current.length > 0 ? lastWeekly.current : [new Date().getDay()];
        onChange({ kind: 'weekly', weekdays: [...remembered] });
        break;
      }
      case 'monthly':
        onChange({ kind: 'monthly', dayOfMonth: lastMonthly.current ?? new Date().getDate() });
        break;
      case 'interval':
        onChange({ kind: 'interval', intervalMs: lastInterval.current ?? UNIT_MS.day });
        break;
      default:
        onChange({ kind: 'none' });
    }
  };

  const toggleWeekday = (day: number): void => {
    if (disabled) {
      return;
    }
    const current = value.kind === 'weekly' ? normalizeWeekdays(value.weekdays) : [];
    const selected = current.includes(day);
    if (selected && current.length === 1) {
      // 最后一天不许取消：空数组会被存储层判为非法，等于让用户白点一场
      return;
    }
    const next = selected ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b);
    onChange({ kind: 'weekly', weekdays: next });
  };

  const updateInterval = (amount: number, unit: IntervalUnit): void => {
    if (disabled) {
      return;
    }
    const safeAmount = Number.isFinite(amount) ? Math.max(1, Math.trunc(amount)) : 1;
    const raw = safeAmount * UNIT_MS[unit];
    const clamped = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, raw));
    onChange({ kind: 'interval', intervalMs: clamped });
  };

  return (
    <div className={disabled ? 'pointer-events-none opacity-40' : undefined} aria-disabled={disabled}>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((mode) => {
          const active = value.kind === mode.key;
          return (
            <button
              key={mode.key}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => handleMode(mode.key)}
              className={`rounded-control border px-3 py-2 text-[13px] ${
                active ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-soft'
              }`}
            >
              {mode.label}
            </button>
          );
        })}
      </div>

      {value.kind === 'weekly' ? (
        <div className="mt-3 flex gap-1.5">
          {WEEKDAY_LABELS.map((label, day) => {
            const active = normalizeWeekdays(value.weekdays).includes(day);
            return (
              <button
                key={label}
                type="button"
                disabled={disabled}
                onClick={() => toggleWeekday(day)}
                aria-pressed={active}
                aria-label={`周${label}`}
                className={`h-9 w-9 rounded-full border text-[13px] ${
                  active ? 'border-accent bg-accent text-white' : 'border-line-strong bg-surface text-soft'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}

      {value.kind === 'monthly' ? (
        <div className="mt-3">
          <label className="label block">
            每月几号
            <select
              className="field mt-1"
              disabled={disabled}
              value={value.dayOfMonth}
              onChange={(event) => onChange({ kind: 'monthly', dayOfMonth: Number(event.target.value) })}
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>
                  {day} 日
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            当月没有这一天时，按当月最后一天算（例如 31 日 → 2 月 28 日）。
          </p>
        </div>
      ) : null}

      {value.kind === 'interval' ? (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[13px] text-soft">每</span>
          <input
            type="number"
            min={1}
            className="field w-20 text-center"
            disabled={disabled}
            value={interval.amount}
            onChange={(event) => updateInterval(Number(event.target.value), interval.unit)}
          />
          <select
            className="field flex-1"
            disabled={disabled}
            value={interval.unit}
            onChange={(event) => updateInterval(interval.amount, event.target.value as IntervalUnit)}
          >
            <option value="minute">分钟</option>
            <option value="hour">小时</option>
            <option value="day">天</option>
          </select>
        </div>
      ) : null}

      {value.kind === 'interval' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-faint">间隔最短 15 分钟，最长 30 天。</p>
      ) : null}
    </div>
  );
}
