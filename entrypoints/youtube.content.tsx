import { browser } from 'wxt/browser';
import { assertLoggedIn, checkLoginState, isSupportedPage, isYouTubeOrFixturePage, pageIdentity, openCreatorReplies, openShortsComments, postReply, ReplyError, scanComments, validateTarget, type CommentTarget } from '../src/youtube';
import { PORT_NAME } from '../src/controller';

type ConnectListener = Parameters<typeof browser.runtime.onConnect.addListener>[0];

// This script only operates the video DOM. All UI lives in Chrome's side panel.
export default defineContentScript({
  registration: 'runtime',
  main() {
    if (!isYouTubeOrFixturePage(location.href)) return;
    const state = globalThis as typeof globalThis & {
      groupbuyOnConnect?: ConnectListener;
    };
    if (state.groupbuyOnConnect) {
      browser.runtime.onConnect.removeListener(state.groupbuyOnConnect);
    }
    let running: AbortController | null = null;
    const onConnect: ConnectListener = (port) => {
      if (port.name !== PORT_NAME || port.sender?.id !== browser.runtime.id) return;
      const targets = new Map<string, CommentTarget>();
      let controller: AbortController | null = null;
      let connected = true;
      port.onDisconnect.addListener(() => { connected = false; controller?.abort(); targets.clear(); });
      port.onMessage.addListener((request: { id: number; method: string; data?: { token?: string; message?: string } }) => {
        if (request.method === 'abort') { controller?.abort(); return; }
        void (async () => {
          try {
            let value: unknown;
            if (request.method === 'auth') {
              const loginState = checkLoginState();
              value = loginState === 'authenticated' && !isSupportedPage(location.href) ? 'not-video' : loginState;
            } else if (request.method === 'identity') {
              assertLoggedIn();
              value = pageIdentity();
            } else if (request.method === 'scan') {
              if (running) throw new Error('게시 중에는 댓글을 다시 불러올 수 없습니다.');
              assertLoggedIn();
              targets.clear();
              const reading = new AbortController(); controller = reading;
              try {
                await openShortsComments(reading.signal);
                await openCreatorReplies(reading.signal);
              } finally { controller = null; }
              if (!connected) return;
              value = scanComments().map(({ element, ...item }) => {
                const token = crypto.randomUUID(); targets.set(token, { element, ...item });
                return { ...item, token };
              });
            } else if (request.method === 'validate' || request.method === 'post') {
              const target = targets.get(request.data?.token ?? '');
              if (!target) throw new Error('댓글을 다시 불러오고 확인해주세요.');
              validateTarget(target);
              if (request.method === 'post') {
                if (running) throw new Error('이 영상에서 이미 게시 작업 중입니다.');
                const message = request.data?.message;
                if (typeof message !== 'string' || !message.trim()) throw new Error('게시 문구가 없습니다.');
                if (!connected || running) throw new Error('연결이 종료되었거나 다른 게시가 시작되었습니다.');
                controller = new AbortController(); running = controller;
                try {
                  await postReply(target, message, { signal: controller.signal });
                } catch (error) {
                  const uncertain = error instanceof ReplyError && error.uncertain;
                  throw new ReplyError(error instanceof Error ? error.message : '게시 실패', uncertain);
                } finally { running = null; controller = null; }
              }
            } else throw new Error('지원하지 않는 요청입니다.');
            if (connected) port.postMessage({ id: request.id, value });
          } catch (error) {
            if (connected) port.postMessage({ id: request.id, error: error instanceof Error ? error.message : '요청 실패', uncertain: error instanceof ReplyError && error.uncertain });
          }
        })();
      });
    };
    state.groupbuyOnConnect = onConnect;
    browser.runtime.onConnect.addListener(onConnect);
  },
});
