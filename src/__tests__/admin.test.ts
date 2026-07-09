import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDb, seedSellers, inbound } from './helpers';
import { createServer } from '../server';
import { prisma } from '../db';

const app = createServer();
const ADMIN = 'test-admin-token';

describe('admin + HTTP endpoints', () => {
  let sellers: Awaited<ReturnType<typeof seedSellers>>;

  beforeEach(async () => {
    await resetDb();
    sellers = await seedSellers(3);
  });

  it('Test 12: admin can reassign a conversation to another seller', async () => {
    const a = await inbound('+15550000001', 'hi'); // Client A -> Seller 1
    expect(a.result.sellerId).toBe(sellers[0].id);

    const res = await request(app)
      .post('/admin/reassign-conversation')
      .set('x-admin-token', ADMIN)
      .send({ conversation_id: a.result.conversationId, new_seller_id: sellers[1].id });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const conv = await prisma.conversation.findUnique({ where: { id: a.result.conversationId } });
    const contact = await prisma.contact.findUnique({ where: { id: a.result.contactId } });
    expect(conv?.assignedSellerId).toBe(sellers[1].id);
    // Contact ownership also moves, so future messages route to the new seller.
    expect(contact?.assignedSellerId).toBe(sellers[1].id);

    // A subsequent inbound from Client A now goes to Seller 2.
    const again = await inbound('+15550000001', 'follow up');
    expect(again.result.sellerId).toBe(sellers[1].id);
  });

  it('admin endpoints reject requests without the admin token', async () => {
    const res = await request(app).get('/admin/conversations');
    expect(res.status).toBe(401);
  });

  it('GET /admin/conversations returns every conversation', async () => {
    await inbound('+15550000001', 'a');
    await inbound('+15550000002', 'b');
    const res = await request(app).get('/admin/conversations').set('x-admin-token', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it('POST /test/simulate-inbound-sms runs the full flow over HTTP', async () => {
    const res = await request(app)
      .post('/test/simulate-inbound-sms')
      .send({ from: '+15550000001', text: 'Hello, I need help' });
    expect(res.status).toBe(200);
    expect(res.body.result.is_new_contact).toBe(true);
    expect(res.body.result.assigned_seller_name).toBe('Seller 1');
    expect(res.body.result.seller_notified).toBe(true);
  });

  it('privacy: a seller only sees their OWN conversations', async () => {
    await inbound('+15550000001', 'A msg'); // Seller 1
    await inbound('+15550000002', 'B msg'); // Seller 2

    const s1 = await request(app).get('/seller/conversations').set('x-seller-id', sellers[0].id);
    const s2 = await request(app).get('/seller/conversations').set('x-seller-id', sellers[1].id);

    expect(s1.body.count).toBe(1);
    expect(s1.body.conversations[0].contact.phone).toBe('+15550000001');
    expect(s2.body.count).toBe(1);
    expect(s2.body.conversations[0].contact.phone).toBe('+15550000002');

    // Seller 1 must not see Client B anywhere in the payload.
    expect(JSON.stringify(s1.body)).not.toContain('+15550000002');
  });

  it('seller endpoints require a valid X-Seller-Id', async () => {
    const res = await request(app).get('/seller/conversations');
    expect(res.status).toBe(401);
  });

  it('admin can create and deactivate a seller', async () => {
    const create = await request(app)
      .post('/admin/sellers')
      .set('x-admin-token', ADMIN)
      .send({ name: 'Seller Four', telegram_user_id: '200004', priority: 40 });
    expect(create.status).toBe(201);
    const id = create.body.seller.id;

    const patch = await request(app).patch(`/admin/sellers/${id}`).set('x-admin-token', ADMIN).send({ is_active: false });
    expect(patch.status).toBe(200);
    expect(patch.body.seller.isActive).toBe(false);
  });
});
