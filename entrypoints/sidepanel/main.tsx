import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { App } from '../../src/App';
import { connectController, type Controller } from '../../src/controller';
import { isSupportedPage, isYouTubeOrFixturePage } from '../../src/youtube';
import { drafts } from '../../src/storage';
import '../../src/panel.css';

function SidePanel() {
  const connection = useRef<Controller | null>(null);
  const target = useRef<{ tabId: number; windowId: number } | null>(null);
  const controller = useMemo<Controller>(() => {
    function current() {
      if (!connection.current) throw new Error('댓글 불러오기를 눌러 영상의 댓글을 불러와주세요.');
      return connection.current;
    }
    let generation = 0;
    let lastLoggedOutTabId: number | null = null;
    function close() { generation++; connection.current?.close(); connection.current = null; }
    return {
      async checkAuth() {
        const explicit = Number(new URL(location.href).searchParams.get('tabId'));
        const tab = Number.isInteger(explicit) && explicit > 0 ? await browser.tabs.get(explicit).catch(() => undefined) :
          (await browser.tabs.query({ active: true, currentWindow: true }))[0] ??
          (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (!tab?.id) return 'unknown';
        if (tab.status === 'loading' && tab.pendingUrl && isYouTubeOrFixturePage(tab.pendingUrl)) {
          return 'unknown';
        }
        const url = tab.url;
        if (!url) {
          if (lastLoggedOutTabId === tab.id) return 'logged-out';
          lastLoggedOutTabId = null;
          return 'not-youtube';
        }
        if (url.includes('/login') || url.includes('accounts.google.com')) {
          return lastLoggedOutTabId === tab.id ? 'logged-out' : 'unknown';
        }
        const isFixtureOrigin = new URL(url).origin === 'http://localhost:8765';
        if (!isYouTubeOrFixturePage(url) || (isFixtureOrigin && new URL(url).pathname !== '/fixtures/youtube.html')) {
          lastLoggedOutTabId = null;
          return 'not-youtube';
        }
        try {
          await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/youtube.js'] });
        } catch {
          return 'unknown';
        }
        const probe = connectController(tab.id);
        try {
          const state = (await probe.checkAuth?.()) ?? 'unknown';
          if (state === 'logged-out') lastLoggedOutTabId = tab.id;
          else if (state === 'authenticated' || state === 'not-video') lastLoggedOutTabId = null;
          return state;
        } catch {
          return 'unknown';
        } finally {
          probe.close();
        }
      },
      // Each explicit read resolves the target anew and repairs stale ports.
      // Keep App mounted so refreshing comments never discards unsaved text.
      async scan() {
        close(); const reading = generation;
        const assertRead = () => { if (reading !== generation) throw new Error("영상이 바뀌었습니다. 댓글 불러오기를 다시 눌러주세요."); };
        const explicit = Number(new URL(location.href).searchParams.get('tabId'));
        const tab = Number.isInteger(explicit) && explicit > 0 ? await browser.tabs.get(explicit) :
          (await browser.tabs.query({ active: true, currentWindow: true }))[0];
        assertRead();
        if (!tab?.id) throw new Error('현재 탭을 찾지 못했습니다. 유튜브 영상 탭에서 다시 시도해주세요.');
        if (!tab.url) throw new Error('현재 탭의 주소를 읽을 권한이 없습니다. 유튜브 영상에서 크롬 툴바의 유튜브 답글 도우미 아이콘을 누른 뒤 댓글 불러오기를 눌러주세요.');
        if (!isSupportedPage(tab.url)) throw new Error('유튜브 영상 페이지에서 댓글 불러오기를 눌러주세요.');
        target.current = { tabId: tab.id, windowId: tab.windowId };
        try {
          await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/youtube.js'] });
        } catch {
          throw new Error('이 영상에 접근하지 못했습니다. 유튜브 탭에서 확장 아이콘을 누른 뒤 댓글 불러오기를 눌러주세요.');
        }
        assertRead();
        const next = connectController(tab.id); connection.current = next;
        try {
          await next.identity();
          const comments = await next.scan();
          assertRead();
          return comments;
        } catch (error) { next.close(); if (connection.current === next) connection.current = null; throw error; }
      },
      identity: async () => current().identity(),
      validate: async (item) => current().validate(item),
      post: async (item, message, signal) => current().post(item, message, signal),
      close,
    };
  }, []);
  useEffect(() => {
    const refresh = (message: { type?: string; tabId?: number; windowId?: number }) => {
      if (message.type === 'reconnect-panel' && target.current &&
        (message.windowId === undefined ? message.tabId === target.current.tabId : message.windowId === target.current.windowId)) controller.close();
    };
    const switched = (info: { tabId: number; windowId: number }) => {
      const active = target.current;
      if (active && info.windowId === active.windowId && info.tabId !== active.tabId && !new URL(location.href).searchParams.has('tabId')) controller.close();
    };
    browser.runtime.onMessage.addListener(refresh);
    browser.tabs.onActivated.addListener(switched);
    return () => { controller.close(); browser.runtime.onMessage.removeListener(refresh); browser.tabs.onActivated.removeListener(switched); };
  }, [controller]);
  return <App controller={controller} drafts={drafts} />;
}
createRoot(document.getElementById('root')!).render(<SidePanel />);
