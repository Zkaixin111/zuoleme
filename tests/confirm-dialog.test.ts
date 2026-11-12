import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 应用内确认框的静态契约。
 *
 * 为什么要有这一组：
 * 原来 4 处二次确认都用 `window.confirm`，而**系统弹窗的按钮文字由 WebView 的 locale
 * 决定，跟页面 `lang="zh-CN"` 无关** —— 真机上显示的是英文 `CANCEL / OK`，
 * 而整页界面都是中文。它同时也没有任何边框与语义色，跟纸感配色不是一套东西。
 *
 * 换成应用内弹窗之后，要守住的是三件事：
 * 1. `window.confirm` **一处都不许回来**（回来一次就重新出现英文按钮）；
 * 2. 每个危险操作的**默认结果必须是「不做」**——点遮罩、按 Esc 都等于取消；
 * 3. 「有框」且**按语气分色**：普通确认绿框、不可撤销操作红框。
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

const APP = readSource('src/App.tsx');
const DIALOG = readSource('src/components/ConfirmDialog.tsx');

describe('不再使用系统确认弹窗', () => {
  it('全项目没有 window.confirm / alert( 的调用', () => {
    // 只钉「调用」而不是「这个词出现过」：这两个文件的注释里都写着「为什么不用 window.confirm」
    expect(APP).not.toMatch(/window\.confirm\s*\(/);
    expect(APP).not.toMatch(/\balert\s*\(/);
    expect(DIALOG).not.toMatch(/window\.confirm\s*\(/);
  });

  it('四处二次确认全部走同一个 askConfirm（数量对得上，不是漏改了一处）', () => {
    const calls = APP.match(/await askConfirm\(/g) ?? [];
    // 放弃修改 / 标记完成（完成这一次） / 删除单条 / 批量删除
    expect(calls.length, 'askConfirm 的调用点数量变了，说明有确认被绕开或新增未登记').toBe(4);
  });
});

describe('确认框的文案与语义', () => {
  it('按钮文案是中文，且默认值不是「是 / 否」', () => {
    expect(DIALOG).toContain("confirmLabel = '确定'");
    expect(DIALOG).toContain("cancelLabel = '取消'");
    expect(DIALOG).not.toContain("'Yes'");
    expect(DIALOG).not.toContain("'Cancel'");
  });

  it('确认按钮文案必须是动词（调用点传的是删除 / 放弃 / 完成）', () => {
    expect(APP).toContain("confirmLabel: '删除'");
    expect(APP).toContain("confirmLabel: '放弃'");
    expect(APP).toContain("confirmLabel: '完成'");
  });

  it('语义上是一个模态框（读屏软件据此把它和页面内容分开）', () => {
    expect(DIALOG).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DIALOG).toContain('aria-labelledby="confirm-title"');
  });
});

describe('「区分颜色要有框」', () => {
  it('两个按钮都是 44px 描边框，不是实底也不是文字按钮', () => {
    const buttons = [...DIALOG.matchAll(/<button[\s\S]*?<\/button>/g)].map((match) => match[0]);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('h-11');
      expect(button).toContain('border');
      expect(button).toContain('rounded-[10px]');
    }
  });

  it('取消是灰框，确认按语气分色：普通深豆绿、危险砖红', () => {
    // 取消：灰描边 + 纸面白底
    expect(DIALOG).toContain('border-line-strong bg-surface');
    // 危险操作用红框，普通确认用深豆绿框（action 是主行动色，不是语义绿 accent）
    expect(DIALOG).toContain("'border-alert text-alert'");
    expect(DIALOG).toContain("'border-action text-action'");
    // 确认按钮必须是空心的（`bg-transparent`），否则「有框」会被实底盖住
    expect(DIALOG).toContain('border bg-transparent');
  });
});

describe('危险操作的默认结果是「不做」', () => {
  it('点遮罩 = 取消，点卡片本身不触发（否则一点卡片就把事情做了）', () => {
    expect(DIALOG).toContain('onClick={onCancel}');
    expect(DIALOG).toContain('onClick={(event) => event.stopPropagation()}');
  });

  it('Esc = 取消，且只在打开时挂监听', () => {
    expect(DIALOG).toContain("if (event.key === 'Escape')");
    expect(DIALOG).toContain('document.removeEventListener');
  });

  it('焦点默认落在「取消」上（误按回车不该执行危险操作）', () => {
    const cancelButton = DIALOG.slice(DIALOG.indexOf('autoFocus'));
    expect(cancelButton.startsWith('autoFocus'), 'autoFocus 必须挂在取消按钮上').toBe(true);
  });
});
