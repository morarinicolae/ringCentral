import { config } from '../config';
import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { isValidE164 } from './phone';
import { NON_SENDABLE_CONTACT_STATUSES } from '../constants';
import { SendSmsResult } from '../types';

// ---- RingCentral OAuth token (only used for REAL sends) -----------------

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${config.ringcentral.clientId}:${config.ringcentral.clientSecret}`).toString('base64');

  let body: URLSearchParams;
  if (config.ringcentral.jwt) {
    // JWT bearer flow (recommended by RingCentral).
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: config.ringcentral.jwt,
    });
  } else {
    // Password (ROPC) flow, matching the provided env vars.
    body = new URLSearchParams({
      grant_type: 'password',
      username: config.ringcentral.username,
      extension: config.ringcentral.extension,
      password: config.ringcentral.password,
    });
  }

  const res = await fetch(`${config.ringcentral.serverUrl}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`RingCentral auth failed: ${json.error_description ?? res.status}`);
  }
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

/** For tests: drop any cached token. */
export function _resetRingCentralToken(): void {
  cachedToken = null;
}

// ---- Low-level SMS POST with bounded retry ------------------------------

interface RawSendOutcome {
  ok: boolean;
  ringcentralMessageId?: string;
  status?: number;
  raw: unknown;
  /** true if the error is worth retrying (network / 429 / 5xx). */
  retryable: boolean;
}

async function postSmsOnce(from: string, to: string, text: string): Promise<RawSendOutcome> {
  try {
    const token = await getAccessToken();
    const res = await fetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { phoneNumber: from },
        to: [{ phoneNumber: to }],
        text,
      }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, status: res.status, raw, retryable };
    }
    const messageId = (raw as { id?: number | string })?.id;
    return { ok: true, ringcentralMessageId: messageId != null ? String(messageId) : undefined, status: res.status, raw, retryable: false };
  } catch (err) {
    // Network-level error -> retryable.
    return { ok: false, raw: { error: err instanceof Error ? err.message : String(err) }, retryable: true };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Public sendSms with full ownership validation ----------------------

export interface SendSmsArgs {
  from: string;
  to: string;
  text: string;
  conversationId: string;
  sellerId: string;
}

/**
 * The single, safe entry point for sending an SMS to a client.
 *
 * Before anything leaves the building it re-verifies (rule 4 — defense in depth,
 * even though the reply handler already checked):
 *   - `to` and `from` are valid E.164
 *   - the conversation is assigned to `sellerId`
 *   - the contact belongs to `sellerId`
 *   - the contact status is not opt_out / blocked / closed
 * If any check fails, NO SMS is sent.
 *
 * Honors TEST_MODE: unless ALLOW_REAL_SMS is also true, it logs the payload and
 * returns status `test_sent` without calling RingCentral.
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const { from, to, text, conversationId, sellerId } = args;

  logger.info(Decision.OUTBOUND_ATTEMPTED, { conversationId, sellerId, to });

  // --- Validation gate ---
  if (!isValidE164(from) || !isValidE164(to)) {
    return fail('invalid_phone', `Invalid E.164 number (from=${from}, to=${to})`);
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!conversation) {
    return fail('conversation_not_found', `Conversation ${conversationId} not found`);
  }
  if (conversation.assignedSellerId !== sellerId) {
    return fail('ownership_conversation', 'Seller does not own this conversation');
  }
  const contact = conversation.contact;
  if (!contact || contact.assignedSellerId !== sellerId) {
    return fail('ownership_contact', 'Contact does not belong to this seller');
  }
  if (NON_SENDABLE_CONTACT_STATUSES.includes(contact.status as never)) {
    return fail(`contact_${contact.status}`, `Contact status is ${contact.status}`, 'blocked');
  }
  if (contact.phoneE164 !== to) {
    return fail('recipient_mismatch', 'Target number does not match the contact on file');
  }

  // --- TEST_MODE short-circuit ---
  if (config.testMode && !config.allowRealSms) {
    logger.info('sms_test_mode_logged', { conversationId, sellerId, from, to, text });
    return { ok: true, status: 'test_sent', testMode: true, raw: { testMode: true, from, to, text } };
  }

  // --- Real send with bounded exponential backoff ---
  const maxAttempts = Math.max(1, config.smsMaxRetries);
  let last: RawSendOutcome | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await postSmsOnce(from, to, text);
    if (last.ok) {
      logger.info(Decision.OUTBOUND_SENT, { conversationId, sellerId, to, ringcentralMessageId: last.ringcentralMessageId });
      return { ok: true, status: 'sent', ringcentralMessageId: last.ringcentralMessageId, raw: last.raw };
    }
    if (!last.retryable || attempt === maxAttempts) break;
    const backoff = config.smsRetryBaseMs * 2 ** (attempt - 1);
    logger.warn('sms_retry', { conversationId, attempt, backoffMs: backoff, status: last.status });
    await sleep(backoff);
  }

  const reason = `RingCentral send failed${last?.status ? ` (HTTP ${last.status})` : ''}`;
  logger.error(Decision.OUTBOUND_FAILED, { conversationId, sellerId, to, reason, raw: last?.raw });
  return { ok: false, status: 'failed', failureReason: reason, raw: last?.raw };

  function fail(code: string, message: string, status: SendSmsResult['status'] = 'failed'): SendSmsResult {
    logger.warn(Decision.OUTBOUND_FAILED, { conversationId, sellerId, to, reason: code, message });
    return { ok: false, status, failureReason: `${code}: ${message}` };
  }
}
