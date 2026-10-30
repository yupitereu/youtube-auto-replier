if (new URL(location.href).searchParams.get('view') === 'shorts') {
  const list = document.getElementById('comments');
  const reel = document.createElement('ytd-reel-video-renderer');
  const open = document.createElement('button'); open.dataset.openComments = 'true'; open.setAttribute('aria-label', '댓글 4개 보기'); open.textContent = '댓글 4개 보기'; reel.append(open);
  const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
  panel.setAttribute('target-id', 'engagement-panel-comments-section'); panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'); panel.hidden = true;
  const close = document.createElement('button'); close.dataset.closeComments = 'true'; close.textContent = '댓글 닫기';
  const comments = document.createElement('ytd-comments'); comments.append(list); panel.append(close, comments);
  document.querySelector('main').append(reel, panel);
}
let posted = 0;
document.querySelectorAll('ytd-comment-view-model').forEach((el, index) => { el.dataset.commentId = `fixture-${index}`; });
document.addEventListener('click', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.matches('[data-open-comments]')) {
    document.body.dataset.commentOpens = String(Number(document.body.dataset.commentOpens ?? 0) + 1);
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer');
    panel.hidden = false; panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    const comments = panel.querySelector('ytd-comments'); comments.hidden = true;
    setTimeout(() => { comments.hidden = false; }, Number(document.body.dataset.commentsDelay ?? 0));
  }
  if (el.matches('[data-close-comments]')) {
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer');
    panel.hidden = true; panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  }
  if (el.matches('[data-reply]')) {
    const composer = el.closest('ytd-comment-view-model')?.querySelector('.composer');
    if (composer) composer.hidden = false;
  }
  if (el.matches('[data-submit]')) {
    const comment = el.closest('ytd-comment-view-model');
    const editor = comment?.querySelector('[contenteditable]');
    if (!editor?.textContent.trim()) return;
    if (document.body.dataset.noResponse === 'true') return;
    if (document.body.dataset.replyImages === 'true') {
      const thread = document.createElement('ytd-comment-thread-renderer');
      const reply = document.createElement('ytd-comment-view-model');
      reply.dataset.replyResult = 'true';
      const author = document.createElement('span'); author.id = 'author-text'; author.textContent = '@작성채널';
      const content = document.createElement('div'); content.id = 'content-text';
      for (const part of editor.textContent.split(/(🎉|❤️?)/u)) {
        if (part === '🎉' || part === '❤' || part === '❤️') {
          const image = document.createElement('img'); image.alt = document.body.dataset.replyAlt ?? part.replace(/\uFE0F/g, '');
          content.append(image);
        } else content.append(document.createTextNode(part));
      }
      reply.append(author, content); thread.append(reply); comment.closest('ytd-comment-thread-renderer').append(thread);
    } else {
      const reply = document.createElement('div'); reply.className = 'reply'; reply.dataset.replyResult = 'true'; reply.textContent = editor.textContent;
      comment.querySelector('.replies').append(reply);
    }
    editor.textContent = ''; el.disabled = true;
    document.getElementById('fixture-log').textContent = `로컬 게시 ${++posted}건`;
  }
});
document.addEventListener('input', (event) => {
  const editor = event.target;
  if (editor instanceof HTMLElement && editor.matches('[contenteditable]')) {
    const submit = editor.closest('.composer')?.querySelector('[data-submit]');
    if (submit) {
      const delay = Number(document.body.dataset.submitDelay ?? 0);
      submit.disabled = true;
      setTimeout(() => { submit.disabled = !editor.textContent.trim(); }, delay);
    }
  }
});
document.getElementById('add-comment').addEventListener('click', () => {
  const clone = document.querySelector('ytd-comment-thread-renderer').cloneNode(true);
  clone.querySelector('#author-text').textContent = '@추가댓글';
  clone.querySelector('ytd-comment-view-model').dataset.commentId = `added-${Date.now()}`;
  clone.querySelector('#content-text').textContent = '추가로 로딩된 댓글도 읽을 수 있나요?';
  clone.querySelector('.composer').hidden = true;
  clone.querySelector('[contenteditable]').textContent = '';
  document.getElementById('comments').append(clone);
});
document.getElementById('replace-comments').addEventListener('click', () => {
  const comments = document.getElementById('comments'); comments.replaceWith(comments.cloneNode(true));
});
