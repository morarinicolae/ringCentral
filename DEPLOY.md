# Deploy to your own server (Docker + automatic HTTPS)

This gets the router live on a public HTTPS URL so RingCentral can push
**real-time** SMS **and call** events (webhooks), and so the admin panel is
reachable from your browser.

## Prerequisites
- A server (VPS) with a public IP, ports **80** and **443** open.
- A **domain/subdomain** (e.g. `router.yourcompany.com`) with a DNS **A record**
  pointing at the server's IP.
- Docker + Docker Compose installed on the server.

## 1. Get the code + configure
```bash
git clone https://github.com/morarinicolae/ringCentral.git
cd ringCentral
cp .env.example .env
nano .env     # fill in the values (see below)
```

Set at least these in `.env`:
```
APP_DOMAIN=router.yourcompany.com        # your domain (Caddy issues HTTPS for it)
APP_BASE_URL=https://router.yourcompany.com

TEST_MODE=false
ALLOW_REAL_SMS=true
RINGCENTRAL_USE_A2P=true                  # this account uses A2P/10DLC

RINGCENTRAL_CLIENT_ID=...
RINGCENTRAL_CLIENT_SECRET=...
RINGCENTRAL_SERVER_URL=https://platform.ringcentral.com
RINGCENTRAL_JWT=...
RINGCENTRAL_FROM_NUMBER=+1...             # the company SMS number

TELEGRAM_BOT_TOKEN=...
ADMIN_API_TOKEN=<a long random string>
ADMIN_TELEGRAM_IDS=...
```

## 2. Launch
```bash
docker compose up -d --build
```
Caddy automatically obtains a Let's Encrypt certificate for `APP_DOMAIN`.
Check it's up:
```bash
curl https://router.yourcompany.com/health
```

## 3. Register the webhooks (real-time)
Once the public URL responds:
```bash
# Telegram replies -> the bot webhook
docker compose exec app npm run set-telegram-webhook

# RingCentral inbound SMS -> our webhook
docker compose exec app npm run rc:subscribe -- create

# (Call events subscription is added when the call feature ships.)
```

Verify the RingCentral connection any time:
```bash
docker compose exec app npm run rc:test
```

## 4. Open the admin panel
`https://router.yourcompany.com/panel` — paste your `ADMIN_API_TOKEN`.

## Updating after code changes
```bash
git pull
docker compose up -d --build
```

## Notes
- **Database:** ships with SQLite on a Docker volume (`dbdata`) — fine for this
  scale and survives restarts. To move to PostgreSQL later, change the
  `provider` in `prisma/schema.prisma` to `postgresql`, point `DATABASE_URL` at a
  Postgres instance, and `docker compose up -d --build`.
- **Backups:** the SQLite DB is in the `dbdata` volume — snapshot it periodically
  (`docker run --rm -v ringcentral_dbdata:/d -v $PWD:/b alpine cp /d/prod.db /b/`).
- **Subscriptions expire** (~7 days for WebHook). A scheduled `rc:subscribe --
  renew <id>` (cron) keeps them alive; the app can also self-renew (added with
  the webhook feature).
