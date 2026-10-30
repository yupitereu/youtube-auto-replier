function formatMentionHandle(author: string): string {
  const nickname = author.replace(/^@/, '').trim();
  return nickname ? `@${nickname}` : '';
}

function substituteNickname(template: string, handle: string): string {
  return template
    .replace(/\{닉네임\}(?=\S)/g, `${handle} `)
    .split('{닉네임}')
    .join(handle)
    .trim();
}

export function renderReply(template: string, author: string): string {
  const handle = formatMentionHandle(author);
  if (!handle) throw new Error('작성자 이름을 확인할 수 없습니다.');
  const unsupported = template.match(/\{[^{}]+\}/g)?.filter((token) => token !== '{닉네임}');
  if (unsupported?.length) throw new Error(`지원하지 않는 변수: ${unsupported.join(', ')}. {닉네임}을 사용하세요.`);
  const message = substituteNickname(template, handle);
  if (!message) throw new Error('답글 문구를 입력해주세요.');
  return message;
}

export function candidateReply(template: string, author: string): string | null {
  if (!template.trim()) return null;
  const handle = formatMentionHandle(author);
  if (!handle) return null;
  const message = substituteNickname(template, handle);
  return message || null;
}

function normalizeForSimilarity(value: string): string {
  const normalized = value.normalize('NFC').toLowerCase();
  const withoutUrls = normalized.replace(/https?:\/\/\S+/g, '');
  const base = withoutUrls.trim() ? withoutUrls : normalized;
  const stripped = base.replace(/[\s\p{P}\p{S}]+/gu, '');
  return stripped || base.replace(/[\uFE0E\uFE0F\s]+/g, '');
}

function lcsLength(first: string[], second: string[]): number {
  const dp = new Array<number>(second.length + 1).fill(0);
  for (let i = 0; i < first.length; i++) {
    let prevDiag = 0;
    for (let j = 0; j < second.length; j++) {
      const temp = dp[j + 1]!;
      dp[j + 1] = first[i] === second[j] ? prevDiag + 1 : Math.max(dp[j + 1]!, dp[j]!);
      prevDiag = temp;
    }
  }
  return dp[second.length]!;
}

export function replySimilarity(a: string, b: string): number {
  const first = Array.from(normalizeForSimilarity(a));
  const second = Array.from(normalizeForSimilarity(b));
  if (first.length === 0 && second.length === 0) return 1;
  if (first.length === 0 || second.length === 0) return 0;
  if (first.join('') === second.join('')) return 1;
  const prev = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 0; i < first.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i + 1;
    for (let j = 0; j < second.length; j++) {
      const temp = prev[j + 1]!;
      const cost = first[i] === second[j] ? 0 : 1;
      prev[j + 1] = Math.min(prev[j + 1]! + 1, prev[j]! + 1, diagonal + cost);
      diagonal = temp;
    }
  }
  const distance = prev[second.length]!;
  const levenshteinRatio = 1 - distance / Math.max(first.length, second.length);
  const lcs = lcsLength(first, second);
  const diceLcsRatio = (2 * lcs) / (first.length + second.length);
  const overlapRatio = lcs / Math.min(first.length, second.length);
  return Math.max(levenshteinRatio, (diceLcsRatio + overlapRatio) / 2);
}

export const SIMILARITY_THRESHOLD = 0.8;

function canonicalizeUrls(value: string): string {
  return value.replace(/https?:\/\/(?:www\.)?(?:youtu\.be\/([a-zA-Z0-9_-]+)|youtube\.com\/watch\?[^\s]*v=([a-zA-Z0-9_-]+))[^\s]*/g, (_, shortId, watchId) => `https://youtu.be/${shortId ?? watchId}`);
}

export function isExactReply(a: string, b: string): boolean {
  const clean = (v: string) =>
    canonicalizeUrls(v.normalize('NFC'))
      .replace(/[\uFE0E\uFE0F]/g, '')
      .replace(/@(\S+)\s+/g, '$1')
      .replace(/@(\S+)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  return Boolean(clean(a)) && clean(a) === clean(b);
}

export function isSimilarReply(a: string, b: string, threshold = SIMILARITY_THRESHOLD): boolean {
  return replySimilarity(a, b) >= threshold;
}
