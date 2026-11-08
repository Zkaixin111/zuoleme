import { formatDeadline } from '../../shared/format';
import { repeatLabel } from '../../shared/repeat';
import type { RepeatRule } from '../../shared/types';

/**
 * 编辑页三个折叠区块的「默认展开策略」与「头部摘要」（纯函数，便于单测）。
 *
 * 为什么抽出来：这两件事都是**规则**而不是渲染细节 ——
 * 「编辑时全收、新建时展开截止时间」是产品决策，「摘要怎么拼」必须与表单真实值同步
 * （收起后用户只能看到摘要，摘要一滞后，用户就会以为改动没生效）。
 * 放在组件里只能用源码断言钉，抽出来就能逐组合断言。
 */

/** 三个区块的 key */
export type EditorSectionKey = 'deadline' | 'repeat' | 'advance';

/** 三个区块的展开状态 */
export type EditorSectionState = Record<EditorSectionKey, boolean>;

/** 全部区块的 key（顺序无关，只用于遍历） */
export const EDITOR_SECTION_KEYS: readonly EditorSectionKey[] = ['deadline', 'repeat', 'advance'];

/**
 * 默认展开状态。
 *
 * - **编辑已有待办**：三块全收 —— 用户进来多半只是改标题或内容，不想先滚过一堆控件；
 * - **新建**：只展开「截止时间」—— 否则用户看不到系统默认给的「1 小时后」，
 *   会误以为没设置时间。
 *
 * @param isNew 是否新建
 */
export function defaultExpanded(isNew: boolean): EditorSectionState {
  return {
    deadline: isNew,
    repeat: false,
    advance: false,
  };
}

/** 摘要输入 */
export interface SectionSummaryInput {
  /** 是否设置了截止时间（false = 用户选了「不设时间」） */
  hasDeadline: boolean;
  /** `datetime-local` 输入框里的文本（可能为空串或非法） */
  deadlineInput: string;
  repeat: RepeatRule;
  advanceReminder: boolean;
  /** 当前时间（判断「今天/明天」与跨年） */
  now: number;
}

/** 三个区块的摘要文案 */
export interface SectionSummaries {
  deadline: string;
  repeat: string;
  advance: string;
}

/**
 * 生成三个区块头部的摘要。
 *
 * - 截止时间：`不设时间` / `今天 18:00`（`formatDeadline`，与列表同一套文案）；
 * - 重复：`repeatLabel(repeat)`；没有截止时间时是 `不可用`（区块此时也点不开）；
 * - 提前提醒：`已开启` / `仅到点提醒`；没有截止时间时是 `不可用`。
 *
 * @param input 表单当前值
 */
export function sectionSummaries(input: SectionSummaryInput): SectionSummaries {
  let deadlineSummary = '不设时间';
  if (input.hasDeadline) {
    const timestamp = new Date(input.deadlineInput).getTime();
    // 输入框被清空 / 手输非法值时给一个提示，而不是显示「NaN月NaN日」
    deadlineSummary = Number.isFinite(timestamp) ? formatDeadline(timestamp, input.now) : '未选择';
  }

  return {
    deadline: deadlineSummary,
    repeat: input.hasDeadline ? repeatLabel(input.repeat) : '不可用',
    advance: input.hasDeadline ? (input.advanceReminder ? '已开启' : '仅到点提醒') : '不可用',
  };
}
