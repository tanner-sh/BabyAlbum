// 添加到主屏幕（PWA）和推送通知

import { get, request } from './api';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let installPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();

// Chrome / Edge / 安卓：浏览器认为可以安装时会发这个事件，留着给“添加到主屏幕”按钮用
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
  listeners.forEach((l) => l());
});

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

export const onInstallAvailable = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const canPromptInstall = () => !!installPrompt;

export async function promptInstall() {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}

/** 已经是从主屏幕打开的 */
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- 推送

/** 推送要求 HTTPS（或 localhost）；iPhone 上还要求先添加到主屏幕 */
export function pushSupport(): 'ok' | 'insecure' | 'ios-needs-install' | 'unsupported' {
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !isStandalone()) return 'ios-needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

const base64ToBytes = (s: string) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('没有允许通知。可以在系统或浏览器的设置里打开');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
  await request('POST', '/api/push/subscribe', sub.toJSON());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await request('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
