import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { RcConfig, getAccessTokenFor, globalRcConfig } from './ringcentral';

/**
 * Native sticky-through-the-queue: for every seller we maintain ONE custom
 * answering rule on the Call Queue extension — "callers = all of this seller's
 * clients -> TransferToExtension(seller)". RingCentral evaluates these rules
 * BEFORE queue distribution, so a known client rings their seller directly,
 * while new callers fall through to the queue's normal rotation.
 *
 * Requires the app scope `EditExtensions` and RINGCENTRAL_QUEUE_EXT_ID.
 */

const ruleName = (sellerExtId: string) => `router-${sellerExtId}`;

interface RuleListItem {
  id: string;
  name?: string;
  type?: string;
}

async function listCustomRules(rc: RcConfig, queueExtId: string): Promise<RuleListItem[]> {
  const token = await getAccessTokenFor(rc);
  const res = await fetch(
    `${rc.serverUrl}/restapi/v1.0/account/~/extension/${queueExtId}/answering-rule?type=Custom&perPage=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.error('queue_rules_list_failed', { status: res.status, raw: j });
    return [];
  }
  return j.records ?? [];
}

/**
 * Rebuild the queue rule for one seller from the DB (all their contacts'
 * numbers). Creates the rule if missing, updates it otherwise. Safe to call
 * after every ownership change; failures are logged, never thrown.
 */
export async function syncQueueRuleForSeller(sellerId: string): Promise<boolean> {
  const queueExtId = config.ringcentral.queueExtensionId;
  if (!queueExtId) return false; // queue mode not configured

  try {
    const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller?.ringcentralExtensionId) {
      logger.warn('queue_rule_seller_has_no_extension', { sellerId, sellerName: seller?.name });
      return false;
    }
    const contacts = await prisma.contact.findMany({
      where: { assignedSellerId: sellerId, status: { notIn: ['blocked'] } },
      select: { phoneE164: true },
    });
    if (contacts.length === 0) return false;

    const rc = globalRcConfig();
    const token = await getAccessTokenFor(rc);
    const body = {
      name: ruleName(seller.ringcentralExtensionId),
      type: 'Custom',
      enabled: true,
      callers: contacts.map((c) => ({ callerId: c.phoneE164 })),
      callHandlingAction: 'TransferToExtension',
      transfer: { extension: { id: seller.ringcentralExtensionId } },
    };

    const existing = (await listCustomRules(rc, queueExtId)).find((r) => r.name === body.name);
    const url = existing
      ? `${rc.serverUrl}/restapi/v1.0/account/~/extension/${queueExtId}/answering-rule/${existing.id}`
      : `${rc.serverUrl}/restapi/v1.0/account/~/extension/${queueExtId}/answering-rule`;
    const res = await fetch(url, {
      method: existing ? 'PUT' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error('queue_rule_sync_failed', { sellerId, status: res.status, clients: contacts.length, raw: JSON.stringify(raw).slice(0, 300) });
      return false;
    }
    logger.info('queue_rule_synced', { sellerId, sellerName: seller.name, rule: body.name, clients: contacts.length, created: !existing });
    return true;
  } catch (err) {
    logger.error('queue_rule_sync_error', { sellerId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Re-sync the rules of every active seller that has an extension mapped. */
export async function syncAllQueueRules(): Promise<void> {
  if (!config.ringcentral.queueExtensionId) return;
  const sellers = await prisma.seller.findMany({ where: { isActive: true, ringcentralExtensionId: { not: null } } });
  for (const s of sellers) await syncQueueRuleForSeller(s.id);
}
