import { Router } from 'express';
import { prisma } from '../db';
import { requireSeller } from '../middleware/auth';

export const sellerRouter = Router();
sellerRouter.use(requireSeller);

/**
 * GET /seller/conversations
 * Returns ONLY the authenticated seller's conversations (rule 7: a seller can
 * never see another seller's clients, messages, or assignments). The DB query
 * is hard-filtered by req.seller.id — there is no code path that returns another
 * seller's data.
 */
sellerRouter.get('/conversations', async (req, res) => {
  const sellerId = req.seller!.id;
  const conversations = await prisma.conversation.findMany({
    where: { assignedSellerId: sellerId },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json({
    seller_id: sellerId,
    count: conversations.length,
    conversations: conversations.map((c) => ({
      id: c.id,
      status: c.status,
      contact: { phone: c.contact.phoneE164, status: c.contact.status },
      last_message_at: c.lastMessageAt,
      last_message: c.messages[0]?.body ?? null,
    })),
  });
});

/**
 * GET /seller/conversations/:id/messages
 * Full message history for one of the seller's own conversations. Ownership is
 * enforced: a request for a conversation the seller doesn't own returns 404
 * (not 403) so existence isn't leaked.
 */
sellerRouter.get('/conversations/:id/messages', async (req, res) => {
  const sellerId = req.seller!.id;
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, assignedSellerId: sellerId },
  });
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    conversation_id: conversation.id,
    count: messages.length,
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      status: m.status,
      created_at: m.createdAt,
    })),
  });
});
