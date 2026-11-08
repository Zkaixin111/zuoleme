import { describe, expect, it } from 'vitest';
import { decideBack, viewDepth, type BackInput, type View } from '../src/lib/navigation';

/**
 * 「返回」应该做什么（需求 1 的决策层）。
 *
 * 原生返回键 / 侧滑手势 / 右下角浮动按钮 / 编辑页的「取消」最终都走同一个函数，
 * 所以这里的组合就是**全部**返回行为。顺序错了会很难受：
 * 选择模式没退出就直接回首页 = 用户以为自己在挑东西，结果页面全变了。
 */

const HOME: View = { kind: 'home' };
const EDITOR_NEW: View = { kind: 'editor' };
const EDITOR_EDIT: View = { kind: 'editor', id: 'todo-1' };
const HISTORY: View = { kind: 'history' };

/**
 * 构造一份返回输入。
 *
 * @param view 当前视图
 * @param selectionMode 是否在选择模式
 * @param editorDirty 编辑页是否有未保存改动
 */
function input(view: View, selectionMode = false, editorDirty = false): BackInput {
  return { view, selectionMode, editorDirty };
}

describe('decideBack：返回的四种组合', () => {
  it('首页 + 无改动 → 回首页（原生侧此时会直接退出应用）', () => {
    expect(decideBack(input(HOME))).toBe('home');
  });

  it('子页面 + 无改动 → 直接回首页', () => {
    expect(decideBack(input(EDITOR_EDIT))).toBe('home');
    expect(decideBack(input(EDITOR_NEW))).toBe('home');
    expect(decideBack(input(HISTORY))).toBe('home');
  });

  it('编辑页有未保存改动 → 先确认「放弃本次修改？」', () => {
    expect(decideBack(input(EDITOR_EDIT, false, true))).toBe('confirm-leave-editor');
    expect(decideBack(input(EDITOR_NEW, false, true))).toBe('confirm-leave-editor');
  });

  it('选择模式 → 只退出选择模式（哪怕编辑页是脏的）', () => {
    expect(decideBack(input(HISTORY, true, false))).toBe('exit-selection');
    expect(decideBack(input(HOME, true, false))).toBe('exit-selection');
    // 选择模式优先级最高：先退出这层临时状态，不要顺手把用户正在编辑的内容丢掉
    expect(decideBack(input(EDITOR_EDIT, true, true))).toBe('exit-selection');
  });

  it('首页不会出现「确认离开」这种动作', () => {
    for (const selectionMode of [false, true]) {
      expect(decideBack(input(HOME, selectionMode, false))).not.toBe('confirm-leave-editor');
    }
  });
});

describe('viewDepth：0 = 交给系统退出，1 = 交给 JS 返回', () => {
  it('首页深度 0', () => {
    expect(viewDepth(HOME)).toBe(0);
  });

  it('编辑页（新建与编辑）与历史页深度都是 1', () => {
    expect(viewDepth(EDITOR_NEW)).toBe(1);
    expect(viewDepth(EDITOR_EDIT)).toBe(1);
    expect(viewDepth(HISTORY)).toBe(1);
  });

  it('每个视图都有明确的深度（没有 undefined，原生侧才敢直接判断 > 0）', () => {
    for (const view of [HOME, EDITOR_NEW, EDITOR_EDIT, HISTORY]) {
      expect([0, 1]).toContain(viewDepth(view));
    }
  });
});
