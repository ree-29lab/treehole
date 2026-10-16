/**
 * Text intake rules.
 *
 * Two different jobs, deliberately kept apart:
 * - crisis content is *folded*, never rejected: someone writing "不想活了" needs the
 *   hotline, not a bounced form.
 * - blocked patterns (contact details, doxxing, ads) are rejected before storage.
 * Profanity is not filtered — venting is what a 树洞 is for — it is handled by reports.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Normalize whitespace and drop control characters. Returns the storable text. */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Length in code points, so emoji count as one. */
export function charLength(text) {
  return Array.from(text).length;
}

/** @returns {{why: string}|null} the first blocked pattern that matches */
export function findBlocked(text, patterns) {
  for (const pattern of patterns) {
    if (new RegExp(pattern.re, 'i').test(text)) return { why: pattern.why };
  }
  return null;
}

/** True when the text should start folded with the hotline banner on top. */
export function hasCrisisContent(text, crisisWords) {
  return crisisWords.some((word) => text.includes(word));
}

/** Validate one submission. Returns `{ ok: true, text }` or `{ ok: false, message, code }`. */
export function validateBody(rawInput, { maxChars, patterns, crisisWords }) {
  const text = normalizeText(rawInput);
  if (!text) return { ok: false, code: 'empty', message: '内容是空的，写点什么再发吧。' };
  if (charLength(text) > maxChars) {
    return { ok: false, code: 'toolong', message: `太长了，最多 ${maxChars} 字。` };
  }
  const blocked = findBlocked(text, patterns);
  if (blocked) return { ok: false, code: 'blocked', message: `这条不能发：${blocked.why}。` };
  return { ok: true, text, crisis: hasCrisisContent(text, crisisWords) };
}
