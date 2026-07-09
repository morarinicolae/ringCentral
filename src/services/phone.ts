// E.164: a leading '+', a non-zero first digit, then up to 14 more digits.
const E164_RE = /^\+[1-9]\d{1,14}$/;

export function isValidE164(phone: string | null | undefined): phone is string {
  if (!phone) return false;
  return E164_RE.test(phone.trim());
}

/**
 * Best-effort normalization to E.164. Strips spaces, dashes, parentheses.
 * Does NOT guess a country code — if the input has no '+', it is returned
 * trimmed and will fail isValidE164 (we never fabricate a recipient number).
 */
export function normalizeE164(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Keep a leading '+', drop every other non-digit.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  return hasPlus ? `+${digits}` : digits;
}
