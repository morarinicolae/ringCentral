import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { logger } from '../logger';
import { ringCentralDiagnostic } from '../services/ringcentral-connect';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/** GET /admin/ringcentral/test — verify RingCentral credentials + list SMS numbers. */
adminRouter.get('/ringcentral/test', async (_req, res) => {
  res.json(await ringCentralDiagnostic());
});

/** GET /admin/conversations — admin sees everything. */
adminRouter.get('/conversations', async (_req, res) => {
  const conversations = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    include: {
      contact: true,
      seller: true,
      line: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json({
    count: conversations.length,
    conversations: conversations.map((c) => ({
      id: c.id,
      status: c.status,
      line: c.line ? { id: c.line.id, name: c.line.name, phone: c.line.phoneE164 } : null,
      contact: { id: c.contact.id, phone: c.contact.phoneE164, status: c.contact.status },
      seller: c.seller ? { id: c.seller.id, name: c.seller.name } : null,
      last_message_at: c.lastMessageAt,
      last_message: c.messages[0]?.body ?? null,
    })),
  });
});

/** GET /admin/calls — all calls (admin). */
adminRouter.get('/calls', async (_req, res) => {
  const calls = await prisma.call.findMany({
    orderBy: { startedAt: 'desc' },
    take: 200,
    include: { contact: true, seller: true, line: true },
  });
  res.json({
    count: calls.length,
    calls: calls.map((c) => ({
      id: c.id,
      line: c.line ? { name: c.line.name, phone: c.line.phoneE164 } : null,
      client: c.contact.phoneE164,
      seller: c.seller ? { id: c.seller.id, name: c.seller.name } : null,
      direction: c.direction,
      result: c.result,
      duration_sec: c.durationSec,
      started_at: c.startedAt,
    })),
  });
});

/** GET /admin/lines — list lines with their seller count. */
adminRouter.get('/lines', async (_req, res) => {
  const lines = await prisma.line.findMany({
    orderBy: { createdAt: 'asc' },
    include: { sellers: true },
  });
  res.json({
    count: lines.length,
    lines: lines.map((l) => ({
      id: l.id,
      name: l.name,
      phone: l.phoneE164,
      is_active: l.isActive,
      // RingCentral account status — never echo the secret/JWT back.
      rc_configured: Boolean(l.rcClientId && l.rcJwt),
      rc_server_url: l.rcServerUrl,
      rc_use_a2p: l.rcUseA2p,
      sellers: l.sellers.map((s) => ({ id: s.id, name: s.name, is_active: s.isActive })),
    })),
  });
});

/** POST /admin/lines — create a line (a company number + its own RC account + team). */
const RcFields = {
  rc_client_id: z.string().nullable().optional(),
  rc_client_secret: z.string().nullable().optional(),
  rc_jwt: z.string().nullable().optional(),
  rc_server_url: z.string().nullable().optional(),
  rc_use_a2p: z.boolean().nullable().optional(),
};
const CreateLineSchema = z.object({
  phone_e164: z.string().min(3),
  name: z.string().min(1),
  is_active: z.boolean().optional(),
  ...RcFields,
});
// Map snake_case RC fields to the Prisma columns (only those actually provided).
function rcData(d: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (d.rc_client_id !== undefined) out.rcClientId = d.rc_client_id;
  if (d.rc_client_secret !== undefined) out.rcClientSecret = d.rc_client_secret;
  if (d.rc_jwt !== undefined) out.rcJwt = d.rc_jwt;
  if (d.rc_server_url !== undefined) out.rcServerUrl = d.rc_server_url;
  if (d.rc_use_a2p !== undefined) out.rcUseA2p = d.rc_use_a2p;
  return out;
}
adminRouter.post('/lines', async (req, res) => {
  const parsed = CreateLineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    const line = await prisma.line.create({
      data: { phoneE164: d.phone_e164, name: d.name, isActive: d.is_active ?? true, ...rcData(d) },
    });
    await prisma.routingState.create({ data: { lineId: line.id, mode: 'round_robin' } });
    await writeAudit({ actorType: 'admin', action: 'line_created', entityType: 'line', entityId: line.id, details: { name: line.name, phone: line.phoneE164, rc: Boolean(line.rcClientId) } });
    res.status(201).json({ ok: true, line: { id: line.id, name: line.name, phone: line.phoneE164 } });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      res.status(409).json({ error: 'line_number_taken' });
      return;
    }
    throw err;
  }
});

/** PATCH /admin/lines/:id — edit a line: name, active state, and/or RC account. */
const UpdateLineSchema = z.object({
  name: z.string().min(1).optional(),
  phone_e164: z.string().min(3).optional(),
  is_active: z.boolean().optional(),
  ...RcFields,
});
adminRouter.patch('/lines/:id', async (req, res) => {
  const parsed = UpdateLineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.line.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: 'line_not_found' });
    return;
  }
  const d = parsed.data;
  try {
    const line = await prisma.line.update({
      where: { id: req.params.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.phone_e164 !== undefined ? { phoneE164: d.phone_e164 } : {}),
        ...(d.is_active !== undefined ? { isActive: d.is_active } : {}),
        ...rcData(d),
      },
    });
    await writeAudit({ actorType: 'admin', action: 'line_updated', entityType: 'line', entityId: line.id, details: { name: line.name, rc: Boolean(line.rcClientId) } });
    res.json({ ok: true, line: { id: line.id, name: line.name, phone: line.phoneE164, rc_configured: Boolean(line.rcClientId && line.rcJwt) } });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      res.status(409).json({ error: 'line_number_taken' });
      return;
    }
    throw err;
  }
});

/** POST /admin/reassign-conversation — move a conversation to another seller. */
const ReassignSchema = z.object({
  conversation_id: z.string().min(1),
  new_seller_id: z.string().min(1),
});
adminRouter.post('/reassign-conversation', async (req, res) => {
  const parsed = ReassignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { conversation_id, new_seller_id } = parsed.data;

  const conversation = await prisma.conversation.findUnique({ where: { id: conversation_id } });
  if (!conversation) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  const seller = await prisma.seller.findUnique({ where: { id: new_seller_id } });
  if (!seller) {
    res.status(404).json({ error: 'seller_not_found' });
    return;
  }

  const previousSellerId = conversation.assignedSellerId;
  // Move BOTH the conversation and the contact so future inbound messages from
  // the same number also route to the new seller (ownership stays consistent).
  await prisma.$transaction([
    prisma.conversation.update({ where: { id: conversation_id }, data: { assignedSellerId: new_seller_id } }),
    prisma.contact.update({ where: { id: conversation.contactId }, data: { assignedSellerId: new_seller_id } }),
  ]);
  await writeAudit({
    actorType: 'admin',
    action: 'conversation_reassigned',
    entityType: 'conversation',
    entityId: conversation_id,
    details: { from: previousSellerId, to: new_seller_id },
  });
  logger.info('conversation_reassigned', { conversationId: conversation_id, from: previousSellerId, to: new_seller_id });

  res.json({ ok: true, conversation_id, previous_seller_id: previousSellerId, new_seller_id });
});

/** POST /admin/sellers — create a seller (optionally on a line/team). */
const CreateSellerSchema = z.object({
  name: z.string().min(1),
  telegram_user_id: z.string().min(1).optional(),
  ringcentral_extension_id: z.string().optional(),
  line_id: z.string().min(1).optional(),
  // Forum topic (message_thread_id) for this line inside the seller's group.
  telegram_topic_id: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().optional(),
});
adminRouter.post('/sellers', async (req, res) => {
  const parsed = CreateSellerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  try {
    const seller = await prisma.seller.create({
      data: {
        name: d.name,
        telegramUserId: d.telegram_user_id ?? null,
        ringcentralExtensionId: d.ringcentral_extension_id ?? null,
        lineId: d.line_id ?? null,
        isActive: d.is_active ?? true,
        priority: d.priority ?? 100,
      },
    });
    // If placed on a line, record the membership (source of truth for round-robin
    // + the per-number topic).
    if (d.line_id) {
      await prisma.sellerLine.create({
        data: { sellerId: seller.id, lineId: d.line_id, telegramTopicId: d.telegram_topic_id ?? null, priority: d.priority ?? 100, isActive: d.is_active ?? true },
      });
    }
    await writeAudit({ actorType: 'admin', action: 'seller_created', entityType: 'seller', entityId: seller.id, details: { name: seller.name } });
    res.status(201).json({ ok: true, seller });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      res.status(409).json({ error: 'telegram_user_id_taken' });
      return;
    }
    throw err;
  }
});

/**
 * POST /admin/seller-lines — put a seller on a line (a company number) and set
 * the forum topic their inbound from that number lands in. Idempotent (upsert on
 * seller+line). This is how one seller serves several numbers, each in its own
 * topic inside their group.
 */
const SellerLineSchema = z.object({
  seller_id: z.string().min(1),
  line_id: z.string().min(1),
  telegram_topic_id: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  is_active: z.boolean().optional(),
});
adminRouter.post('/seller-lines', async (req, res) => {
  const parsed = SellerLineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const seller = await prisma.seller.findUnique({ where: { id: d.seller_id } });
  const line = await prisma.line.findUnique({ where: { id: d.line_id } });
  if (!seller || !line) {
    res.status(404).json({ error: !seller ? 'seller_not_found' : 'line_not_found' });
    return;
  }
  const membership = await prisma.sellerLine.upsert({
    where: { sellerId_lineId: { sellerId: d.seller_id, lineId: d.line_id } },
    update: {
      ...(d.telegram_topic_id !== undefined ? { telegramTopicId: d.telegram_topic_id } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
      ...(d.is_active !== undefined ? { isActive: d.is_active } : {}),
    },
    create: {
      sellerId: d.seller_id,
      lineId: d.line_id,
      telegramTopicId: d.telegram_topic_id ?? null,
      priority: d.priority ?? 100,
      isActive: d.is_active ?? true,
    },
  });
  await writeAudit({ actorType: 'admin', action: 'seller_line_set', entityType: 'seller', entityId: d.seller_id, details: { lineId: d.line_id, topic: membership.telegramTopicId } });
  res.status(201).json({ ok: true, seller_line: membership });
});

/** DELETE /admin/seller-lines — remove a seller from a line. */
adminRouter.delete('/seller-lines', async (req, res) => {
  const parsed = z.object({ seller_id: z.string().min(1), line_id: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { seller_id, line_id } = parsed.data;
  await prisma.sellerLine.deleteMany({ where: { sellerId: seller_id, lineId: line_id } });
  await writeAudit({ actorType: 'admin', action: 'seller_line_removed', entityType: 'seller', entityId: seller_id, details: { lineId: line_id } });
  res.json({ ok: true });
});

/** PATCH /admin/sellers/:id — edit / activate / deactivate. */
const UpdateSellerSchema = z.object({
  name: z.string().min(1).optional(),
  telegram_user_id: z.string().min(1).nullable().optional(),
  ringcentral_extension_id: z.string().nullable().optional(),
  line_id: z.string().min(1).nullable().optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().optional(),
});
adminRouter.patch('/sellers/:id', async (req, res) => {
  const parsed = UpdateSellerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.seller.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: 'seller_not_found' });
    return;
  }
  const d = parsed.data;
  const seller = await prisma.seller.update({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.telegram_user_id !== undefined ? { telegramUserId: d.telegram_user_id } : {}),
      ...(d.ringcentral_extension_id !== undefined ? { ringcentralExtensionId: d.ringcentral_extension_id } : {}),
      ...(d.line_id !== undefined ? { lineId: d.line_id } : {}),
      ...(d.is_active !== undefined ? { isActive: d.is_active } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
    },
  });
  await writeAudit({ actorType: 'admin', action: 'seller_updated', entityType: 'seller', entityId: seller.id, details: d });
  res.json({ ok: true, seller });
});

/** GET /admin/sellers — list sellers with their line(s) + per-number topics. */
adminRouter.get('/sellers', async (_req, res) => {
  const sellers = await prisma.seller.findMany({
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    include: { line: true, sellerLines: { include: { line: true }, orderBy: { priority: 'asc' } } },
  });
  res.json({
    count: sellers.length,
    sellers: sellers.map((s) => ({
      id: s.id,
      name: s.name,
      telegramUserId: s.telegramUserId,
      isActive: s.isActive,
      priority: s.priority,
      line: s.line ? { id: s.line.id, name: s.line.name, phone: s.line.phoneE164 } : null,
      // Every number this seller serves + the forum topic each lands in.
      lines: s.sellerLines.map((m) => ({
        line_id: m.lineId,
        line_name: m.line.name,
        line_phone: m.line.phoneE164,
        telegram_topic_id: m.telegramTopicId,
        priority: m.priority,
        is_active: m.isActive,
      })),
    })),
  });
});

/**
 * POST /admin/reconcile-recent-sms — STUB.
 *
 * Intended to fetch recent RingCentral messages via the Message Store API and
 * compare against local `messages` to catch anything a dropped webhook missed
 * (rule: don't lose events). Structure exists; the fetch is a TODO because it
 * depends on a live RingCentral connection.
 */
adminRouter.post('/reconcile-recent-sms', async (_req, res) => {
  // TODO: authenticate to RingCentral, GET
  //   /restapi/v1.0/account/~/extension/~/message-store?direction=Inbound&dateFrom=...
  // then for each returned message, upsert a `messages` row keyed by
  // ringcentralMessageId (reusing processInboundSms for any that are missing).
  logger.info('reconcile_recent_sms_stub_invoked');
  const localRecent = await prisma.message.count({ where: { direction: 'inbound' } });
  res.json({
    ok: true,
    stub: true,
    message: 'Reconciliation is a stub. See TODO in src/routes/admin.ts.',
    local_inbound_message_count: localRecent,
    todo: [
      'Fetch recent messages from RingCentral Message Store API',
      'Diff against local messages by ringcentral_message_id',
      'Ingest any missing inbound messages via processInboundSms',
    ],
  });
});
