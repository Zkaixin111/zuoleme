/**
 * 编辑页「截止时间」这一项的判定（纯函数，无 React 依赖，便于单测）。
 *
 * 为什么要单独抽出来：这条规则原先散在 `TodoEditor.handleSubmit` 里，
 * 只有「渲染组件 → 点保存」才能验证，而项目里没有 jsdom / RTL，
 * 于是「逾期任务改不了标题」这个 bug 一直没被任何测试拦住。
 * 抽成纯函数后，输入是「用户到底动没动过时间」，输出是「能不能保存、保存成什么」，
 * 可以直接对每一种组合做断言。
 *
 * 规则（顺序不能变）：
 * 1. 不设时间 → 直接通过，`deadline = null`（不需要任何时间校验）；
 * 2. **新建**永远要求「晚于现在」—— 新建时不存在「原始值」这回事；
 * 3. **编辑且没动过时间输入框** → 原样沿用原始时间戳（含秒），**不做「必须晚于现在」校验**。
 *    这是本模块存在的核心原因：一条昨天到期的待办如果只改标题，
 *    原时间当然在过去，若仍校验「必须晚于现在」，用户就永远改不了它的标题；
 * 4. 编辑且动过时间 → 按用户输入校验，必须可解析且晚于现在
 *    （用户主动把时间改到过去是没有意义的，仍然要拦）。
 */

/** 截止时间的判定结果 */
export type DeadlineDraft =
  | { readonly ok: true; readonly deadline: number | null }
  | { readonly ok: false; readonly reason: 'unparsable' | 'past' };

export interface DeadlineDraftInput {
  /** 是否新建（`todo === null`）。新建永远校验「晚于现在」 */
  readonly isNew: boolean;
  /** 用户选的是「设置截止时间」还是「不设时间」 */
  readonly hasDeadline: boolean;
  /** 用户是否真的动过时间输入框（含快捷按钮） */
  readonly dirty: boolean;
  /** 进入编辑时的原始时间戳（含秒）；新建或原本无期限时为 null */
  readonly originalDeadline: number | null;
  /** 输入框里的 `datetime-local` 文本 */
  readonly inputValue: string;
  /** 当前时间（注入以便测试，不读全局时钟） */
  readonly now: number;
}

/**
 * 决定这次保存最终提交什么截止时间。
 *
 * @param input 判定输入
 * @returns 通过时给出最终时间戳（`null` = 不设时间）；不通过时给出原因
 */
export function resolveDeadlineDraft(input: DeadlineDraftInput): DeadlineDraft {
  if (!input.hasDeadline) {
    return { ok: true, deadline: null };
  }

  // 新建、或用户动过输入框 / 原本没有时间 → 走「按输入校验」分支。
  // `!input.isNew` 这一项把「新建永远校验」写成显式规则，而不是靠
  // 「新建时 originalDeadline 恰好是 null」这个隐含前提成立。
  const untouched = !input.isNew && !input.dirty && input.originalDeadline !== null;
  if (untouched) {
    // 含秒的原值原样回去：datetime-local 只有分钟精度，
    // 直接写回输入框的值会把 37 秒抹掉（P2-4）
    return { ok: true, deadline: input.originalDeadline as number };
  }

  const parsed = new Date(input.inputValue).getTime();
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: 'unparsable' };
  }
  if (parsed <= input.now) {
    return { ok: false, reason: 'past' };
  }
  return { ok: true, deadline: parsed };
}
