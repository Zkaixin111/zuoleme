import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 返回手势 / 返回按钮（需求 1）的静态契约。
 *
 * 这条链路上有三层，任何一层掉链子都表现为「按返回直接退出应用」或「按返回没反应」，
 * 而且编译能过、装得上、不报错：
 *
 *   MainActivity.onBackPressed  ──读深度──>  ReminderAlarmPlugin（JS 写入的 depth）
 *            │ 深度 > 0：抛 backRequested 事件（不调 super）
 *            │ 深度 = 0 或没人接手：super.onBackPressed()（退出应用）
 *            ▼
 *   App.tsx 的 onBackRequested 订阅  ──>  goBack()  ──>  decideBack()
 *
 * 所以这里锁四件事：原生确实拦了、JS 确实上报了深度、订阅确实挂上了、决策确实收敛到一个入口。
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

const PLUGIN = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderAlarmPlugin.kt');
const MAIN_ACTIVITY = readSource('android/app/src/main/java/com/zkaixin/zuoleme/MainActivity.kt');
const BRIDGE = readSource('src/lib/reminder-bridge.ts');
const APP = readSource('src/App.tsx');
const BACK_BUTTON = readSource('src/components/FloatingBack.tsx');
const EDITOR = readSource('src/components/TodoEditor.tsx');
const HISTORY = readSource('src/components/HistoryView.tsx');

describe('原生：MainActivity 拦下返回键', () => {
  it('重写了 onBackPressed', () => {
    expect(MAIN_ACTIVITY).toContain('override fun onBackPressed()');
  });

  it('深度 > 0 且 JS 接手时不调 super（否则 Activity 直接被销毁）', () => {
    const guard = MAIN_ACTIVITY.indexOf(
      'if (ReminderAlarmPlugin.currentViewDepth() > 0 && ReminderAlarmPlugin.notifyBackRequested()) {',
    );
    expect(guard).toBeGreaterThan(-1);

    // 注释里也提到过 super.onBackPressed()，这里取最后一次出现（= 真正的调用）
    const superCall = MAIN_ACTIVITY.lastIndexOf('super.onBackPressed()');
    expect(superCall).toBeGreaterThan(-1);
    // 守卫必须在 super 之前，且中间必须是 return
    expect(guard).toBeLessThan(superCall);
    const between = MAIN_ACTIVITY.slice(guard, superCall);
    expect(between).toContain('return');
  });

  it('注释里写清了「为什么不用 WebView history」', () => {
    expect(MAIN_ACTIVITY).toContain('evaluateJavascript');
    expect(MAIN_ACTIVITY).toContain('history');
    // 也要说明兜底策略：没人接手就交回系统
    expect(MAIN_ACTIVITY).toContain('Bridge 未就绪或没人接手时一律');
  });
});

describe('原生：插件提供 setViewDepth 与 backRequested 事件', () => {
  it('setViewDepth 是 @PluginMethod，并读取 depth 参数', () => {
    expect(PLUGIN).toMatch(/@PluginMethod\s+fun setViewDepth\(call: PluginCall\)/);
    expect(PLUGIN).toContain('call.getInt("depth")');
  });

  it('实例用 WeakReference 挂到静态引用上（避免旋转时泄漏 Bridge）', () => {
    expect(PLUGIN).toContain('import java.lang.ref.WeakReference');
    expect(PLUGIN).toContain('WeakReference<ReminderAlarmPlugin>');
    expect(PLUGIN).toMatch(/override fun load\(\) \{\s*instance = WeakReference\(this\)/);
  });

  it('插件销毁时清空静态引用（不留下悬空实例）', () => {
    expect(PLUGIN).toContain('override fun handleOnDestroy()');
    expect(PLUGIN).toContain('instance = null');
  });

  it('backRequested 事件名在原生与 JS 两侧一致', () => {
    expect(PLUGIN).toContain('const val EVENT_BACK_REQUESTED = "backRequested"');
    expect(BRIDGE).toContain("addListener('backRequested'");
  });

  it('通知失败要吞掉异常并返回 false（交回系统，不崩）', () => {
    expect(PLUGIN).toContain('Log.w(TAG, "通知 JS 返回事件失败，交回系统处理", error)');
    expect(PLUGIN).toMatch(/fun notifyBackRequested\(\): Boolean/);
    expect(PLUGIN).toMatch(/fun currentViewDepth\(\): Int/);
  });

  it('插件没就绪时深度按 0 处理（宁可退出应用，也不要吞掉返回键）', () => {
    expect(PLUGIN).toMatch(/fun currentViewDepth\(\): Int \{\s*val plugin = instance\?\.get\(\) \?: return 0/);
  });
});

describe('JS 桥接：两个方法都是原生专属，Web 上安全空操作', () => {
  it('导出 setViewDepth 与 onBackRequested', () => {
    expect(BRIDGE).toContain('export async function setViewDepth(depth: number): Promise<void>');
    expect(BRIDGE).toContain('export async function onBackRequested(handler: () => void): Promise<() => void>');
  });

  it('两个方法都先判平台再调插件', () => {
    const viewDepthBlock = BRIDGE.slice(BRIDGE.indexOf('export async function setViewDepth'));
    expect(viewDepthBlock.slice(0, 400)).toContain('if (!isNativePlatform())');

    const backBlock = BRIDGE.slice(BRIDGE.indexOf('export async function onBackRequested'));
    expect(backBlock.slice(0, 500)).toContain('if (!isNativePlatform())');
  });

  it('onBackRequested 返回可取消的句柄（卸载时要真的退订）', () => {
    const backBlock = BRIDGE.slice(BRIDGE.indexOf('export async function onBackRequested'));
    expect(backBlock).toContain('return () =>');
    expect(backBlock).toContain('handle.remove()');
  });

  it('setViewDepth 把负值归零（脏数据不应该让返回键被永久拦下）', () => {
    const block = BRIDGE.slice(BRIDGE.indexOf('export async function setViewDepth'));
    expect(block).toContain('depth: depth > 0 ? depth : 0');
  });
});

describe('App：深度上报与返回订阅都收敛到 goBack', () => {
  it('视图变化后上报深度', () => {
    expect(APP).toContain('void setViewDepth(viewDepth(view));');
  });

  it('挂载时订阅 backRequested，卸载时退订', () => {
    expect(APP).toContain('const off = await onBackRequested(');
    expect(APP).toContain('unsubscribe?.();');
  });

  it('订阅回调走 ref，避免每次渲染重新订阅', () => {
    expect(APP).toContain('goBackRef.current = goBack;');
    expect(APP).toContain('goBackRef.current()');
  });

  it('goBack 是唯一入口：选择模式优先、脏编辑要确认、其余回首页', () => {
    expect(APP).toContain('const action = decideBack({ view, selectionMode, editorDirty });');
    expect(APP).toContain("window.confirm('放弃本次修改？')");
    expect(APP).toContain("if (action === 'exit-selection') {");
  });
});

describe('界面：浮动返回按钮与编辑页底部栏', () => {
  it('浮动返回按钮是 48×48 的圆形，压在底部操作栏上方', () => {
    expect(BACK_BUTTON).toContain('h-12 w-12');
    expect(BACK_BUTTON).toContain('rounded-full');
    expect(BACK_BUTTON).toContain("bottom: 'calc(5.5rem + env(safe-area-inset-bottom))'");
    expect(BACK_BUTTON).toContain('aria-label="返回"');
  });

  it('浮动返回按钮不用阴影（纸感约束）', () => {
    expect(BACK_BUTTON).not.toMatch(/\bshadow-/);
    expect(BACK_BUTTON).not.toMatch(/bg-gradient-/);
  });

  it('编辑页与历史页都能返回；编辑页底栏是「取消 + 保存」', () => {
    expect(EDITOR).toContain('<FloatingBack');
    expect(HISTORY).toContain('<FloatingBack');
    expect(EDITOR).toContain('取消');
    expect(EDITOR).toContain("flex-[2]");
  });
});
