import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // Use action.onClicked so Chrome grants activeTab for the clicked video.
  // Keep open() synchronous within that event: no await/query/setOptions first.
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const opening = browser.sidePanel.open({ windowId: tab.windowId });
    void opening.then(async () => {
      await browser.action.setBadgeText({ tabId: tab.id, text: '' });
      await browser.action.setTitle({ tabId: tab.id, title: '유튜브 답글 도우미 열기' });
      await browser.runtime.sendMessage({ type: 'reconnect-panel', tabId: tab.id, windowId: tab.windowId }).catch(() => {});
    }).catch(async (error) => {
      console.error('도우미 열기 실패', error);
      await browser.action.setBadgeText({ tabId: tab.id, text: '!' });
      await browser.action.setTitle({ tabId: tab.id, title: `사이드 패널 열기 실패: ${String(error)}` });
    });
  });
});
