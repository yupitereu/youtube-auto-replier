import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ReplyError } from './youtube';
import type { Controller, CommentItem as CommentTarget } from './controller';
import { candidateReply, isExactReply, isSimilarReply, renderReply } from './reply-template';

interface Props {
  controller: Controller;
  drafts: { load(): Promise<string>; save(value: string): Promise<void> };
}
interface Reviewed { targets: CommentTarget[]; messages: string[]; sourceUrl: string }
type BlockState = 'posted' | 'similar' | 'uncertain';
const historyLabel = (state?: BlockState | null) =>
  state === 'posted' ? '게시 확인됨' :
  state === 'similar' ? '유사 답글 확인됨' :
  state ? '이전 게시 확인 필요 · 재게시 제외' : '';
function getBlockState(
  item: CommentTarget,
  template: string,
  repostAllowed: Set<string>,
  uncertainKeys: Set<string>,
): BlockState | null {
  if (uncertainKeys.has(item.key)) return 'uncertain';
  const domReplies = repostAllowed.has(item.key) ? [] : (item.myReplies ?? []);
  if (domReplies.length === 0) return null;
  const candidate = candidateReply(template, item.author);
  if (!candidate) {
    return 'posted';
  }
  if (domReplies.some((prev) => isExactReply(prev, candidate))) return 'posted';
  if (domReplies.some((prev) => isSimilarReply(prev, candidate))) return 'similar';
  return null;
}

export function App({ controller, drafts }: Props) {
  const [comments, setComments] = useState<CommentTarget[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repostAllowed, setRepostAllowed] = useState<Set<string>>(new Set());
  const [uncertainKeys, setUncertainKeys] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [status, setStatus] = useState('댓글을 로딩한 다음 ‘댓글 불러오기’를 눌러주세요.');
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const readEpoch = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [blocker, setBlocker] = useState<'logged-out' | 'not-video' | 'not-youtube' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [page, setPage] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});
  const edited = useRef(false);
  const pending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const selectable = comments.filter((item) => !getBlockState(item, message, repostAllowed, uncertainKeys));
  const targets = selectable.filter((item) => selected.has(item.key));
  let review: Reviewed | null = null;
  let reviewError: string | null = null;
  const previewByKey: Record<string, string> = {};
  if (message.trim()) {
    try {
      for (const target of targets) {
        previewByKey[target.key] = renderReply(message, target.author);
      }
      if (loaded && targets.length > 0) {
        review = { targets: [...targets], messages: targets.map((t) => previewByKey[t.key]!), sourceUrl: targets[0]!.sourceUrl };
      }
    } catch (error) {
      reviewError = error instanceof Error ? error.message : '검토 실패';
    }
  }

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !messageInput.current) return;
    messageInput.current.focus();
    messageInput.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [message]);

  function insertNickname() {
    const input = messageInput.current;
    if (!input || busy) return;
    const token = '{닉네임}';
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const next = message.slice(0, start) + token + message.slice(end);
    const caret = start + token.length;
    edited.current = true;
    pendingCaret.current = next === message ? null : caret;
    setMessage(next); setResults({}); invalidate();
    // Also restore focus for a replacement that leaves the string unchanged.
    input.focus(); input.setSelectionRange(caret, caret);
  }

  useEffect(() => {
    let active = true;
    void drafts.load().then((value) => {
      if (!active) return;
      if (!edited.current) setMessage(value);
      setLoaded(true);
    }).catch(() => { if (active) setStatus('저장된 문구를 불러오지 못했습니다.'); });
    void controller.checkAuth?.().then((auth) => {
      if (!active || readingRef.current) return;
      if (auth === 'authenticated') setBlocker(null);
      else if (auth === 'logged-out' || auth === 'not-video' || auth === 'not-youtube') {
        setBlocker(auth);
        setStatus(
          auth === 'logged-out' ? '유튜브 로그인 후 이용 가능합니다.' :
          auth === 'not-video' ? '유튜브 영상 페이지에서 이용 가능합니다.' :
          '유튜브에서만 이용 가능합니다.',
        );
      }
    }).catch(() => {});
    return () => { active = false; abort.current?.abort(); };
  }, [controller, drafts]);
  useEffect(() => {
    let active = true;
    let checkingAuth = false;
    const id = window.setInterval(() => {
      if (checkingAuth || readingRef.current || busy) return;
      checkingAuth = true;
      void controller.checkAuth?.().then((auth) => {
        if (!active || readingRef.current) return;
        if (auth === 'logged-out' || auth === 'not-video' || auth === 'not-youtube') {
          abort.current?.abort(); setComments([]); setSelected(new Set()); setConfirmed(false); setResetTarget(null); setPage('');
          setBlocker(auth);
          setStatus(
            auth === 'logged-out' ? '유튜브 로그인 후 이용 가능합니다.' :
            auth === 'not-video' ? '유튜브 영상 페이지에서 이용 가능합니다.' :
            '유튜브에서만 이용 가능합니다.',
          );
        } else if (auth === 'authenticated') {
          setBlocker((prev) => {
            if (prev) setStatus('댓글을 로딩한 다음 ‘댓글 불러오기’를 눌러주세요.');
            return null;
          });
        }
      }).catch(() => {}).finally(() => { checkingAuth = false; });
    }, 500);
    return () => { active = false; clearInterval(id); };
  }, [controller, busy]);
  useEffect(() => {
    let active = true;
    let polling = false;
    const id = window.setInterval(() => {
      if (polling || readingRef.current || blocker !== null) return;
      const epoch = readEpoch.current;
      polling = true;
      void controller.identity().then((next) => {
        if (!active || epoch !== readEpoch.current || readingRef.current) return;
        setBlocker(null);
        if (!page) { setPage(next); return; }
        if (next !== page) { abort.current?.abort(); setComments([]); setSelected(new Set()); setConfirmed(false); setResetTarget(null); setPage(next); setStatus('영상이 바뀌었습니다. 댓글을 다시 불러와주세요.'); }
      }).catch((error) => {
        if (!active || epoch !== readEpoch.current || readingRef.current) return;
        if (error instanceof Error && error.message.includes('로그인')) {
          abort.current?.abort(); setComments([]); setSelected(new Set()); setConfirmed(false); setPage('');
          setBlocker('logged-out'); setStatus(error.message);
          return;
        }
        if (page) { abort.current?.abort(); setComments([]); setSelected(new Set()); setConfirmed(false); setPage(''); setStatus('영상 연결이 끊겼습니다. 댓글 불러오기를 눌러 다시 불러와주세요.'); }
      }).finally(() => { polling = false; });
    }, 500);
    return () => { active = false; clearInterval(id); };
  }, [controller, page, blocker]);

  function invalidate() { setConfirmed(false); setResetTarget(null); }
  async function scan() {
    if (busy || pending.current || readingRef.current || !message.trim()) return;
    readingRef.current = true; readEpoch.current++; setReading(true);
    invalidate(); setPage(''); setComments([]); setSelected(new Set()); setRepostAllowed(new Set()); setUncertainKeys(new Set());
    setResults({});
    setStatus('영상에 연결해 댓글을 불러오고 있습니다…');
    try {
      const next = await controller.scan();
      setBlocker(null);
      setLoaded(true); setComments(next); setSelected(new Set(next.map((c) => c.key)));
      setPage(await controller.identity());
      setStatus(next.length ? `현재 로딩된 댓글 ${next.length}개를 읽었습니다. 처리 이력이 없는 댓글을 전체 선택했습니다.` : '댓글이 없습니다. 댓글 창을 열고 스크롤한 뒤 다시 불러와주세요.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('로그인')) setBlocker('logged-out');
      setStatus(error instanceof Error ? error.message : '댓글을 불러오지 못했습니다. 댓글 불러오기를 눌러 다시 시도해주세요.');
    }
    finally { readingRef.current = false; setReading(false); }
  }
  async function allowRepost(target: CommentTarget) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    invalidate();
    try {
      if (!navigator.locks) throw new Error('최신 크롬을 사용하세요.');
      await navigator.locks.request('groupbuy-reply-posting', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('다른 탭에서 게시 중입니다. 작업 종료 후 다시 시도하세요.');
        await controller.validate(target);
        setRepostAllowed((prev) => new Set([...prev, target.key]));
        setUncertainKeys((prev) => { const next = new Set(prev); next.delete(target.key); return next; });
        setResults((prev) => { const next = { ...prev }; delete next[target.key]; return next; });
        setSelected((prev) => new Set([...prev, target.key]));
        setStatus(`${target.author}님의 댓글을 다시 선택했습니다. 미리보기 확인 후 등록을 시작하세요.`);
      });
    } catch (error) { setStatus(error instanceof Error ? error.message : '재게시 설정 실패'); }
    finally { pending.current = false; setBusy(false); }
  }
  async function runBatch() {
    if (!review || !confirmed || pending.current) return;
    const snapshot = review;
    setPosting(true);
    const connection = controller;
    pending.current = true; setBusy(true);
    setResults({});
    const runAbort = new AbortController(); abort.current = runAbort;
    let done = 0;
    try {
      if (!navigator.locks) throw new Error('동시 실행을 막을 수 없는 브라우저입니다. 최신 크롬을 사용하세요.');
      await navigator.locks.request('groupbuy-reply-posting', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('다른 탭에서 게시 작업을 실행 중입니다. 해당 작업을 먼저 종료하세요.');
        if (snapshot.sourceUrl !== await connection.identity()) throw new Error('영상이 바뀌었습니다. 다시 불러와주세요.');
        for (const [index, target] of snapshot.targets.entries()) {
          if (runAbort.signal.aborted) break;
          const replyMessage = snapshot.messages[index]!;
          setStatus(`${index + 1}/${snapshot.targets.length} · ${target.author}님에게 게시 중…`);
          try {
            await connection.post(target, replyMessage, runAbort.signal);
            setRepostAllowed((prev) => { const next = new Set(prev); next.delete(target.key); return next; });
            setComments((prev) => prev.map((c) => c.key === target.key ? { ...c, myReplies: [...(c.myReplies ?? []), replyMessage] } : c));
            setResults((prev) => ({ ...prev, [target.key]: '게시 확인됨' }));
            done++;
          } catch (error) {
            const uncertain = error instanceof ReplyError && error.uncertain;
            if (uncertain) {
              setUncertainKeys((prev) => new Set([...prev, target.key]));
            }
            const reason = error instanceof Error ? error.message : '게시 실패';
            setResults((prev) => ({ ...prev, [target.key]: uncertain ? '확인 필요 · 재시도 제외' : '중단 · ' + reason }));
            throw new Error(`${done}건 게시 확인 후 중단. ${reason}`);
          }
          // UI settling time, not an attempt to bypass platform rate limits.
          if (index < snapshot.targets.length - 1) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        setStatus(runAbort.signal.aborted ? `${done}건 게시 확인 후 중단했습니다. 남은 댓글은 게시하지 않았습니다.` : `${done}건의 새 답글을 화면에서 확인했습니다. 댓글을 다시 불러오면 처리 이력 대상은 제외됩니다.`);
      });
    } catch (error) { setStatus(error instanceof Error ? error.message : '작업을 중단했습니다.'); }
    finally { setConfirmed(false); pending.current = false; abort.current = null; setBusy(false); setPosting(false); }
  }

  if (blocker !== null) {
    return (
      <section className="panel is-logged-out" aria-label="유튜브 답글 도우미">
        <div className="login-required" role="status" aria-live="polite">
          <img className="brand-icon" src="/icon/48.png" width="44" height="44" alt="" />
          <h1>유튜브 답글 도우미</h1>
          <p className="login-required-message">
            {blocker === 'logged-out' ? '유튜브 로그인 후 이용 가능합니다.' :
             blocker === 'not-video' ? '유튜브 영상 페이지에서 이용 가능합니다.' :
             '유튜브에서만 이용 가능합니다.'}
          </p>
        </div>
      </section>
    );
  }

  return <section className="panel" aria-label="유튜브 답글 도우미">
    <header><div><h1><img className="brand-icon" src="/icon/48.png" width="28" height="28" alt="" /><span>유튜브 답글 도우미</span></h1></div>{busy && <div className="header-actions"><button className="stop" onClick={() => { abort.current?.abort(); setStatus('중단 요청 중입니다. 이미 시도한 게시 결과를 확인한 뒤 멈춥니다.'); }}>작업 중단</button></div>}<div className={`status header-status${posting ? ' is-warning' : ''}`} role="status" aria-live="polite" aria-atomic="false">{posting && <strong role="alert">답글 등록이 끝날 때까지 다른 탭으로 이동하거나 유튜브 댓글 창·확장 프로그램을 닫지 마세요.</strong>}<span>{status}</span></div></header>
    <main>
      <h2 id="reply-content-title" className="first-heading">1. 답글 내용 입력</h2>
      <p id="nickname-help" className="hint"><code>{'{닉네임}'}</code> 자리에 원댓글 작성자의 닉네임이 들어갑니다.</p>
      <textarea ref={messageInput} id="reply-message" aria-labelledby="reply-content-title" aria-describedby="nickname-help" rows={5} value={message} disabled={busy} onChange={(event) => { edited.current = true; setMessage(event.target.value); setResults({}); invalidate(); }} placeholder="{닉네임}님, 댓글 남겨주셔서 감사합니다!" />
      <div className="selection-actions"><button disabled={busy} onClick={insertNickname}>닉네임 추가</button><button disabled={busy} onClick={() => { void drafts.save(message).then(() => setStatus('문구를 저장했습니다.')).catch(() => setStatus('저장 실패')); }}>문구 저장</button></div>
      {reviewError && <p className="empty">{reviewError}</p>}
      <div className="section-header">
        <h2>2. 댓글 선택</h2>
        <button className="read-comments" aria-describedby="read-comments-help" onClick={() => void scan()} disabled={busy || reading || !message.trim()}>댓글 불러오기</button>
      </div>
      <p id="read-comments-help" className="hint">답글을 등록할 댓글을 선택하세요. 더 불러오려면 영상의 댓글을 스크롤한 뒤 다시 눌러주세요.</p>
      <div className="selection-actions"><label className="select-all"><input type="checkbox" checked={selectable.length > 0 && targets.length === selectable.length} ref={(el) => { if (el) el.indeterminate = targets.length > 0 && targets.length < selectable.length; }} disabled={busy || reading || !loaded || selectable.length === 0} onChange={(e) => { setSelected(e.target.checked ? new Set(selectable.map((c) => c.key)) : new Set()); invalidate(); }} /><span>전체 선택</span></label><span>게시 대상 {targets.length}개</span></div>
      <fieldset disabled={busy || reading}>
        {comments.length === 0 ? <p className="empty">아직 불러온 댓글이 없습니다.</p> : comments.map((item) => {
          const state = getBlockState(item, message, repostAllowed, uncertainKeys);
          const isSelected = selected.has(item.key) && !state;
          const previewText = isSelected ? previewByKey[item.key] : undefined;
          const checkboxId = `comment-${item.key}`;
          return <div className={`comment ${isSelected ? 'selected' : ''}`} key={item.key}>
          <div className="comment-body">
            <input id={checkboxId} type="checkbox" checked={isSelected} disabled={Boolean(state)} onChange={(e) => { const checked = e.target.checked; setSelected((prev) => { const next = new Set(prev); if (checked) next.add(item.key); else next.delete(item.key); return next; }); invalidate(); }} />
            <div className="comment-main">
              <div className="comment-meta">
                <label htmlFor={checkboxId}><strong>{item.author}</strong></label>
                {state && resetTarget !== item.key && <button type="button" className="repost-trigger" disabled={busy} onClick={() => { invalidate(); setResetTarget(item.key); }}>재게시 허용</button>}
              </div>
              <span className="comment-text">{item.text}</span>
              {(results[item.key] || state) && <small>{results[item.key] ?? historyLabel(state)}</small>}
              {previewText && <p className="preview-message">{previewText}</p>}
            </div>
          </div>
          {state && resetTarget === item.key && <div className="repost-actions" role="group" aria-label={`${item.author} 재게시 확인`}>
            <p className="hint">이 댓글에 다시 답글을 등록할 수 있도록 게시 이력을 해제합니다. 기존 답글은 삭제되지 않습니다. 기존 답글이 남아 있다면 중복 게시될 수 있습니다.</p>
            <button disabled={busy} onClick={() => void allowRepost(item)}>이력 해제하고 다시 선택</button>
            <button disabled={busy} onClick={() => setResetTarget(null)}>취소</button>
          </div>}
        </div>;
        })}
      </fieldset>
      <section className="registration" aria-labelledby="registration-title">
        <h2 id="registration-title">3. 답글 등록</h2>
        <label className="acknowledge"><input type="checkbox" checked={confirmed} disabled={!review || busy} onChange={(e) => setConfirmed(e.target.checked)} /><span>선택한 댓글과 답글 내용을 확인했습니다.</span></label>
        <button className="primary" disabled={!review || !confirmed || busy} onClick={() => void runBatch()}>{review?.targets.length ?? targets.length}개 댓글에 자동 등록 시작</button>
      </section>
      <footer className="app-version">v0.3.19</footer>
    </main>
  </section>;
}
