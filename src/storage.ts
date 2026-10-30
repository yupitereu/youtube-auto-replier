import { browser } from 'wxt/browser';

export const drafts = {
  async load() {
    await browser.storage.local.remove('replyHistory').catch(() => {});
    const result = await browser.storage.local.get('replyDraft');
    return typeof result.replyDraft === 'string' ? result.replyDraft : '';
  },
  async save(value: string) {
    await browser.storage.local.set({ replyDraft: value });
  },
};
