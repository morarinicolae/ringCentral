# SMS Router — private RingCentral ⇄ Telegram distribution tool

A small, stable, **private** message router. Incoming SMS to a company
RingCentral number are assigned to one salesperson via **round-robin**, forwarded
**privately** to that seller on Telegram, and the seller's reply is sent back to
the client via RingCentral SMS.

> This is **not a CRM**. It is a message router with hard privacy and safety rules.

## Privacy guarantee

- A client phone number is **owned by exactly one seller**. It stays with that
  seller forever unless an **admin** reassigns it. New clients (and only new
  clients) are round-robined.
- A seller can **only** see and reply to **their own** conversations. There is no
  shared inbox, no group chat, no cross-seller visibility. Admins see everything.
- Sellers are notified in **private 1:1 Telegram chats** only — never a group.

## Tech

Node.js + TypeScript · Express · Prisma ORM · SQLite (local/testing) →
PostgreSQL (production) · RingCentral SMS REST · Telegram Bot API.

---

## Quick start (local, TEST_MODE)

```bash

npm install
cp .env.example .env          # defaults are already test-safe (TEST_MODE=true)

npx prisma generate           # generate the Prisma client
npm run db:push               # create the SQLite schema (prisma/dev.db)
npm run seed                  # seed 3 test sellers + routing_state

npm run dev                   # starts on http://localhost:3000 (or $PORT)
```

In `TEST_MODE=true` (the default) **no real SMS is ever sent** unless you also set
`ALLOW_REAL_SMS=true`. Outbound sends are logged and marked `test_sent`. Telegram
notifications still fire — and if `TELEGRAM_BOT_TOKEN` is empty they go to an
in-memory mock outbox so you can test the whole flow with zero credentials.

### Run the automated tests

```bash
npm test        # 30 tests (round-robin, idempotency, ownership, opt-out, ...)
```

Tests run against an isolated SQLite DB (`prisma/test.db`) that is created and
reset automatically — no external services required.

---

## Switching to PostgreSQL

1. In `prisma/schema.prisma`, change the datasource `provider` from `"sqlite"` to
   `"postgresql"`.
2. Set `DATABASE_URL` to your Postgres URL, e.g.
   `postgresql://user:pass@host:5432/sms_router?schema=public`.
3. `npx prisma migrate dev --name init` (or `npm run db:push`).

The schema uses **plain string columns** (no DB enums, no native arrays)
specifically so the same models work unchanged on both databases. Statuses and
directions are validated in the app layer (`src/types.ts`).

---

## Architecture

```
Client SMS ─▶ RingCentral ─▶ POST /webhooks/ringcentral/sms
                                     │  (store raw event first, dedupe)
                                     ▼
                            processInboundSms()
                    ┌────────────────┴───────────────┐
              existing contact?                  new contact?
              reuse its seller              round-robin next active seller
                    └────────────────┬───────────────┘
                                     ▼
                        save inbound message + open conversation
                                     ▼
                 private Telegram notification to the ASSIGNED seller
                                     │
        seller replies to that message ▼
                            POST /webhooks/telegram
                                     ▼
                            processSellerReply()
                     verify ownership + contact sendable
                                     ▼
                  sendSms()  (RingCentral, or test_sent in TEST_MODE)
                                     ▼
                 save outbound status + confirm to the seller
```

Key modules (`src/`):

| File | Responsibility |
|------|----------------|
| `services/ingest.ts` | Store raw webhook, webhook-level idempotency, parse RC payloads |
| `services/inbound.ts` | Contact lookup/create, round-robin, save message, notify seller |
| `services/routing.ts` | Round-robin next-active-seller selection (transactional) |
| `services/reply.ts` | Telegram reply → ownership/opt-out checks → outbound SMS |
| `services/ringcentral.ts` | `sendSms()` with validation gate, TEST_MODE, bounded retry |
| `services/telegram.ts` | Send/parse Telegram, in-memory mock outbox for tests |
| `services/optout.ts` | STOP/UNSUBSCRIBE/… detection |
| `services/audit.ts` | Append-only audit log |

---

## API endpoints

| Method & path | Auth | Purpose |
|---------------|------|---------|
| `POST /webhooks/ringcentral/sms` | RC validation token | Incoming SMS webhook |
| `POST /webhooks/telegram` | optional secret header | Telegram updates (seller replies) |
| `POST /test/simulate-inbound-sms` | none (only mounted in TEST_MODE) | Simulate an inbound SMS end-to-end |
| `GET  /admin/conversations` | `X-Admin-Token` | All conversations |
| `POST /admin/reassign-conversation` | `X-Admin-Token` | Move a conversation to another seller |
| `POST /admin/sellers` | `X-Admin-Token` | Create a seller |
| `PATCH /admin/sellers/:id` | `X-Admin-Token` | Edit / activate / deactivate a seller |
| `GET  /admin/sellers` | `X-Admin-Token` | List sellers |
| `POST /admin/reconcile-recent-sms` | `X-Admin-Token` | Reconciliation job (stub w/ TODO) |
| `GET  /seller/conversations` | `X-Seller-Id` | The seller's OWN conversations only |
| `GET  /seller/conversations/:id/messages` | `X-Seller-Id` | Message history for one owned conversation |
| `GET  /health` | none | Health / mode check |

**Auth (MVP):** admin endpoints require a shared `X-Admin-Token` (`ADMIN_API_TOKEN`).
Seller endpoints identify the seller via `X-Seller-Id`. This is intentionally
minimal for an internal tool — put real auth in front for production.

---

## Safety rules implemented

1. **Idempotency** — raw event stored first; deduped by `ringcentral_message_id`,
   or a deterministic `event_hash` of from/to/timestamp/body when no id. A
   duplicate webhook creates **no** second message and **no** second notification.
2. **Conversation ownership** — a number stays with its seller; only admins
   reassign. Round-robin runs **only for new clients**.
3. **Reply safety** — no blind replies. A reply must be a Telegram reply-to that
   resolves to a specific `conversation_id`. Free text → the bot asks the seller
   to reply to a specific client message. Nothing is guessed.
4. **Wrong-recipient protection** — before sending, `sendSms()` re-verifies
   seller↔conversation ownership, contact↔seller ownership, contact status, and
   E.164 validity. Any failure blocks the send.
5. **Opt-out** — STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT mark the
   contact `opt_out`; further outbound is blocked with a clear message.
6. **Delivery failure** — RC errors are saved as `failed` and reported to the
   seller. Temporary errors retry ≤3× with exponential backoff; permanent errors
   do not retry.
7. **Privacy** — seller data access is hard-filtered by seller id.
8. **Logging** — every important decision is logged (see `logger.ts` `Decision`)
   and the sensitive ones are also written to `audit_logs`.
9. **Test mode** — `TEST_MODE=true` blocks real SMS unless `ALLOW_REAL_SMS=true`,
   still sends Telegram, exposes the simulate endpoint, and ships seed data.

---

## Production wiring (real credentials)

1. Fill `.env` with RingCentral + Telegram credentials, set `TEST_MODE=false`
   (and `ALLOW_REAL_SMS=true`), set a strong `ADMIN_API_TOKEN`, and set
   `ADMIN_TELEGRAM_IDS` to the admins' numeric Telegram ids.
2. Seed sellers with their **real** numeric Telegram user ids
   (`telegram_user_id`) — each seller must have started a chat with the bot.
3. Register the Telegram webhook: `npm run set-telegram-webhook`
   (uses `APP_BASE_URL` + `TELEGRAM_BOT_TOKEN`).
4. Create a RingCentral subscription (webhook) for inbound SMS pointing at
   `POST /webhooks/ringcentral/sms`. The route echoes the `Validation-Token`
   header for the subscription handshake.

See **[TEST_CHECKLIST.md](./TEST_CHECKLIST.md)** for the step-by-step proof that
distribution works.
