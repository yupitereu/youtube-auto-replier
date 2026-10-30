export interface CommentTarget {
  key: string;
  author: string;
  text: string;
  sourceUrl: string;
  myReplies?: string[];
  element: HTMLElement;
}
export class ReplyError extends Error {
  constructor(message: string, public readonly uncertain = false) { super(message); }
}
const threadSelector = 'ytd-comment-thread-renderer';
const commentSelector = 'ytd-comment-view-model, ytd-comment-renderer';
const replySelector = 'ytd-comment-view-model, ytd-comment-renderer, [data-reply-result]';

export function isYouTubeOrFixturePage(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.origin === 'http://localhost:8765') return true;
    return url.origin === 'https://www.youtube.com';
  } catch { return false; }
}
export function isSupportedPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.origin === 'http://localhost:8765' && url.pathname === '/fixtures/youtube.html') {
      return url.searchParams.get('page') !== 'home';
    }
    return url.origin === 'https://www.youtube.com' && (
      (url.pathname === '/watch' && Boolean(url.searchParams.get('v'))) || /^\/shorts\/[^/]+\/?$/.test(url.pathname)
    );
  } catch { return false; }
}
export function pageIdentity(raw = location.href): string {
  const url = new URL(raw);
  return url.origin + url.pathname + (url.pathname === '/watch' ? `?v=${url.searchParams.get('v') ?? ''}` : '');
}
function visible(el: HTMLElement): boolean {
  return !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0;
}
export function checkLoginState(doc: Document = document): 'authenticated' | 'logged-out' | 'unknown' {
  if (doc.body?.dataset.loggedOut === 'true') return 'logged-out';
  const signInLinks = Array.from(
    doc.querySelectorAll<HTMLElement>(
      'ytd-masthead a[href*="ServiceLogin"], ytd-masthead a[href*="accounts.google.com"], ytd-masthead [aria-label="로그인"], ytd-masthead [aria-label="Sign in"], ytd-comments-header-renderer a[href*="ServiceLogin"], ytd-comment-simplebox-renderer a[href*="ServiceLogin"]',
    ),
  );
  if (signInLinks.some(visible)) return 'logged-out';
  const avatarButtons = Array.from(
    doc.querySelectorAll<HTMLElement>(
      'ytd-masthead #avatar-btn, ytd-topbar-menu-button-renderer#avatar-btn, button#avatar-btn',
    ),
  );
  if (avatarButtons.some(visible)) return 'authenticated';
  if (doc.location.origin === 'https://www.youtube.com') {
    const mastheadActions = Array.from(
      doc.querySelectorAll<HTMLElement>('ytd-masthead #buttons > *, ytd-masthead #end > *'),
    );
    if (mastheadActions.some(visible)) {
      return 'logged-out';
    }
    return 'unknown';
  }
  return 'authenticated';
}
export function isLoggedIn(doc: Document = document): boolean {
  return checkLoginState(doc) === 'authenticated';
}
export function assertLoggedIn(doc: Document = document): void {
  if (checkLoginState(doc) === 'logged-out') {
    throw new ReplyError('유튜브 로그인 후 이용 가능합니다.');
  }
}
// YouTube renders Unicode emoji as <img alt="…">; textContent omits them.
// Rich YouTube video links inside comments replace the raw URL text with an icon <img> and video title.
export function readCommentText(node: Node | null): string {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element) {
    if (node.tagName === 'IMG') return node.getAttribute('alt') ?? '';
    if (node.tagName === 'BR') return '\n';
    if (node instanceof HTMLAnchorElement && node.querySelector('img') && node.getAttribute('href')) {
      return node.href;
    }
  }
  return Array.from(node.childNodes).map(readCommentText).join('');
}
function hash(value: string): string {
  let result = 0xcbf29ce484222325n;
  for (const char of value) result = BigInt.asUintN(64, (result ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  return result.toString(16);
}
function targetKey(comment: HTMLElement, sourceUrl: string, author: string, text: string): string {
  const permalink = Array.from(comment.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => {
    try { return Boolean(new URL(a.href).searchParams.get('lc')); } catch { return false; }
  });
  const id = comment.dataset.commentId ?? (permalink ? new URL(permalink.href).searchParams.get('lc') : null);
  const authorUrl = comment.querySelector<HTMLAnchorElement>('a#author-text')?.getAttribute('href') ?? author;
  // Fingerprint fallback is conservative: identical author/text is treated as one
  // target rather than risking a repeated promotional reply after a refresh.
  return 'reply-' + hash(JSON.stringify([sourceUrl, id ? ['id', id] : ['fingerprint', authorUrl, text]]));
}
export function isShortsPage(raw = location.href): boolean {
  const url = new URL(raw);
  return url.origin === 'https://www.youtube.com' && url.pathname.startsWith('/shorts/') ||
    url.origin === 'http://localhost:8765' && url.pathname === '/fixtures/youtube.html' && url.searchParams.get('view') === 'shorts';
}
function findOpenShortsCommentsPanel(): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]'))
    .find((el) => visible(el) && el.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
}
export async function openShortsComments(signal?: AbortSignal): Promise<void> {
  if (!isShortsPage()) return;
  const source = pageIdentity();
  function assertPage() {
    if (signal?.aborted) throw new ReplyError('댓글 불러오기가 중단되었습니다.');
    if (pageIdentity() !== source) throw new ReplyError('영상이 바뀌었습니다. 댓글 불러오기를 다시 눌러주세요.');
  }
  assertPage();
  if (!findOpenShortsCommentsPanel()) {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('reel-action-bar-view-model button[aria-label], ytd-reel-video-renderer button[aria-label]'))
      .filter((button) => {
        const label = button.getAttribute('aria-label') ?? '';
        const box = button.getBoundingClientRect();
        return visible(button) && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth &&
          /^(댓글(?:\s|$)|comments?\b|view\b.*comments?\b)/i.test(label);
      });
    if (buttons.length !== 1) throw new ReplyError('쇼츠 댓글 열기 버튼을 찾지 못했습니다. 영상의 댓글 창을 직접 연 뒤 댓글 불러오기를 눌러주세요.');
    const button = buttons[0]!;
    if (button.matches(':disabled, [aria-disabled="true"]')) throw new ReplyError('이 쇼츠에서는 댓글을 열 수 없습니다. 댓글 사용 설정을 확인해주세요.');
    button.click();
  }
  // Opening the drawer and loading its comments are separate asynchronous steps.
  for (let attempt = 0; attempt < 80; attempt++) {
    assertPage();
    const current = findOpenShortsCommentsPanel();
    if (current && (Array.from(current.querySelectorAll<HTMLElement>(threadSelector)).some(visible) ||
      Array.from(current.querySelectorAll<HTMLElement>('ytd-message-renderer')).some(visible))) return;
    await sleep(100);
  }
  assertPage();
  const comments = findOpenShortsCommentsPanel()?.querySelector<HTMLElement>('ytd-comments');
  if (comments && visible(comments)) return; // Loaded drawer with zero comments.
  throw new ReplyError('쇼츠 댓글 창을 열지 못했습니다. 영상에서 댓글을 확인한 뒤 댓글 불러오기를 다시 눌러주세요.');
}
function normalizeHref(href?: string | null): string | undefined {
  if (!href) return undefined;
  try { return decodeURIComponent(new URL(href, location.origin).pathname).replace(/\/+$/, ''); }
  catch { return href.trim(); }
}
function normalizeAvatar(src?: string | null): string | undefined {
  if (!src) return undefined;
  return src.trim().replace(/=s\d+[^/]*$/, '');
}
interface PageOwner {
  handles: Set<string>;
  hrefs: Set<string>;
  avatars: Set<string>;
}
function getPageOwner(doc: Document): PageOwner {
  const handles = new Set<string>();
  const hrefs = new Set<string>();
  const avatars = new Set<string>();
  const explicit = doc.body?.dataset.channelOwner?.trim();
  if (explicit) handles.add(explicit.replace(/^@/, ''));
  for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>(
    '#owner ytd-channel-name a[href], ytd-watch-metadata #owner a[href], ytd-watch-metadata ytd-channel-name a[href], #upload-info ytd-channel-name a[href], yt-reel-channel-bar-view-model a[href], ytd-reel-player-header-renderer ytd-channel-name a[href], reel-player-header-renderer a[href*="/@"]',
  ))) {
    const href = normalizeHref(link.getAttribute('href'));
    if (href) hrefs.add(href);
    const text = link.textContent?.trim().replace(/^@/, '');
    if (text) handles.add(text);
  }
  const ownerName = doc.querySelector('#owner #channel-name')?.textContent?.trim().replace(/^@/, '');
  if (ownerName) handles.add(ownerName);
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>(
    '#simple-box #author-thumbnail img, ytd-comment-simplebox-renderer #author-thumbnail img, #owner #avatar img, #creator-thumbnail img, #more-replies-sub-thread img',
  ))) {
    const avatar = normalizeAvatar(img.getAttribute('src'));
    if (avatar) avatars.add(avatar);
  }
  if (doc.location.origin === 'http://localhost:8765' && handles.size === 0) {
    handles.add('작성채널');
  }
  return { handles, hrefs, avatars };
}
function replyVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  if (el.getClientRects().length > 0) return true;
  const content = el.querySelector<HTMLElement>('#content-text');
  return Boolean(content && content.getClientRects().length > 0);
}
function getReplyElements(thread: HTMLElement, comment: HTMLElement): HTMLElement[] {
  const outer = Array.from(thread.querySelectorAll<HTMLElement>(replySelector)).filter((el) =>
    el !== comment && !el.contains(comment) && !comment.contains(el),
  );
  const inner = Array.from(comment.querySelectorAll<HTMLElement>('.replies > .reply, [data-reply-result]'));
  return Array.from(new Set([...outer, ...inner])).filter(replyVisible);
}
function extractReplyAuthor(reply: HTMLElement): { text?: string; href?: string; avatar?: string } {
  const authorEl = reply.querySelector<HTMLElement>('#author-text, a#name, [data-reply-author], #header-author a[href]');
  const text = (authorEl?.textContent ?? reply.dataset.replyAuthor ?? '').trim().replace(/^@/, '') || undefined;
  const linkEl = authorEl instanceof HTMLAnchorElement ? authorEl : reply.querySelector<HTMLAnchorElement>('a#author-text, a#name, #header-author a[href]');
  const href = normalizeHref(linkEl?.getAttribute('href'));
  const avatar = normalizeAvatar(reply.querySelector<HTMLImageElement>('#author-thumbnail img')?.getAttribute('src'));
  return { text, href, avatar };
}
function isSameAuthorReply(reply: HTMLElement, owner: PageOwner): boolean {
  if (reply.hasAttribute('data-creator-reply') ||
    Boolean(reply.querySelector('ytd-author-comment-badge-renderer, yt-author-comment-badge-view-model, #author-comment-badge > *'))) {
    return true;
  }
  const { text, href, avatar } = extractReplyAuthor(reply);
  if (avatar && owner.avatars.has(avatar)) return true;
  if (href && owner.hrefs.has(href)) return true;
  if (text && owner.handles.has(text)) return true;
  if (reply.hasAttribute('data-reply-result') && !text) return true;
  return false;
}
export async function openCreatorReplies(signal?: AbortSignal): Promise<void> {
  const source = pageIdentity();
  const scrollContainer = findOpenShortsCommentsPanel()?.querySelector<HTMLElement>('#contents, ytd-item-section-renderer') ?? null;
  const savedScrollY = window.scrollY;
  const savedContainerScrollTop = scrollContainer?.scrollTop ?? 0;
  let scrolled = false;
  try {
    const threads = Array.from(document.querySelectorAll<HTMLElement>(threadSelector)).filter(
      (thread) => visible(thread) && !thread.parentElement?.closest(threadSelector),
    );
    for (const thread of threads) {
      if (signal?.aborted) throw new ReplyError('댓글 불러오기가 중단되었습니다.');
      if (pageIdentity() !== source) throw new ReplyError('영상이 바뀌었습니다. 댓글 불러오기를 다시 눌러주세요.');
      const comment = thread.querySelector<HTMLElement>(commentSelector);
      if (!comment || getReplyElements(thread, comment).length > 0) continue;
      const expandButton = Array.from(thread.querySelectorAll<HTMLElement>(
        '#more-replies button, #more-replies [role="button"], #more-replies-sub-thread button, #more-replies-sub-thread [role="button"], ytd-comment-replies-renderer button, button[data-expand-replies]',
      )).find((button) => {
        if (!visible(button) || button.matches(':disabled, [aria-disabled="true"]')) return false;
        if (button.closest('#less-replies, ytd-comment-view-model, ytd-comment-renderer')) return false;
        const label = `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`;
        if (/숨기기|hide/i.test(label)) return false;
        return true;
      });
      const continuation = thread.querySelector<HTMLElement>('ytd-comment-replies-renderer ytd-continuation-item-renderer');
      if (!expandButton && (!continuation || !visible(continuation))) continue;
      scrolled = true;
      (expandButton ?? continuation ?? thread).scrollIntoView({ block: 'center' });
      await sleep(50);
      if (expandButton) expandButton.click();
      for (let attempt = 0; attempt < 30; attempt++) {
        if (signal?.aborted) throw new ReplyError('댓글 불러오기가 중단되었습니다.');
        if (pageIdentity() !== source) throw new ReplyError('영상이 바뀌었습니다. 댓글 불러오기를 다시 눌러주세요.');
        if (getReplyElements(thread, comment).length > 0) break;
        await sleep(100);
      }
    }
  } finally {
    if (scrolled) {
      if (scrollContainer) scrollContainer.scrollTop = savedContainerScrollTop;
      else window.scrollTo({ top: savedScrollY });
    }
  }
}
export function scanComments(doc: Document = document): CommentTarget[] {
  if (!isSupportedPage(doc.location.href)) return [];
  assertLoggedIn(doc);
  const sourceUrl = pageIdentity(doc.location.href);
  const owner = getPageOwner(doc);
  const seen = new Set<string>();
  const threads = Array.from(doc.querySelectorAll<HTMLElement>(threadSelector)).filter(
    (thread) => visible(thread) && !thread.parentElement?.closest(threadSelector),
  );
  // First pass: learn the author's handle/href/avatar from any reply that matches
  // a known creator badge or loaded avatar so off-screen replies with lazy-loaded
  // avatars still match by handle/href.
  for (const thread of threads) {
    const comment = thread.querySelector<HTMLElement>(commentSelector);
    if (!comment) continue;
    const replies = getReplyElements(thread, comment);
    const hasCreatorTeaser = Boolean(thread.querySelector('#creator-thumbnail, #more-replies-sub-thread'));
    for (const reply of replies) {
      if (isSameAuthorReply(reply, owner) || (hasCreatorTeaser && replies.length === 1)) {
        const { text, href, avatar } = extractReplyAuthor(reply);
        if (text) owner.handles.add(text);
        if (href) owner.hrefs.add(href);
        if (avatar) owner.avatars.add(avatar);
      }
    }
  }
  return threads.flatMap((thread) => {
    const comment = thread.querySelector<HTMLElement>(commentSelector);
    if (!comment) return [];
    const author = comment.querySelector('#author-text')?.textContent?.trim();
    const text = readCommentText(comment.querySelector('#content-text')).trim();
    if (!author || !text) return [];
    const key = targetKey(comment, sourceUrl, author, text);
    if (seen.has(key)) return [];
    seen.add(key);
    const myReplies = getReplyElements(thread, comment)
      .filter((reply) => isSameAuthorReply(reply, owner))
      .map((reply) => readCommentText(reply.querySelector('#content-text') ?? reply).trim())
      .filter(Boolean);
    return [{ key, author, text, sourceUrl, ...(myReplies.length ? { myReplies } : {}), element: comment }];
  });
}
export function validateTarget(target: CommentTarget, signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReplyError('사용자 요청으로 중단했습니다.');
  assertLoggedIn();
  if (isShortsPage() && target.sourceUrl === pageIdentity() && !findOpenShortsCommentsPanel()) throw new ReplyError('유튜브 댓글 창이 닫혀 등록을 중단했습니다. 댓글 불러오기를 눌러 다시 불러와주세요.');
  if (!isSupportedPage(location.href) || target.sourceUrl !== pageIdentity() || !target.element.isConnected || !visible(target.element)) {
    throw new ReplyError('영상이나 댓글이 바뀌었습니다. 댓글을 다시 읽어주세요.');
  }
  const author = target.element.querySelector('#author-text')?.textContent?.trim();
  const text = readCommentText(target.element.querySelector('#content-text')).trim();
  if (author !== target.author || text !== target.text) throw new ReplyError('댓글 내용이 변경되었습니다. 다시 읽어주세요.');
}
function findEditor(comment: HTMLElement): HTMLElement | undefined {
  return Array.from(comment.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"], #contenteditable-root[contenteditable="true"]')).find(visible);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function moveCaretToEnd(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function findMentionSuggestion(handle: string): HTMLElement | undefined {
  const bare = handle.replace(/^@/, '').toLowerCase();
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'ytd-popup-container ytd-mention-suggestion-renderer, ytd-mention-suggestion-renderer, yt-mention-suggestion-renderer, tp-yt-iron-dropdown tp-yt-paper-item, ytd-unified-autocomplete tp-yt-paper-item, [data-mention-item]',
    ),
  ).filter(visible);
  return (
    candidates.find((item) => item.textContent?.toLowerCase().includes(bare)) ??
    candidates[0]
  );
}

function insertEditorText(editor: HTMLElement, text: string): void {
  if (!text) return;
  editor.focus();
  moveCaretToEnd(editor);
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!inserted) {
    editor.append(document.createTextNode(text));
    moveCaretToEnd(editor);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  }
}

export async function prepareReply(target: CommentTarget, message: string, signal?: AbortSignal, reuseMatchingDraft = false): Promise<HTMLElement> {
  const trimmed = message.trim();
  if (!trimmed) throw new ReplyError('답글 문구를 입력해주세요.');
  validateTarget(target, signal);
  let editor = findEditor(target.element);
  if (!editor) {
    const button = target.element.querySelector<HTMLElement>('#reply-button-end button, #reply-button-end [role="button"], button[data-reply]');
    if (!button || !visible(button) || button.matches(':disabled, [aria-disabled="true"]')) throw new ReplyError('이 댓글의 답글 버튼을 찾을 수 없습니다. 로그인·댓글 상태를 확인하세요.');
    button.click();
    for (let attempt = 0; attempt < 30; attempt++) {
      validateTarget(target, signal); editor = findEditor(target.element);
      if (editor) break;
      await sleep(100);
    }
    if (!editor) throw new ReplyError('답글 입력란을 찾지 못했습니다. 직접 답글란을 열거나 로그인 상태를 확인하세요.');
  }
  validateTarget(target, signal);
  if (editor.textContent?.trim()) {
    if (reuseMatchingDraft && normalize(editor.textContent) === normalize(trimmed)) return editor;
    throw new ReplyError('이미 작성 중인 답글이 있어 덮어쓰지 않았습니다. 입력란을 확인해주세요.');
  }
  editor.scrollIntoView({ block: 'center' }); editor.focus();
  const handle = `@${target.author.replace(/^@/, '').trim()}`;
  const mentionIndex = handle.length > 1 ? trimmed.indexOf(handle) : -1;
  const canTryAutocomplete =
    mentionIndex >= 0 &&
    (location.hostname.includes('youtube.com') ||
      Boolean(document.querySelector('[data-mention-dropdown], tp-yt-iron-dropdown, ytd-unified-autocomplete')));

  if (canTryAutocomplete) {
    const prefix = trimmed.slice(0, mentionIndex);
    const bareHandle = handle.slice(1);
    const suffix = trimmed.slice(mentionIndex + handle.length);
    editor.replaceChildren();
    if (prefix) insertEditorText(editor, prefix);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true, composed: true }));
    insertEditorText(editor, '@');
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true, composed: true }));
    await sleep(50);
    insertEditorText(editor, bareHandle);
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: bareHandle.slice(-1), bubbles: true, composed: true }));

    let suggestion: HTMLElement | undefined;
    for (let attempt = 0; attempt < 15; attempt++) {
      validateTarget(target, signal);
      suggestion = findMentionSuggestion(handle);
      if (suggestion) break;
      await sleep(80);
    }
    if (suggestion) {
      suggestion.click();
      await sleep(60);
    }
    if (suffix) {
      const currentText = editor.textContent ?? '';
      const remaining = /\s$/.test(currentText) && suffix.startsWith(' ') ? suffix.slice(1) : suffix;
      insertEditorText(editor, remaining);
    }
    if (normalize(editor.textContent ?? '') !== normalize(trimmed)) {
      editor.replaceChildren(document.createTextNode(trimmed));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: trimmed }));
    }
  } else {
    editor.replaceChildren(document.createTextNode(trimmed));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: trimmed }));
  }
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  if (normalize(editor.textContent ?? '') !== normalize(trimmed)) throw new ReplyError('입력 결과를 확인하지 못했습니다. 직접 확인하세요.');
  return editor;
}
function normalize(value: string): string { return value.normalize('NFC').replace(/[\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim(); }
function getReplies(target: CommentTarget): HTMLElement[] {
  const thread = target.element.closest(threadSelector);
  if (!thread) return [];
  return Array.from(thread.querySelectorAll<HTMLElement>(replySelector)).filter((el) =>
    el !== target.element && !el.contains(target.element) && !target.element.contains(el),
  ).concat(Array.from(target.element.querySelectorAll<HTMLElement>('[data-reply-result]')));
}
export async function postReply(target: CommentTarget, message: string, options: {
  signal: AbortSignal;
}): Promise<void> {
  const editor = await prepareReply(target, message, options.signal, true);
  // YouTube may enable its composer asynchronously after handling input.
  let submit: HTMLElement | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    validateTarget(target, options.signal);
    const composer = editor.closest('ytd-comment-reply-dialog-renderer, ytd-comment-simplebox-renderer, .composer') ?? target.element;
    submit = Array.from(composer.querySelectorAll<HTMLElement>('#submit-button button, #submit-button [role="button"], button#submit-button, button[data-submit]'))
      .find((button) => visible(button) && !button.matches(':disabled, [aria-disabled="true"]'));
    if (submit) break;
    await sleep(100);
  }
  if (!submit) throw new ReplyError('게시 버튼이 활성화되지 않았습니다. 입력을 확인하세요.');
  const before = new Set(getReplies(target));
  validateTarget(target, options.signal);
  if (!editor.isConnected || normalize(editor.textContent ?? '') !== normalize(message) || !submit.isConnected || submit.matches(':disabled, [aria-disabled="true"]')) {
    throw new ReplyError('게시 직전 입력 상태가 바뀌었습니다. 직접 확인하세요.', true);
  }
  try { submit.click(); } catch { throw new ReplyError('게시 시도 결과를 확인하지 못했습니다.', true); }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (getReplies(target).some((reply) => !before.has(reply) && visible(reply) && normalize(readCommentText(reply.querySelector('#content-text') ?? reply)) === normalize(message))) return;
    if (isShortsPage() && target.sourceUrl === pageIdentity() && !findOpenShortsCommentsPanel()) throw new ReplyError('유튜브 댓글 창이 닫혀 등록 결과를 확인하지 못했습니다. 이미 등록됐을 수 있으므로 유튜브에서 확인해주세요.', true);
    if (options.signal.aborted || target.sourceUrl !== pageIdentity() || !target.element.isConnected) throw new ReplyError('게시 후 화면이 변경되거나 중단되어 결과가 불확실합니다. 다시 게시하지 말고 확인해주세요.', true);
    await sleep(100);
  }
  throw new ReplyError('새 답글을 화면에서 확인하지 못했습니다. 게시됐을 수 있으므로 재시도하지 않고 중단합니다.', true);
}
