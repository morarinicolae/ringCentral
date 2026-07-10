import { config } from '../config';
import { prisma } from '../db';
import { logger, Decision } from '../logger';
import { isValidE164 } from './phone';
import { NON_SENDABLE_CONTACT_STATUSES } from '../constants';
import { SendSmsResult } from '../types';

// ---- RingCentral account resolution (per line) --------------------------

/** A single RingCentral account/connection (credentials + the number to send from). */
export interface RcConfig {
  clientId: string;
  clientSecret: string;
  jwt: string;
  username: string;
  extension: string;
  password: string;
  serverUrl: string;
  /** Inbound SMS live in the A2P message list (TCR/10DLC) vs classic store. */
  useA2p: boolean;
  /** Send via the A2P endpoint (default false — classic /sms works broadly). */
  sendA2p: boolean;
  fromNumber: string;
}

/** The account configured via the global RINGCENTRAL_* env vars. */
export function globalRcConfig(): RcConfig {
  const r = config.ringcentral;
  return {
    clientId: r.clientId,
    clientSecret: r.clientSecret,
    jwt: r.jwt,
    username: r.username,
    extension: r.extension,
    password: r.password,
    serverUrl: r.serverUrl,
    useA2p: r.useA2p,
    sendA2p: r.sendA2p,
    fromNumber: r.fromNumber,
  };
}

/** The subset of Line fields that carry a per-line RingCentral account. */
export interface LineRc {
  phoneE164: string;
  rcClientId?: string | null;
  rcClientSecret?: string | null;
  rcJwt?: string | null;
  rcServerUrl?: string | null;
  rcUseA2p?: boolean | null;
}

/**
 * The effective RingCentral account for a line: its OWN credentials when set,
 * otherwise the global env account. Either way the send-from number is the
 * line's own number.
 */
export function rcConfigForLine(line: LineRc | null | undefined): RcConfig {
  const g = globalRcConfig();
  if (!line) return g;
  const hasOwn = Boolean(line.rcClientId && line.rcJwt);
  if (!hasOwn) {
    return { ...g, fromNumber: line.phoneE164 || g.fromNumber };
  }
  return {
    clientId: line.rcClientId as string,
    clientSecret: line.rcClientSecret ?? '',
    jwt: line.rcJwt as string,
    username: '',
    extension: '',
    password: '',
    serverUrl: line.rcServerUrl || g.serverUrl,
    useA2p: line.rcUseA2p ?? g.useA2p,
    sendA2p: g.sendA2p,
    fromNumber: line.phoneE164,
  };
}

/** Stable key so tokens are cached per distinct account. */
export function rcAccountKey(rc: RcConfig): string {
  return `${rc.serverUrl}|${rc.clientId}|${rc.jwt ? 'jwt' : `pw:${rc.username}`}`;
}

// ---- RingCentral OAuth token (per account) ------------------------------

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Get (and cache) an access token for a SPECIFIC RingCentral account. */
export async function getAccessTokenFor(rc: RcConfig): Promise<string> {
  const now = Date.now();
  const key = rcAccountKey(rc);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }

  const basic = Buffer.from(`${rc.clientId}:${rc.clientSecret}`).toString('base64');

  let body: URLSearchParams;
  if (rc.jwt) {
    // JWT bearer flow (recommended by RingCentral).
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: rc.jwt,
    });
  } else {
    // Password (ROPC) flow, matching the provided env vars.
    body = new URLSearchParams({
      grant_type: 'password',
      username: rc.username,
      extension: rc.extension,
      password: rc.password,
    });
  }

  const res = await fetch(`${rc.serverUrl}/restapi/oauth/token`, {
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
  tokenCache.set(key, {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/** Token for the global env account (used by diagnostics / single-account callers). */
export async function getAccessToken(): Promise<string> {
  return getAccessTokenFor(globalRcConfig());
}

// Account phone-number list cache: maps an extension NUMBER (e.g. "567") to one
// of its direct numbers — needed by RingOut, which only accepts real numbers.
let numListCache: { at: number; records: any[] } | null = null;
export async function getExtensionDirectNumber(extNumber: string, rc: RcConfig = globalRcConfig()): Promise<string | null> {
  try {
    if (!numListCache || Date.now() - numListCache.at > 600_000) {
      const token = await getAccessTokenFor(rc);
      const r = await fetch(`${rc.serverUrl}/restapi/v1.0/account/~/phone-number?perPage=1000`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) return null;
      numListCache = { at: Date.now(), records: j.records ?? [] };
    }
    const hit = numListCache.records.find(
      (n) => n?.usageType === 'DirectNumber' && n?.extension?.extensionNumber === extNumber,
    );
    return hit?.phoneNumber ?? null;
  } catch {
    return null;
  }
}

// The JWT user's own extension = the DISPATCHER extension calls land on before
// the app forwards them. Cached for an hour.
let ownExt: { id: string; at: number } | null = null;
export async function getOwnExtensionId(rc: RcConfig = globalRcConfig()): Promise<string | null> {
  if (ownExt && Date.now() - ownExt.at < 3_600_000) return ownExt.id;
  try {
    const token = await getAccessTokenFor(rc);
    const r = await fetch(`${rc.serverUrl}/restapi/v1.0/account/~/extension/~`, { headers: { Authorization: `Bearer ${token}` } });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && j.id) {
      ownExt = { id: String(j.id), at: Date.now() };
      return ownExt.id;
    }
  } catch {
    /* transient */
  }
  return null;
}

/** For tests: drop any cached token. */
export function _resetRingCentralToken(): void {
  tokenCache.clear();
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

async function postSmsOnce(rc: RcConfig, from: string, to: string, text: string): Promise<RawSendOutcome> {
  try {
    const token = await getAccessTokenFor(rc);
    // A2P High Volume SMS (for TCR/10DLC-registered accounts) uses a different
    // endpoint and body shape (to is an array of plain E.164 strings).
    const url = rc.sendA2p
      ? `${rc.serverUrl}/restapi/v1.0/account/~/a2p-sms/messages`
      : `${rc.serverUrl}/restapi/v1.0/account/~/extension/~/sms`;
    const body = rc.sendA2p
      ? { from, to: [to], text }
      : { from: { phoneNumber: from }, to: [{ phoneNumber: to }], text };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    include: { contact: true, line: true },
  });
  if (!conversation) {
    return fail('conversation_not_found', `Conversation ${conversationId} not found`);
  }
  // Send from the line's OWN RingCentral account (each number can be a separate
  // account); falls back to the global env account when the line has no creds.
  const rc = rcConfigForLine(conversation.line);
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
    last = await postSmsOnce(rc, from, to, text);
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
