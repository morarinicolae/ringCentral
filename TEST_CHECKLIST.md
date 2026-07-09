# Test checklist — proof that distribution works

Two ways to prove it: the **automated suite** (fast, no services) and the
**manual HTTP walkthrough** (drives the real endpoints in TEST_MODE).

---

## A. Automated suite

```bash

npm install
npm test
```

Expected: **all tests pass**. Coverage maps 1:1 to the required behaviors:

| # | Required behavior | Test file |
|---|-------------------|-----------|
| 1 | New client → Seller 1 | `routing.test.ts` |
| 2 | Second new client → Seller 2 | `routing.test.ts` |
| 3 | Third new client → Seller 3, fourth wraps to Seller 1 | `routing.test.ts` |
| 4 | Existing client always → same seller (no re-route) | `routing.test.ts` |
| 5 | Duplicate RC webhook → no duplicate Telegram message | `idempotency.test.ts` |
| 6 | Seller cannot reply to another seller's conversation | `reply.test.ts` |
| 7 | Seller free-text without reply context is blocked | `reply.test.ts` |
| 8 | STOP marks contact `opt_out` | `optout.test.ts` |
| 9 | Seller cannot SMS an opted-out contact | `optout.test.ts` |
| 10 | RC send failure saved + seller notified | `sendsms.test.ts` |
| 11 | TEST_MODE sends no real SMS (no network) | `sendsms.test.ts` |
| 12 | Admin can reassign a conversation | `admin.test.ts` |

Plus: seller-privacy isolation, round-robin skipping inactive sellers, opt-out
word-boundary matching, recipient-mismatch and ownership guards in `sendSms()`.

---

## B. Manual HTTP walkthrough (TEST_MODE)

```bash
npm run db:push && npm run seed && npm run dev
```

The seed creates **Seller One** (priority 10), **Seller Two** (20),
**Seller Three** (30) — round-robin order is One → Two → Three.

Set a couple of shell vars from `GET /admin/sellers` for the reassply step:

```bash
curl -s localhost:3000/admin/sellers -H 'x-admin-token: change-me-admin-token'
```

### Test 1 — Client A → Seller One
```bash
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000001","text":"Hello, I need help"}'
# → assigned_seller_name: "Seller One", is_new_contact: true, seller_notified: true
```

### Test 2 — Client B → Seller Two
```bash
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000002","text":"Hi there"}'
# → assigned_seller_name: "Seller Two"
```

### Test 3 — Client C → Seller Three
```bash
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000003","text":"Do you have stock?"}'
# → assigned_seller_name: "Seller Three"
```

### Test 4 — Client A again → STILL Seller One
```bash
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000001","text":"Another question"}'
# → assigned_seller_name: "Seller One", is_new_contact: false
```

### Test 5 — Seller Two replies → SMS prepared only for Client B
Find Client B's Telegram notification id (`GET /admin/conversations` shows the
conversation; the notification message id is on the inbound message). With the
in-memory mock the first three notifications are ids `1001`, `1002`, `1003`.
```bash
curl -s -X POST localhost:3000/webhooks/telegram -H 'content-type: application/json' -d '{
  "update_id": 5001,
  "message": {
    "message_id": 9001,
    "from": { "id": 1000002, "type": "private" },
    "chat": { "id": 1000002, "type": "private" },
    "text": "Yes, in stock!",
    "reply_to_message": { "message_id": 1002 }
  }
}'
# → {"ok":true,"outcome":"test_sent"}  (outbound saved test_sent, owned by Seller Two, for Client B)
```
> `1000002` is Seller Two's seeded `telegram_user_id`; `1002` is Client B's
> notification. In TEST_MODE the confirmation reads
> “TEST MODE: SMS was not sent. Payload was logged.”

### Test 6 — Seller One must NOT be able to reply to Client B
```bash
curl -s -X POST localhost:3000/webhooks/telegram -H 'content-type: application/json' -d '{
  "update_id": 5002,
  "message": {
    "message_id": 9002,
    "from": { "id": 1000001 },
    "chat": { "id": 1000001, "type": "private" },
    "text": "I will take this",
    "reply_to_message": { "message_id": 1002 }
  }
}'
# → {"ok":true,"outcome":"unknown_context"}  — Seller One's chat can't resolve
#   Seller Two's notification (Telegram message ids are per-chat). Nothing sent.
```
> The ownership guard itself (outcome `blocked_ownership` + an
> `unauthorized_reply_blocked` audit row) is proven in `reply.test.ts` using a
> reassignment scenario, where a stale notification in Seller One's chat resolves
> to a conversation now owned by Seller Two.

### Test 7 — Duplicate webhook for Client A → no duplicate notification
```bash
# Send the SAME body twice; the second is deduped.
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000001","text":"dup-test","timestamp":"2026-01-01T00:00:00Z"}'
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000001","text":"dup-test","timestamp":"2026-01-01T00:00:00Z"}'
# → first: webhook_status "processed"; second: webhook_status "duplicate"
```

### Test 8 — STOP from Client C → blocks future outbound
```bash
curl -s -X POST localhost:3000/test/simulate-inbound-sms \
  -H 'content-type: application/json' \
  -d '{"from":"+15550000003","text":"STOP"}'
# → opt_out: true. Now a Seller Three reply to Client C returns
#   {"outcome":"blocked_opt_out"} and no SMS is prepared.
```

---

## What "success" looks like

- New clients fan out 1 → 2 → 3 → 1 → … across active sellers.
- Returning clients always land on their original seller.
- Each seller only ever sees their own clients (`GET /seller/conversations`).
- No duplicate notifications on re-delivered webhooks.
- Replies only go out when the seller owns the conversation and the contact is
  sendable; everything else is blocked with a clear message and logged.
- With `TEST_MODE=true`, not a single real SMS leaves the system.
