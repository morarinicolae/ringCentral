import { OPT_OUT_KEYWORDS } from '../constants';

// Match any opt-out keyword as a standalone, case-insensitive word. Word
// boundaries avoid false positives ("friend" must not match END).
const OPT_OUT_RE = new RegExp(`\\b(${OPT_OUT_KEYWORDS.join('|')})\\b`, 'i');

export function isOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPT_OUT_RE.test(text);
}
