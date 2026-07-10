import { RcConfig, getAccessTokenFor, globalRcConfig } from './ringcentral';
import { logger } from '../logger';

/**
 * RingCentral Call Control — live inbound call handling.
 *
 * Flow: subscribe to /account/~/telephony/sessions webhooks -> on an inbound
 * ringing party, look up the sticky seller and FORWARD the call to their phone
 * (rings them while the caller waits). No audio passes through this server.
 */

/** Forward a still-ringing inbound party to an external phone number. */
export async function forwardCall(
  rc: RcConfig,
  sessionId: string,
  partyId: string,
  phoneNumber: string,
): Promise<{ ok: boolean; status?: number; raw?: unknown }> {
  try {
    const token = await getAccessTokenFor(rc);
    const res = await fetch(
      `${rc.serverUrl}/restapi/v1.0/account/~/telephony/sessions/${sessionId}/parties/${partyId}/forward`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      },
    );
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error('call_forward_failed', { sessionId, partyId, to: phoneNumber, status: res.status, raw });
      return { ok: false, status: res.status, raw };
    }
    logger.info('call_forwarded', { sessionId, partyId, to: phoneNumber });
    return { ok: true, raw };
  } catch (err) {
    logger.error('call_forward_error', { sessionId, partyId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
}

/** Create a webhook subscription for inbound telephony sessions on an account. */
export async function createTelephonySubscription(
  webhookUrl: string,
  rc: RcConfig = globalRcConfig(),
): Promise<{ ok: boolean; status: number; raw: any }> {
  const token = await getAccessTokenFor(rc);
  const res = await fetch(`${rc.serverUrl}/restapi/v1.0/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventFilters: ['/restapi/v1.0/account/~/telephony/sessions'],
      deliveryMode: { transportType: 'WebHook', address: webhookUrl },
      expiresIn: 604800, // 7 days (max); renew before expiry
    }),
  });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok) logger.error('telephony_subscribe_failed', { status: res.status, raw });
  else logger.info('telephony_subscribed', { id: raw.id, webhookUrl, expiresIn: raw.expiresIn });
  return { ok: res.ok, status: res.status, raw };
}

/** List active subscriptions on an account. */
export async function listSubscriptions(rc: RcConfig = globalRcConfig()): Promise<any> {
  const token = await getAccessTokenFor(rc);
  const res = await fetch(`${rc.serverUrl}/restapi/v1.0/subscription`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json().catch(() => ({}));
}

/** Delete a subscription by id. */
export async function deleteSubscription(id: string, rc: RcConfig = globalRcConfig()): Promise<boolean> {
  const token = await getAccessTokenFor(rc);
  const res = await fetch(`${rc.serverUrl}/restapi/v1.0/subscription/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/**
 * Ensure exactly one active telephony webhook subscription to `webhookUrl`
 * exists and isn't about to expire. Self-healing: safe to call on a schedule.
 * Recreates when missing or expiring within 2 days (RingCentral webhook subs
 * cap at ~7 days, so they must be refreshed).
 */
export async function ensureTelephonySubscription(
  webhookUrl: string,
  rc: RcConfig = globalRcConfig(),
): Promise<{ ok: boolean; created: boolean; id?: string }> {
  try {
    const subs = await listSubscriptions(rc);
    const records: any[] = subs?.records ?? [];
    const mine = records.filter(
      (s) =>
        s?.status === 'Active' &&
        s?.deliveryMode?.address === webhookUrl &&
        (s?.eventFilters ?? []).some((f: string) => f.includes('telephony/sessions')),
    );
    const soon = Date.now() + 2 * 24 * 3600 * 1000;
    const healthy = mine.find((s) => !s.expirationTime || new Date(s.expirationTime).getTime() > soon);
    if (healthy) return { ok: true, created: false, id: healthy.id };
    // Clean up any expiring/duplicate ones to our URL, then create fresh.
    for (const s of mine) await deleteSubscription(s.id, rc).catch(() => {});
    const created = await createTelephonySubscription(webhookUrl, rc);
    return { ok: created.ok, created: true, id: created.raw?.id };
  } catch (err) {
    logger.error('ensure_subscription_error', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, created: false };
  }
}

/** Renew a subscription (extend expiry). */
export async function renewSubscription(id: string, rc: RcConfig = globalRcConfig()): Promise<{ ok: boolean; raw: any }> {
  const token = await getAccessTokenFor(rc);
  const res = await fetch(`${rc.serverUrl}/restapi/v1.0/subscription/${id}/renew`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = await res.json().catch(() => ({}));
  return { ok: res.ok, raw };
}
