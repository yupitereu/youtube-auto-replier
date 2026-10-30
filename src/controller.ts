import { browser } from 'wxt/browser';
import { ReplyError } from './youtube';

export type AuthState = 'authenticated' | 'logged-out' | 'not-video' | 'not-youtube' | 'unknown';
export interface CommentItem { key: string; token: string; author: string; text: string; sourceUrl: string; myReplies?: string[] }
export interface Controller {
  checkAuth?(): Promise<AuthState>;
  identity(): Promise<string>;
  scan(): Promise<CommentItem[]>;
  validate(target: CommentItem): Promise<void>;
  post(target: CommentItem, message: string, signal: AbortSignal): Promise<void>;
  close(): void;
}
export const PORT_NAME = 'groupbuy-sidepanel-v1';
export function connectController(tabId: number): Controller {
  const port = browser.tabs.connect(tabId, { name: PORT_NAME, frameId: 0 });
  let sequence = 0;
  let disconnected = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; post: boolean }>();
  port.onMessage.addListener((result: { id: number; value?: unknown; error?: string; uncertain?: boolean }) => {
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    if (result.error) entry.reject(new ReplyError(result.error, result.uncertain));
    else entry.resolve(result.value);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    // Consume the connection error and fail closed when the page reloads or exits.
    void browser.runtime.lastError;
    for (const entry of pending.values()) entry.reject(new ReplyError('영상 연결이 끊겼습니다. 확장 아이콘을 다시 눌러 연결하세요.', entry.post));
    pending.clear();
  });
  function request<T>(method: string, data?: unknown): Promise<T> {
    if (disconnected) return Promise.reject(new ReplyError('영상 연결이 끊겼습니다. 확장 아이콘을 다시 눌러 연결하세요.'));
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject, post: method === 'post' });
      try { port.postMessage({ id, method, data }); }
      catch { pending.delete(id); reject(new ReplyError('영상과 통신하지 못했습니다.', method === 'post')); }
    });
  }
  return {
    checkAuth: () => request<'authenticated' | 'logged-out' | 'unknown'>('auth'),
    identity: () => request<string>('identity'),
    scan: () => request<CommentItem[]>('scan'),
    validate: (target) => request<void>('validate', { token: target.token }),
    async post(target, message, signal) {
      if (signal.aborted) throw new ReplyError('사용자 요청으로 중단했습니다.');
      const stop = () => { if (!disconnected) port.postMessage({ method: 'abort' }); };
      signal.addEventListener('abort', stop, { once: true });
      try { await request<void>('post', { token: target.token, message }); }
      finally { signal.removeEventListener('abort', stop); }
    },
    close: () => port.disconnect(),
  };
}
