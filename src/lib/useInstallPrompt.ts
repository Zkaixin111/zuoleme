import { useEffect, useState } from 'react';

/** Chromium 系浏览器的安装提示事件（非标准，需自行声明） */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' | 'installed' }>;
}

export interface InstallPromptState {
  /** 浏览器是否提供了安装入口（Chromium 才有；Firefox 不触发） */
  canInstall: boolean;
  /** 是否已作为应用安装（独立窗口运行） */
  installed: boolean;
  /** 触发安装弹窗，返回用户是否接受 */
  promptInstall: () => Promise<boolean>;
}

/** 监听「安装到桌面」事件 */
export function useInstallPrompt(): InstallPromptState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.matchMedia('(display-mode: standalone)').matches;
  });

  useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = async (): Promise<boolean> => {
    if (!deferredPrompt) {
      return false;
    }
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return choice.outcome === 'accepted';
  };

  return { canInstall: deferredPrompt !== null, installed, promptInstall };
}
