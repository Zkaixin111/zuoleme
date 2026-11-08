import type { ReactNode } from 'react';

export interface CollapsibleSectionProps {
  /** 左侧标题（`text-[13px] text-soft`） */
  title: string;
  /** 右侧当前值摘要（收起时也能一眼看到当前选的是什么） */
  summary: string;
  /** 是否展开（受控） */
  open: boolean;
  /** 点整行切换（受控组件的回调） */
  onToggle: () => void;
  /** 该区块当前不可用（例如「不设时间」时的「重复」）：显示摘要但点不开 */
  disabled?: boolean;
  /** `aria-controls` 指向的内容区 id（同页面必须唯一） */
  sectionId: string;
  /** 展开时渲染的内容 */
  children: ReactNode;
}

/**
 * 可折叠表单区块（编辑页的「截止时间 / 重复 / 提前提醒」共用）。
 *
 * 为什么做成受控组件、而不是自己 `useState` 管开合：
 * 开合状态要和「新建 / 编辑」的默认展开策略、以及「切成不设时间就收起重复」这些规则联动，
 * 状态必须留在 `TodoEditor` 顶层 —— 否则区块一卸载，谁也管不住它。
 *
 * **收起时 `children` 直接不渲染**（不是 `hidden`）：编辑页本来就长，不渲染才能真的变短。
 * 语义上这是安全的，因为**所有表单状态都在 `TodoEditor` 顶层**，
 * 控件卸载只是「不显示」，不会丢值 —— 提交时读的是 state，不是 DOM。
 *
 * 视觉上刻意不套卡片：编辑页已经是一整列，区块之间只要一条 `border-t border-line` 的分隔线。
 */
export function CollapsibleSection({
  title,
  summary,
  open,
  onToggle,
  disabled = false,
  sectionId,
  children,
}: CollapsibleSectionProps): JSX.Element {
  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={sectionId}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={onToggle}
        className={`flex h-11 w-full items-center justify-between gap-3 text-left ${disabled ? 'opacity-40' : ''}`}
      >
        <span className="text-[13px] text-soft">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] text-ink">{summary}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open ? (
        <div id={sectionId} className="pb-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
