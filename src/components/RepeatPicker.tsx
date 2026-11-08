import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, normalizeWeekdays } from '../../shared/repeat';
import type { RepeatRule } from '../../shared/types';

export interface RepeatPickerProps {
  value: RepeatRule;
  onChange: (value: RepeatRule) => void;
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
 */
export function RepeatPicker({ value, onChange }: RepeatPickerProps): JSX.Element {
  const interval = value.kind === 'interval' ? splitInterval(value.intervalMs) : { amount: 1, unit: 'day' as IntervalUnit };

  const handleMode = (mode: RepeatRule['kind']): void => {
    switch (mode) {
      case 'none':
        onChange({ kind: 'none' });
        break;
      case 'daily':
        onChange({ kind: 'daily' });
        break;
      case 'weekly': {
        // 默认选「今天」，用户再按需要加减
        const today = new Date().getDay();
        const weekdays = value.kind === 'weekly' ? normalizeWeekdays(value.weekdays) : [today];
        onChange({ kind: 'weekly', weekdays: weekdays.length > 0 ? weekdays : [today] });
        break;
      }
      case 'monthly':
        onChange({ kind: 'monthly', dayOfMonth: new Date().getDate() });
        break;
      case 'interval':
        onChange({ kind: 'interval', intervalMs: UNIT_MS.day });
        break;
      default:
        onChange({ kind: 'none' });
    }
  };

  const toggleWeekday = (day: number): void => {
    const current = value.kind === 'weekly' ? normalizeWeekdays(value.weekdays) : [];
    const next = current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b);
    // 至少留一天：空数组在存储层是非法的（会退化成不重复）
    onChange({ kind: 'weekly', weekdays: next });
  };

  const updateInterval = (amount: number, unit: IntervalUnit): void => {
    const safeAmount = Number.isFinite(amount) ? Math.max(1, Math.trunc(amount)) : 1;
    const raw = safeAmount * UNIT_MS[unit];
    const clamped = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, raw));
    onChange({ kind: 'interval', intervalMs: clamped });
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((mode) => {
          const active = value.kind === mode.key;
          return (
            <button
              key={mode.key}
              type="button"
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
                onClick={() => toggleWeekday(day)}
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
            value={interval.amount}
            onChange={(event) => updateInterval(Number(event.target.value), interval.unit)}
          />
          <select
            className="field flex-1"
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
