import { config } from '../config';
import { getAccessToken } from './ringcentral';

// Helpers for connecting a RingCentral account: verifying credentials and
// managing the inbound-SMS webhook subscription. Kept separate from the hot
// send path in ringcentral.ts.

async function rcFetch(method: string, path: string, body?: unknown) {
  const token = await getAccessToken();
  const res = await fetch(`${config.ringcentral.serverUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export interface RcDiagnostic {
  ok: boolean;
  configured: boolean;
  authMethod: 'jwt' | 'password' | 'none';
  serverUrl: string;
  extension?: { name?: string; extensionNumber?: string };
  phoneNumbers?: string[];
  error?: string;
}

/** Verify credentials by authenticating and reading the extension + its numbers. */
export async function ringCentralDiagnostic(): Promise<RcDiagnostic> {
  const authMethod: RcDiagnostic['authMethod'] = config.ringcentral.jwt
    ? 'jwt'
    : config.ringcentral.username
      ? 'password'
      : 'none';
  const base: RcDiagnostic = {
    ok: false,
    configured: Boolean(config.ringcentral.clientId && config.ringcentral.clientSecret && authMethod !== 'none'),
    authMethod,
    serverUrl: config.ringcentral.serverUrl,
  };
  if (!base.configured) {
    return { ...base, error: 'RingCentral credentials are not fully configured in .env.' };
  }
  try {
    const ext = await rcFetch('GET', '/restapi/v1.0/account/~/extension/~');
    if (!ext.ok) {
      return { ...base, error: `Auth/extension check failed: HTTP ${ext.status} ${JSON.stringify(ext.json)}` };
    }
    const e = ext.json as { name?: string; extensionNumber?: string };
    // Phone numbers assigned to this extension (which of them are SMS-capable).
    const nums = await rcFetch('GET', '/restapi/v1.0/account/~/extension/~/phone-number');
    const phoneNumbers = ((nums.json as { records?: any[] }).records ?? [])
      .filter((r) => (r.features ?? []).includes('SmsSender') || (r.features ?? []).includes('Sms'))
      .map((r) => r.phoneNumber);
    return {
      ...base,
      ok: true,
      extension: { name: e.name, extensionNumber: e.extensionNumber },
      phoneNumbers,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

const SMS_EVENT_FILTER = '/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS';

/**
 * Create the inbound-SMS webhook subscription. RingCentral will POST the FULL
 * SMS (from/to/text inline) to APP_BASE_URL/webhooks/ringcentral/sms whenever an
 * SMS arrives. Requires a public APP_BASE_URL.
 *
 * NOTE: subscriptions expire (~7 days for WebHook). Re-run to refresh, or renew
 * before expiry (see renewSubscription).
 */
export async function createInboundSmsSubscription(webhookUrl: string) {
  return rcFetch('POST', '/restapi/v1.0/subscription', {
    eventFilters: [SMS_EVENT_FILTER],
    deliveryMode: { transportType: 'WebHook', address: webhookUrl },
    expiresIn: 604800, // 7 days (max for WebHook)
  });
}

export async function listSubscriptions() {
  return rcFetch('GET', '/restapi/v1.0/subscription');
}

export async function deleteSubscription(id: string) {
  return rcFetch('DELETE', `/restapi/v1.0/subscription/${id}`);
}

export async function renewSubscription(id: string) {
  return rcFetch('POST', `/restapi/v1.0/subscription/${id}/renew`);
}
