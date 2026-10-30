import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import AxeBuilder from '@axe-core/playwright';

declare const chrome: typeof browser;

let context: BrowserContext;
let profile: string;
let temporaryRoot: string;
const fixture = 'http://localhost:8765/fixtures/youtube.html';

test.beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'groupbuy-extension-test-'));
  profile = path.join(temporaryRoot, 'profile');
  const extension = path.join(temporaryRoot, 'extension');
  await cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.host_permissions ?? []).toEqual(['https://www.youtube.com/*']);
  expect(manifest.permissions).toContain('sidePanel');
  expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  // Headless tests cannot click Chrome's toolbar to grant activeTab. Grant only
  // the local fixture origin in this temporary test copy, never in shipped output.
  manifest.host_permissions = ['https://www.youtube.com/*', 'http://localhost/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
});
test.afterEach(async () => { for (const [page, control] of panels) { await control.close(); if (!page.isClosed()) await page.close(); } panels.clear(); });
test.afterAll(async () => { await context?.close(); if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }); });

const panels = new Map<Page, Page>();
const ui = (page: Page) => { const result = panels.get(page); if (!result) throw new Error('Side panel missing'); return result; };
async function openHelper(page: Page, url = fixture, read = true) {
  await panels.get(page)?.close();
  await page.goto(url);
  const title = `fixture-${Date.now()}-${Math.random()}`;
  await page.evaluate((value) => { document.title = value; }, title);
  const worker = await workerForTest();
  const tabId = await worker.evaluate(async (expectedTitle) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    const tab = tabs.find((candidate) => candidate.title === expectedTitle);
    if (!tab?.id) throw new Error('Fixture tab missing');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/youtube.js'] });
    return tab.id;
  }, title);
  const control = await context.newPage(); panels.set(page, control);
  await control.setViewportSize({ width: 390, height: 844 });
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  // Headless Chromium cannot display browser chrome. Load the exact side-panel
  // document in an extension tab, bound to the separate fixture tab via its port.
  await control.goto(`${extensionOrigin}/sidepanel.html?tabId=${tabId}`);
  await expect(control.getByRole('heading', { name: '유튜브 답글 도우미' })).toBeVisible();
  if (read) {
    const input = control.getByLabel('1. 답글 내용 입력');
    if (!(await input.inputValue()).trim()) {
      await expect(control.getByRole('button', { name: '댓글 불러오기', exact: true })).toBeDisabled();
      await input.fill('{닉네임}님 안내');
    }
    await expect(control.getByRole('button', { name: '댓글 불러오기', exact: true })).toBeEnabled();
    await control.getByRole('button', { name: '댓글 불러오기', exact: true }).click();
    await expect(panel(page).getByRole('status')).toContainText('현재 로딩된 댓글');
  }
}
const panel = (page: Page) => ui(page).locator('.panel');
const targets = (page: Page) => panel(page).locator('fieldset').getByRole('checkbox');
async function workerForTest() { return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); }
async function firstTwo(page: Page) {
  await targets(page).nth(2).uncheck(); await targets(page).nth(3).uncheck();
}
async function reviewAndStart(page: Page, count: number) {
  const registration = ui(page).getByRole('region', { name: '3. 답글 등록', exact: true });
  await registration.getByRole('checkbox', { name: '선택한 댓글과 답글 내용을 확인했습니다.' }).check();
  await registration.getByRole('button', { name: `${count}개 댓글에 자동 등록 시작`, exact: true }).click();
}

test.beforeEach(async () => {
  const worker = await workerForTest();
  await worker.evaluate(() => chrome.storage.local.clear());
});

test('all loaded comments selected; nickname preview is literal and does not post before confirmation', async () => {
  const page = await context.newPage(); await openHelper(page);
  await expect(targets(page)).toHaveCount(4);
  const registration = ui(page).getByRole('region', { name: '3. 답글 등록', exact: true });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('');
  await expect(ui(page).getByRole('button', { name: '댓글 불러오기', exact: true })).toBeDisabled();
  await expect(registration.getByRole('checkbox')).toBeDisabled();
  await expect(registration.getByRole('button')).toBeDisabled();
  for (const checkbox of await targets(page).all()) await expect(checkbox).toBeChecked();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님, 공구가 열렸어요!\nhttps://example.com/?a=<test>');
  await expect(ui(page).getByRole('button', { name: '댓글 불러오기', exact: true })).toBeEnabled();
  const previews = panel(page).locator('.comment .preview-message');
  await expect(previews).toHaveCount(4);
  await expect(previews.first()).toHaveText('@하늘 님, 공구가 열렸어요!\nhttps://example.com/?a=<test>');
  await expect(previews.first()).toHaveCSS('margin-bottom', '0px');
  await expect(panel(page).locator('test')).toHaveCount(0);
  await expect(registration.getByRole('checkbox')).toBeEnabled();
  await expect(ui(page).getByRole('button', { name: '4개 댓글에 자동 등록 시작', exact: true })).toBeDisabled();
  await expect(page.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{잘못된변수}');
  await expect(previews).toHaveCount(0);
  await expect(panel(page).getByText('지원하지 않는 변수')).toBeVisible();
  await expect(registration.getByRole('checkbox')).toBeDisabled();
  await page.close();
});

test('posts selected comments sequentially with individual names; persists deduplication after refresh', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님, 공구가 오픈했어요!');
  await reviewAndStart(page, 2);
  await expect(page.getByText('로컬 게시 2건', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('status')).toContainText('2건의 새 답글');
  await expect(panel(page).getByText('게시 확인됨', { exact: true })).toHaveCount(2);
  await expect(page.locator('[data-reply-result]').nth(0)).toHaveText('@하늘 님, 공구가 오픈했어요!');
  await expect(page.locator('[data-reply-result]').nth(1)).toHaveText('@바다 님, 공구가 오픈했어요!');
  await expect(page.getByRole('textbox', { name: '기존 답글', exact: true })).toHaveText('직접 작성 중인 문구입니다.');
  const saved = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(saved.replyHistory as Record<string, {state: string}>).map((v) => v.state)).toEqual(['posted', 'posted']);
  await openHelper(page);
  await expect(targets(page).nth(0)).toBeDisabled(); await expect(targets(page).nth(1)).toBeDisabled();
  await expect(page.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await page.close();
});

test('existing draft stops the batch without overwriting or proceeding to next target', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 안내입니다.');
  await reviewAndStart(page, 4);
  await expect(panel(page).getByRole('status')).toContainText('덮어쓰지 않았습니다');
  await expect(page.getByText('로컬 게시 2건', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '기존 답글', exact: true })).toHaveText('직접 작성 중인 문구입니다.');
  await expect(ui(page).getByRole('button', { name: '작업 중단', exact: true })).toHaveCount(0);
  await page.close();
});

test('unknown posting outcome stops and remains excluded after reload', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await page.evaluate(() => { document.body.dataset.noResponse = 'true'; });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('결과 확인 테스트');
  await reviewAndStart(page, 1);
  await expect(panel(page).getByRole('status')).toContainText('재시도하지 않고 중단', { timeout: 10_000 });
  const saved = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(saved.replyHistory as Record<string, {state: string}>)[0]?.state).toBe('uncertain');
  await openHelper(page);
  await expect(targets(page).first()).toBeDisabled();
  await expect(panel(page).getByText('이전 게시 확인 필요 · 재게시 제외', { exact: true })).toBeVisible();
  await page.close();
});

test('stop request prevents subsequent posts without repeating the successful target', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 안내'); await reviewAndStart(page, 2);
  await expect(page.getByText('로컬 게시 1건', { exact: true })).toBeVisible();
  await ui(page).getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('남은 댓글은 게시하지 않았습니다');
  await expect(page.locator('[data-reply-result]')).toHaveCount(1);
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page).first()).toBeDisabled(); await expect(targets(page).nth(1)).toBeEnabled();
  await page.close();
});

test('stale DOM is rejected and navigation invalidates reviewed targets', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('안내 문구');
  await page.getByRole('button', { name: '댓글 DOM 교체', exact: true }).click();
  await reviewAndStart(page, 1);
  await expect(panel(page).getByRole('status')).toContainText('영상이나 댓글이 바뀌었습니다');
  await expect(page.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(panel(page).locator('.comment .preview-message')).toHaveCount(4);
  await page.evaluate(() => history.pushState({}, '', '/other'));
  await expect(targets(page)).toHaveCount(0);
  await expect(panel(page).locator('.comment .preview-message')).toHaveCount(0);
  await page.close();
});

test('draft is saved without posting and panel can close and reopen', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 저장된 문구');
  await ui(page).getByRole('button', { name: '문구 저장', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('문구를 저장했습니다.');
  await expect(page.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await expect(ui(page).getByRole('button', { name: '첫 대상 입력만 시험 (게시 안 함)', exact: true })).toHaveCount(0);
  await page.reload(); await openHelper(page);
  await expect(ui(page).getByLabel('1. 답글 내용 입력')).toHaveValue('{닉네임}님 저장된 문구');
  const worker = await workerForTest();
  const state = await worker.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(state)).toEqual(['replyDraft']);
  await ui(page).reload();
  await expect(ui(page).getByLabel('1. 답글 내용 입력')).toHaveValue('{닉네임}님 저장된 문구');
  await expect(page.locator('#groupbuy-reply-helper')).toHaveCount(0);
  await page.close();

});

test('panel keyboard selection and confirmation remain accessible in narrow viewport', async () => {
  const page = await context.newPage(); await page.setViewportSize({ width: 390, height: 844 }); await openHelper(page);
  await targets(page).first().focus(); await targets(page).first().press('Space'); await expect(targets(page).first()).not.toBeChecked();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 공구 안내');
  await expect(panel(page).locator('.comment .preview-message')).toHaveCount(3);
  const overflow = await panel(page).evaluate((host) => { return host.scrollWidth > host.clientWidth; });
  expect(overflow).toBe(false);
  const result = await new AxeBuilder({ page: ui(page) }).include('.panel').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
  await ui(page).screenshot({ path: 'docs/screenshots/narrow.png' });
  await ui(page).setViewportSize({ width: 420, height: 1050 });
  await ui(page).screenshot({ path: 'docs/screenshots/desktop.png' }); await page.close();
});


test('a second tab cannot run while another batch holds the posting lock', async () => {
  const first = await context.newPage(); await openHelper(first); await firstTwo(first);
  const second = await context.newPage(); await openHelper(second); await firstTwo(second);
  await first.evaluate(() => { document.body.dataset.noResponse = 'true'; });
  await ui(first).getByLabel('1. 답글 내용 입력').fill('첫 탭 안내');
  await reviewAndStart(first, 2);
  const worker = await workerForTest();
  await expect.poll(async () => {
    const saved = await worker.evaluate(() => chrome.storage.local.get('replyHistory'));
    return Object.values(saved.replyHistory ?? {}).some((entry) => (entry as {state: string}).state === 'posting');
  }).toBe(true);
  await ui(second).getByLabel('1. 답글 내용 입력').fill('둘째 탭 안내');
  await reviewAndStart(second, 2);
  await expect(panel(second).getByRole('status')).toContainText('다른 탭에서 게시 작업을 실행 중');
  await expect(second.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await ui(first).getByRole('button', { name: '작업 중단', exact: true }).click();
  await expect(panel(first).getByRole('status')).toContainText('결과가 불확실');
  await first.close(); await second.close();
});


test('matching prefilled reply is registered automatically after delayed submit activation', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await page.evaluate(() => { document.body.dataset.submitDelay = '700'; });
  await page.locator('ytd-comment-thread-renderer').first().locator('[data-reply]').click();
  await page.getByRole('textbox', { name: '하늘님에게 답글', exact: true }).fill('@하늘 님 준비된 안내');
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 준비된 안내');
  await reviewAndStart(page, 1);
  await expect(page.getByText('로컬 게시 1건', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('status')).toContainText('1건의 새 답글');
  await expect(page.locator('[data-reply-result]')).toHaveText('@하늘 님 준비된 안내');
  await page.close();
});

test('reply history can be explicitly reset, persists across reload, and allows posting again', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 재게시 안내');
  await reviewAndStart(page, 2);
  await expect(panel(page).getByRole('status')).toContainText('2건의 새 답글');
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await ui(page).getByRole('button', { name: '재게시 허용', exact: true }).first().click();
  await ui(page).getByRole('button', { name: '취소', exact: true }).click();
  await expect(targets(page).nth(0)).toBeDisabled();
  // Simulate the creator deleting their reply on YouTube. Absence alone must
  // not clear history, since collapsed/unloaded replies also appear absent.
  await page.locator('[data-reply-result]').first().evaluate((el) => el.remove());
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page).nth(0)).toBeDisabled();
  await ui(page).getByRole('button', { name: '재게시 허용', exact: true }).first().click();
  await ui(page).getByRole('button', { name: '이력 해제하고 다시 선택', exact: true }).click();
  await expect(targets(page).nth(0)).toBeChecked();
  await expect(targets(page).nth(1)).toBeDisabled();
  await expect(page.locator('[data-reply-result]')).toHaveCount(1);
  await openHelper(page);
  await expect(targets(page).nth(0)).toBeEnabled();
  await expect(targets(page).nth(1)).toBeDisabled();
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck();
  await targets(page).nth(0).check();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 재게시 안내');
  await reviewAndStart(page, 1);
  await expect(panel(page).getByRole('status')).toContainText('1건의 새 답글');
  await expect(page.locator('[data-reply-result]')).toHaveCount(1);
  const saved = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(saved.replyHistory as Record<string, {state: string}>).map((v) => v.state)).toEqual(['posted', 'posted']);
  await page.close();
});

test('uncertain reply stays excluded until explicit history reset confirmation', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await page.evaluate(() => { document.body.dataset.noResponse = 'true'; });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 확인 안내');
  await reviewAndStart(page, 1);
  await expect(panel(page).getByRole('status')).toContainText('새 답글을 화면에서 확인하지 못했습니다', { timeout: 10000 });
  await expect(targets(page).first()).toBeDisabled();
  await ui(page).getByRole('button', { name: '재게시 허용', exact: true }).click();
  await expect(ui(page).getByRole('group', { name: '@하늘 재게시 확인' })).toContainText('기존 답글은 삭제되지 않습니다');
  await ui(page).getByRole('button', { name: '이력 해제하고 다시 선택', exact: true }).click();
  await expect(targets(page).first()).toBeChecked();
  await expect(page.getByText('로컬 게시 0건', { exact: true })).toBeVisible();
  await page.close();
});


test('typing Space and f stays in panel without triggering page shortcuts, including document capture', async () => {
  const page = await context.newPage(); await openHelper(page);
  await page.evaluate(() => {
    for (const capture of [true, false]) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        document.addEventListener(type, (event) => {
          const key = (event as KeyboardEvent).key;
          if (key !== ' ' && key !== 'f') return;
          document.body.dataset.shortcutEvents = String(Number(document.body.dataset.shortcutEvents ?? 0) + 1);
          // Reproduce the player consuming Space when the shadow host is the target.
          if (key === ' ') event.preventDefault();
        }, { capture });
      }
    }
  });
  const editor = ui(page).getByLabel('1. 답글 내용 입력');
  await editor.fill(''); await editor.focus();
  await ui(page).keyboard.type('hello f world');
  await expect(editor).toHaveValue('hello f world');
  await editor.press('Enter'); await ui(page).keyboard.type(' f');
  await expect(editor).toHaveValue('hello f world\n f');
  await editor.press('Backspace');
  await expect(editor).toHaveValue('hello f world\n ');
  expect(await page.evaluate(() => document.body.dataset.shortcutEvents ?? '0')).toBe('0');
  // Native keyboard navigation and checkbox activation must remain usable.
  await editor.press('Tab'); await expect(ui(page).getByRole('button', { name: '닉네임 추가' })).toBeFocused();
  await targets(page).first().focus(); await ui(page).keyboard.press('Space');
  await expect(targets(page).first()).not.toBeChecked();
  expect(await page.evaluate(() => document.body.dataset.shortcutEvents ?? '0')).toBe('0');
  await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('f');
  expect(Number(await page.evaluate(() => document.body.dataset.shortcutEvents))).toBeGreaterThan(0);
  await page.close();
});


test('connecting the side panel leaves website layout intact and closing it stops the next post', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await expect(page.locator('#groupbuy-reply-helper')).toHaveCount(0);
  expect(await page.evaluate(() => ({ inlineStyle: document.body.getAttribute('style'), frames: document.querySelectorAll('iframe').length }))).toEqual({ inlineStyle: null, frames: 0 });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 사이드 패널 안내');
  await reviewAndStart(page, 2);
  await expect(page.getByText('로컬 게시 1건', { exact: true })).toBeVisible();
  await ui(page).close();
  // Reopening a new extension document after the settling interval must find
  // only the confirmed first delivery, never an invisible continued batch.
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-reply-result]')).toHaveCount(1);
  const saved = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(saved.replyHistory ?? {})).toHaveLength(1);
  await page.close();
});

test('video reload disconnects the old reviewed targets and cannot post into the new document', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('연결 종료 테스트');
  await expect(panel(page).locator('.comment .preview-message')).toHaveCount(4);
  await page.reload();
  await expect(panel(page).getByRole('status')).toContainText('영상 연결이 끊겼습니다');
  await expect(targets(page)).toHaveCount(0);
  await expect(panel(page).locator('.comment .preview-message')).toHaveCount(0);
  await expect(page.locator('[data-reply-result]')).toHaveCount(0);
  await expect(ui(page).getByLabel('1. 답글 내용 입력')).toHaveValue('연결 종료 테스트');
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await page.close();
});


test('closing panel during an unconfirmed submit records uncertainty before a later reconnect', async () => {
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await page.evaluate(() => { document.body.dataset.noResponse = 'true'; });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('종료 중 결과 확인');
  await reviewAndStart(page, 1);
  const worker = await workerForTest();
  await expect.poll(async () => {
    const result = await worker.evaluate(() => chrome.storage.local.get('replyHistory'));
    return Object.values(result.replyHistory ?? {}).map((item) => (item as { state: string }).state);
  }).toEqual(['posting']);
  await ui(page).close();
  await expect.poll(async () => {
    const result = await worker.evaluate(() => chrome.storage.local.get('replyHistory'));
    return Object.values(result.replyHistory ?? {}).map((item) => (item as { state: string }).state);
  }).toEqual(['uncertain']);
  await openHelper(page);
  await expect(targets(page).first()).toBeDisabled();
  await expect(page.locator('[data-reply-result]')).toHaveCount(0);
  await page.close();
});

test('toolbar uses action click permission flow and panel reconnects without reusing the review', async () => {
  const worker = await workerForTest();
  await expect.poll(() => worker.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: false });
  const page = await context.newPage(); await openHelper(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('이전 검토 문구');
  const confirm = ui(page).getByRole('checkbox', { name: '선택한 댓글과 답글 내용을 확인했습니다.' });
  await confirm.check();
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await expect(ui(page).getByLabel('1. 답글 내용 입력')).toHaveValue('이전 검토 문구');
  await expect(confirm).not.toBeChecked();
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await page.close();
});

test('unsupported target shows YouTube-only or video-only screen and recovers automatically after returning to video', async () => {
  const page = await context.newPage(); await openHelper(page);
  await page.goto(`${fixture}?page=home`);
  await expect(ui(page).getByRole('status')).toContainText('유튜브 영상 페이지에서 이용 가능합니다.');
  await expect(ui(page).getByRole('button', { name: '댓글 불러오기', exact: true })).toHaveCount(0);
  await page.goto('http://localhost:8765/other');
  await expect(ui(page).getByRole('status')).toContainText('유튜브에서만 이용 가능합니다.');
  await expect(ui(page).getByRole('button', { name: '댓글 불러오기', exact: true })).toHaveCount(0);
  await page.goto(fixture);
  await expect(ui(page).getByRole('button', { name: '댓글 불러오기', exact: true })).toBeEnabled();
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await page.close();
});

test('five selected comments with image emoji replies all complete and nested replies never become targets', async () => {
  const page = await context.newPage(); await openHelper(page);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '새 댓글 추가', exact: true }).click();
  await page.evaluate(() => { document.body.dataset.replyImages = 'true'; });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(7);
  await targets(page).nth(2).uncheck(); await targets(page).nth(3).uncheck();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 🎉 오픈했어요!\n구매 안내 ❤️ https://example.com');
  await reviewAndStart(page, 5);
  await expect(panel(page).getByRole('status')).toContainText('5건의 새 답글', { timeout: 15000 });
  await expect(page.getByText('로컬 게시 5건', { exact: true })).toBeVisible();
  await expect(page.locator('[data-reply-result] img')).toHaveCount(10);
  const history = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(history.replyHistory ?? {}).map((entry) => (entry as {state: string}).state)).toEqual(Array(5).fill('posted'));
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(7);
  for (const index of [0, 1, 4, 5, 6]) await expect(targets(page).nth(index)).toBeDisabled();
  await page.close();
});

test('emoji-only original comment is read and remains valid when emoji are represented as images', async () => {
  const page = await context.newPage(); await openHelper(page);
  await page.locator('ytd-comment-thread-renderer').first().locator('#content-text').evaluate((el) => {
    const image = document.createElement('img'); image.alt = '🎉'; el.replaceChildren(image);
  });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await expect(panel(page).locator('.comment-text').first()).toHaveText('🎉');
  await ui(page).getByRole('checkbox', { name: '전체 선택', exact: true }).uncheck(); await targets(page).first().check();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('감사합니다');
  await reviewAndStart(page, 1);
  await expect(panel(page).getByRole('status')).toContainText('1건의 새 답글');
  await page.close();
});

test('different emoji is not mistaken for a matching posted reply and remaining targets stop', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await page.evaluate(() => { document.body.dataset.replyImages = 'true'; document.body.dataset.replyAlt = '🎈'; });
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 🎉 안내');
  await reviewAndStart(page, 2);
  await expect(panel(page).getByRole('status')).toContainText('새 답글을 화면에서 확인하지 못했습니다', { timeout: 10000 });
  await expect(page.getByText('로컬 게시 1건', { exact: true })).toBeVisible();
  const history = await (await workerForTest()).evaluate(() => chrome.storage.local.get('replyHistory'));
  expect(Object.values(history.replyHistory ?? {}).map((entry) => (entry as {state: string}).state)).toEqual(['uncertain']);
  await page.close();
});

test('read comments opens a closed Shorts drawer, waits for comments, and never toggles an open drawer closed', async () => {
  const page = await context.newPage(); await openHelper(page, `${fixture}?view=shorts`);
  const drawer = page.locator('ytd-engagement-panel-section-list-renderer');
  await expect(drawer).toBeVisible(); await expect(targets(page)).toHaveCount(4);
  expect(await page.evaluate(() => document.body.dataset.commentOpens)).toBe('1');
  await ui(page).getByLabel('1. 답글 내용 입력').fill('작성 중인 문구 유지');
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4); await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.commentOpens)).toBe('1');
  await page.getByRole('button', { name: '댓글 닫기', exact: true }).click();
  await page.evaluate(() => { document.body.dataset.commentsDelay = '600'; });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4); await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.commentOpens)).toBe('2');
  await expect(ui(page).getByLabel('1. 답글 내용 입력')).toHaveValue('작성 중인 문구 유지');
  await expect(page.locator('[data-reply-result]')).toHaveCount(0);
  await page.close();
});

test('disabled Shorts comments reports the reason and can be retried through the same read button', async () => {
  const page = await context.newPage(); await openHelper(page, `${fixture}?view=shorts`, false);
  await page.locator('[data-open-comments]').evaluate((el) => { (el as HTMLButtonElement).disabled = true; });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('이 쇼츠에서는 댓글을 열 수 없습니다');
  await expect(targets(page)).toHaveCount(0);
  await page.locator('[data-open-comments]').evaluate((el) => { (el as HTMLButtonElement).disabled = false; });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await expect(targets(page)).toHaveCount(4);
  await page.close();
});


test('nickname inserts at the caret, replaces selected text, and restores focus for continued typing', async () => {
  const page = await context.newPage(); await openHelper(page);
  const editor = ui(page).getByLabel('1. 답글 내용 입력');
  const insert = ui(page).getByRole('button', { name: '닉네임 추가', exact: true });
  await editor.fill('앞뒤');
  await editor.evaluate((el) => { (el as HTMLTextAreaElement).focus(); (el as HTMLTextAreaElement).setSelectionRange(1, 1); });
  await insert.click();
  await expect(editor).toHaveValue('앞{닉네임}뒤'); await expect(editor).toBeFocused();
  await ui(page).keyboard.type('님');
  await expect(editor).toHaveValue('앞{닉네임}님뒤');
  // Replacing the same token must still restore the caret even without a value change.
  await editor.evaluate((el) => { (el as HTMLTextAreaElement).setSelectionRange(1, 6); });
  await insert.click(); await ui(page).keyboard.type('!');
  await expect(editor).toHaveValue('앞{닉네임}!님뒤');
  await editor.fill('before NAME after');
  await editor.evaluate((el) => { (el as HTMLTextAreaElement).setSelectionRange(7, 11); });
  await insert.click(); await expect(editor).toHaveValue('before {닉네임} after');
  await editor.press('Tab'); await expect(insert).toBeFocused(); await insert.press('Enter');
  await expect(editor).toHaveValue('before {닉네임}{닉네임} after'); await expect(editor).toBeFocused();
  await expect(page.locator('[data-reply-result]')).toHaveCount(0);
  await page.close();
});

test('posting notice stays visible when the panel is scrolled and disappears after completion', async () => {
  const page = await context.newPage(); await openHelper(page); await firstTwo(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 안내');
  await reviewAndStart(page, 2);
  const notice = panel(page).getByRole('alert');
  await expect(notice).toContainText('답글 등록이 끝날 때까지 다른 탭으로 이동하거나 유튜브 댓글 창·확장 프로그램을 닫지 마세요.');
  await expect(panel(page).locator('.header-status')).toHaveCount(1);
  await expect(panel(page).locator('.header-status')).toHaveClass(/is-warning/);
  await panel(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const box = await notice.boundingBox();
  expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await expect(panel(page).getByRole('status')).toContainText('2건의 새 답글');
  await expect(notice).toHaveCount(0);
  await expect(panel(page).locator('.header-status')).not.toHaveClass(/is-warning/);
  const statusBox = await panel(page).getByRole('status').boundingBox();
  expect(statusBox).not.toBeNull(); expect(statusBox!.y).toBeGreaterThanOrEqual(0); expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(844);
  await page.close();
});

test('closing Shorts comments during a batch stops remaining replies and removes the posting notice', async () => {
  const page = await context.newPage(); await openHelper(page, `${fixture}?view=shorts`); await firstTwo(page);
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님 안내');
  await reviewAndStart(page, 2);
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(page.getByText('로컬 게시 1건', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '댓글 닫기', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('댓글 창이 닫혀 등록을 중단했습니다');
  await expect(page.locator('[data-reply-result]')).toHaveCount(1);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await page.close();
});

test('existing same-author DOM reply blocks similar (>=80%) templates across devices, ignores other authors, and unlocks for new templates', async () => {
  const page = await context.newPage();
  await page.goto(fixture);
  // Simulate a reply already posted on another device by the creator (@작성채널) on the 1st comment,
  // and a reply by another viewer (@다른시청자) on the 2nd comment, with empty chrome.storage.local.
  await page.evaluate(() => {
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
    const creatorReply = document.createElement('div');
    creatorReply.className = 'reply';
    creatorReply.dataset.replyAuthor = '@작성채널';
    creatorReply.innerHTML = '<span id="content-text">하늘님, 공구가 오픈했어요!</span>';
    threads[0]?.querySelector('.replies')?.append(creatorReply);

    const otherReply = document.createElement('div');
    otherReply.className = 'reply';
    otherReply.dataset.replyAuthor = '@다른시청자';
    otherReply.innerHTML = '<span id="content-text">바다님, 공구가 오픈했어요!</span>';
    threads[1]?.querySelector('.replies')?.append(otherReply);
  });
  const title = `fixture-${Date.now()}-${Math.random()}`;
  await page.evaluate((value) => { document.title = value; }, title);
  const worker = await workerForTest();
  const tabId = await worker.evaluate(async (expectedTitle) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    const tab = tabs.find((candidate) => candidate.title === expectedTitle);
    if (!tab?.id) throw new Error('Fixture tab missing');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/youtube.js'] });
    return tab.id;
  }, title);
  const control = await context.newPage(); panels.set(page, control);
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html?tabId=${tabId}`);
  await control.getByRole('button', { name: '댓글 불러오기', exact: true }).click();

  // Exact match shows '게시 확인됨'
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님, 공구가 오픈했어요!');
  await expect(targets(page).nth(0)).toBeDisabled();
  await expect(panel(page).getByText('게시 확인됨', { exact: true })).toHaveCount(1);

  // 1-char typo difference ("오픈했어요!" vs "오픈됐어요!") has >80% similarity -> shows '유사 답글 확인됨', 2nd comment (other author) stays enabled.
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님, 공구가 오픈됐어요!');
  await expect(targets(page).nth(0)).toBeDisabled();
  await expect(panel(page).getByText('유사 답글 확인됨', { exact: true })).toHaveCount(1);
  await expect(targets(page).nth(1)).toBeEnabled();
  await expect(targets(page).nth(1)).toBeChecked();

  // Real multi-line promotional reply with URL vs edited reply without URL shows '유사 답글 확인됨'
  await page.evaluate(() => {
    const firstReply = document.querySelector('ytd-comment-thread-renderer .reply[data-reply-author="@작성채널"] #content-text');
    if (firstReply) {
      firstReply.textContent = '하늘님~~~~~\n🎉드디어! 칼로하스 3주년 특집 한정수량 오픈했어요.\nhttps://youtu.be/yhGOJ3_Bm2k?si=l_Gh665ShhlExAtl\n위 영상더보기란으로 주문하세요.';
    }
  });
  await ui(page).getByRole('button', { name: '댓글 불러오기', exact: true }).click();
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님~~~~~\n드디어! 칼로하스 오픈할거에요.\n위 영상더보기란으로 주문하세요.');
  await expect(targets(page).nth(0)).toBeDisabled();
  await expect(panel(page).getByText('유사 답글 확인됨', { exact: true })).toHaveCount(1);

  // Completely different 2nd-round reply (<80% similarity) unlocks the 1st comment automatically.
  await ui(page).getByLabel('1. 답글 내용 입력').fill('{닉네임}님, 오늘 자정에 마감됩니다! 서둘러 확인해주세요.');
  await expect(targets(page).nth(0)).toBeEnabled();
  await expect(targets(page).nth(0)).toBeChecked();
  await page.close();
});

test('logged-out YouTube page shows centered login required screen and hides main UI until login', async () => {
  const page = await context.newPage();
  await page.goto(fixture);
  await page.evaluate(() => { document.body.dataset.loggedOut = 'true'; });
  const title = `fixture-${Date.now()}-${Math.random()}`;
  await page.evaluate((value) => { document.title = value; }, title);
  const worker = await workerForTest();
  const tabId = await worker.evaluate(async (expectedTitle) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    const tab = tabs.find((candidate) => candidate.title === expectedTitle);
    if (!tab?.id) throw new Error('Fixture tab missing');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/youtube.js'] });
    return tab.id;
  }, title);
  const control = await context.newPage(); panels.set(page, control);
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html?tabId=${tabId}`);
  await expect(panel(page).getByRole('status')).toContainText('유튜브 로그인 후 이용 가능합니다.');
  await expect(control.getByLabel('1. 답글 내용 입력')).toHaveCount(0);
  await expect(control.getByRole('button', { name: '댓글 불러오기', exact: true })).toHaveCount(0);
  await expect(control.getByRole('region', { name: '3. 답글 등록', exact: true })).toHaveCount(0);

  // Navigating to a login page (non-video URL) must NOT expose the main UI.
  await page.goto('http://localhost:8765/login');
  await page.waitForTimeout(1200);
  await expect(panel(page).getByRole('status')).toContainText('유튜브 로그인 후 이용 가능합니다.');
  await expect(control.getByLabel('1. 답글 내용 입력')).toHaveCount(0);

  // Returning to the video page after logging in reveals the main UI automatically.
  await page.goto(fixture);
  await expect(control.getByLabel('1. 답글 내용 입력')).toBeVisible();
  await expect(control.getByRole('button', { name: '댓글 불러오기', exact: true })).toBeVisible();

  // Logging out (including after a page reload) hides the main UI again.
  await page.reload();
  await page.evaluate(() => { document.body.dataset.loggedOut = 'true'; });
  await expect(panel(page).getByRole('status')).toContainText('유튜브 로그인 후 이용 가능합니다.');
  await expect(control.getByLabel('1. 답글 내용 입력')).toHaveCount(0);
  await page.close();
});
