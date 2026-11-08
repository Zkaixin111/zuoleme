/**
 * 视图与返回逻辑（纯函数，便于单测）。
 *
 * 为什么不引路由库：只有三个页面，一个 `useState` 就够；引 react-router 会把
 * 包体、history 语义、原生返回键三件事同时复杂化，而原生返回键恰恰**不能**依赖
 * WebView 的 history —— 见 `MainActivity.onBackPressed` 的注释。
 */

/** 当前视图（`editor` 不带 id = 新建） */
export type View =
  | { kind: 'home' }
  | { kind: 'editor'; id?: string }
  | { kind: 'history' };

/** 返回键应该做什么 */
export type BackAction =
  /** 选择模式激活：只退出选择模式，留在当前页 */
  | 'exit-selection'
  /** 编辑页有未保存改动：先问「放弃本次修改？」 */
  | 'confirm-leave-editor'
  /** 回到首页 */
  | 'home';

export interface BackInput {
  view: View;
  /** 是否处于批量选择模式 */
  selectionMode: boolean;
  /** 编辑页是否有未保存改动（首页/历史页恒为 false） */
  editorDirty: boolean;
}

/**
 * 决定一次「返回」应该做什么。
 *
 * 顺序是刻意的：选择模式的优先级最高 —— 用户此时的心智是「我在挑东西」，
 * 返回键应该先退出这层临时状态，而不是把他正在编辑的内容丢掉。
 *
 * @param input 当前界面状态
 */
export function decideBack(input: BackInput): BackAction {
  if (input.selectionMode) {
    return 'exit-selection';
  }
  if (input.view.kind === 'editor' && input.editorDirty) {
    return 'confirm-leave-editor';
  }
  return 'home';
}

/**
 * 视图深度：决定原生返回键是「返回上一页」还是「退出应用」。
 *
 * 0 = 首页（交给系统，回到桌面）；1 = 任意子页面（交给 JS 处理）。
 *
 * @param view 当前视图
 */
export function viewDepth(view: View): 0 | 1 {
  return view.kind === 'home' ? 0 : 1;
}
