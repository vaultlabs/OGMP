# OGMP MM — Setup A to Z (baby steps)

Repo: **https://github.com/vaultlabs/OGMP**

> **Using GitHub Codespaces?** Use **[SETUP_CODESPACES.md](./SETUP_CODESPACES.md)** instead — all steps are from github.com / the browser cloud, not your PC.

This guide is for **your own server or PC** (VPS, Railway, Docker on desktop). For **real crypto** (NOWPayments) and **fully automated** seller payouts (2FA secret in `.env`).

---

## Part 0 — What you need before starting

| Item | Why |
|------|-----|
| A **server** or PC that stays online | Bot runs 24/7 (VPS, Railway, your PC, Codespaces for testing) |
| **HTTPS URL** on the internet | NOWPayments must call your webhooks (not `localhost`) |
| **Postgres** + **Redis** | Database + queues |
| **2 Telegram bots** | Main escrow + Report (cases) |
| **NOWPayments account** | Crypto pay-in + payouts |
| **Your Telegram numeric ID** | So you are admin |

---

## Part 1 — Get the code from GitHub

**On your server or PC (PowerShell / terminal):**

```bash
git clone https://github.com/vaultlabs/OGMP.git
cd OGMP
```

**Already cloned? Update:**

```bash
git pull origin main
```

---

## Part 2 — Create two Telegram bots (BotFather)

1. Open Telegram, search **@BotFather**, start chat.
2. Send: `/newbot`
3. Choose a **display name** (e.g. `OGMP Escrow`).
4. Choose a **username** ending in `bot` (e.g. `MyOgmpEscrow_bot`).
5. BotFather sends a **token** like `7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
6. **Copy it** — this is `MAIN_BOT_TOKEN`.

**Second bot (reports / cases):**

7. `/newbot` again → name e.g. `OGMP Report` → username e.g. `MyOgmpReport_bot`
8. Copy token → `OGMP_MM_REPORT_BOT_TOKEN`

**Optional:** In BotFather → your bot → **Bot Settings** → turn off privacy mode if the bot must read group messages (usually not needed for DMs).

---

## Part 3 — Get YOUR Telegram admin ID

1. Open **@userinfobot** or **@getidsbot** in Telegram.
2. Press **Start**.
3. It shows **Id:** `123456789` (numbers only).
4. That number is `ADMIN_IDS` in `.env`.

You can add more admins later with `/admin_add 987654321` inside your bot (no restart).

---

## Part 4 — Database and Redis

### Option A — Docker on your PC/server (easiest)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/), then in the project folder:

```bash
docker compose up -d postgres redis
```

Use in `.env`:

```env
DATABASE_URL=postgresql://ogmp:ogmp@localhost:5432/ogmp_mm?schema=public
REDIS_URL=redis://localhost:6379
```

*(If using Docker Compose service names on a remote host, host might be `postgres` / `redis` instead of `localhost`.)*

### Option B — Cloud Postgres + Redis

Use [Supabase](https://supabase.com), [Neon](https://neon.tech), [Railway](https://railway.app), etc. Copy their connection strings into `DATABASE_URL` and `REDIS_URL`.

---

## Part 5 — Create your `.env` file

**In the project folder:**

```bash
copy .env.example .env
```

(On Mac/Linux: `cp .env.example .env`)

Open `.env` in Notepad / VS Code and fill **one block at a time** below.

---

## Part 6 — Fill `.env` line by line

### 6.1 Core

| Variable | What to type | Where to get it |
|----------|--------------|-----------------|
| `NODE_ENV` | `production` | Type as-is |
| `DATABASE_URL` | Your Postgres URL | Part 4 |
| `REDIS_URL` | Your Redis URL | Part 4 |
| `MAIN_BOT_TOKEN` | Paste BotFather token | Part 2 (escrow bot) |
| `OGMP_MM_REPORT_BOT_TOKEN` | Paste second token | Part 2 (report bot) |
| `ADMIN_IDS` | Your numeric ID only | Part 3 (e.g. `584229127`) |
| `SERVER_PORT` | `8080` | Type as-is |

Leave empty unless you know you need them:

- `TELEGRAM_BOT_TOKEN` — leave empty if `MAIN_BOT_TOKEN` is set  
- `ADMIN_TELEGRAM_IDS` — leave empty  
- `BOT_PUBLIC_USERNAME` — optional  

---

### 6.2 Public URL (very important)

| Variable | Example | How |
|----------|---------|-----|
| `PUBLIC_BASE_URL` | `https://escrow.yourdomain.com` | **Must be HTTPS.** This is the address of the machine running the bot (port 8080 behind nginx/Caddy, or your host’s URL). **NOT** `http://localhost`. |

NOWPayments will call:

- `https://YOUR_DOMAIN/webhooks/payments/nowpayments`
- `https://YOUR_DOMAIN/webhooks/payouts/nowpayments`

**Test:** Open `https://YOUR_DOMAIN/health` in a browser — you should see `{"ok":true,...}` after the bot is running.

---

### 6.3 NOWPayments — payments IN (buyer pays)

| Variable | Where to get it |
|----------|-----------------|
| `PAYMENT_PROVIDER` | Type: `nowpayments` |
| `NOWPAYMENTS_API_KEY` | [account.nowpayments.io](https://account.nowpayments.io) → log in → **API** (or Store settings) → **Create / copy API key** |
| `NOWPAYMENTS_IPN_SECRET` | Same dashboard → **IPN Settings** → generate **IPN Secret** → paste here |
| `NOWPAYMENTS_API_BASE` | Leave **empty** |

**In NOWPayments dashboard — IPN callback URL:**

Set to: `https://YOUR_DOMAIN/webhooks/payments/nowpayments`

---

### 6.4 NOWPayments — payouts OUT (seller gets crypto)

You may log in with **Google** on the website. The bot still needs **email + API password** (not Google password).

#### Step A — API password

1. Go to https://account.nowpayments.io  
2. **Log out** if needed.  
3. On login page click **Reset password** (do not use Google for this step).  
4. Enter your **account email** (same email as Google account).  
5. Open email link → set a **new password** (save in password manager).

Put in `.env`:

```env
NOWPAYMENTS_EMAIL=you@gmail.com
NOWPAYMENTS_PASSWORD=the_password_you_just_set
```

#### Step B — 2FA secret (full automation)

1. Log in to NOWPayments (Google is fine).  
2. Go to **Account settings** (or Security).  
3. Enable **2FA** → choose **Google Authenticator**.  
4. On the QR screen, find the green box **Key: XXXXXXXXX** (or “Can’t scan?” → copy secret).  
5. On your phone: Google Authenticator → **+** → **Enter setup key** → paste same secret.  
6. On NOWPayments page: enter the **6-digit code** from the app → **Save / Enable** 2FA.

Put in `.env` (use **your** key from the green box, not an example):

```env
NOWPAYMENTS_2FA_SECRET=YOUR_KEY_FROM_GREEN_BOX
NOWPAYMENTS_PAYOUT_VERIFY_CODE=
```

Leave `NOWPAYMENTS_PAYOUT_VERIFY_CODE` **empty**.

Leave empty:

```env
NOWPAYMENTS_BEARER_TOKEN=
```

#### Step C — Enable payouts in dashboard

In NOWPayments:

- Enable **Custody** (if offered)  
- Enable **Mass payouts**  
- Add **outcome / payout wallets** if required  
- Payout IPN (if separate field): `https://YOUR_DOMAIN/webhooks/payouts/nowpayments`

---

### 6.5 Escrow behaviour (defaults OK)

```env
AUTO_RELEASE_ENABLED=true
AUTO_SEND_DELIVERY_AFTER_PAYMENT=true
```

---

### 6.6 Mock-only section (skip for production)

If `PAYMENT_PROVIDER=nowpayments`, you can ignore:

- `MOCK_WEBHOOK_SECRET`

---

### 6.7 Gateway (optional)

Default is fine for first test:

```env
REQUIRE_GATEWAY_JOIN=true
GATEWAY_JOIN_URL=https://t.me/OGMP_GatewayBot
```

To disable gateway screen for testing: `REQUIRE_GATEWAY_JOIN=false`

---

### 6.8 Fees (optional)

```env
PLATFORM_FEE_PERCENT=0.01
MIN_FEE=0
NOWPAYMENTS_SERVICE_FEE_PERCENT=0.01
```

---

### 6.9 Worker

```env
NOTIFICATION_WORKER_ENABLED=true
```

---

## Part 7 — Install and start the bot

**In project folder:**

```bash
npm install
npm run db:setup
npm run build
npm start
```

You should see logs like `main_bot_started` and `http_server_listening`.

**Keep this terminal open** (or use PM2 / systemd on a VPS).

**Development with auto-reload:**

```bash
npm run dev
```

---

## Part 8 — Point your domain to the server (if not done)

Example: nginx forwards `https://escrow.yourdomain.com` → `http://127.0.0.1:8080`

Without a domain you can use a tunnel for testing:

- [ngrok](https://ngrok.com): `ngrok http 8080` → use the `https://xxxx.ngrok.io` URL as `PUBLIC_BASE_URL`

---

## Part 9 — Test end-to-end (two Telegram accounts)

Use **two phones** or one phone + Telegram Desktop (buyer + seller).

### 9.1 Admin check

1. Open your **main escrow bot** in Telegram.  
2. Send `/start`.  
3. You should see menu; if you are admin: **Admin** or `/admin`.  
4. If “Forbidden” on admin → fix `ADMIN_IDS` in `.env` and restart.

### 9.2 Create a deal (buyer)

1. `/create` or **Create deal**.  
2. Role: **Buyer**.  
3. Fill title, amount (start **small**, e.g. $5), currency **USDT**, network **TRC20**.  
4. Finish wizard → note **deal code** (e.g. `OGMP-2026-XXXX`).

### 9.3 Seller joins

1. Seller opens bot → `/start join_XXXXX` (link from deal) or use invite.  
2. **Accept terms** (both sides).

### 9.4 Seller — payout wallet (required)

1. Seller opens deal → **Set payout wallet**.  
2. Paste **USDT TRC20 address** (where they want to receive money).  
3. **Confirm wallet**.

### 9.5 Seller — delivery

1. **Upload / Deal room** → send file (or zip).  
2. **Submit delivery**.

### 9.6 Buyer — pay

1. Buyer gets **Payment Required** DM with address and **exact amount**.  
2. Send crypto from wallet to that address (exact amount, **TRC20**).  
3. Tap **I Have Paid** / **Check Payment**.  
4. Wait until status shows payment confirmed / funded.

### 9.7 Buyer — release

1. Download / check product.  
2. **Release to seller** → **Yes — release funds**.  
3. Seller should get “Payout processing/sent”.  
4. Check seller’s wallet (and NOWPayments dashboard).

### 9.8 If payout stuck

1. Main bot → `/admin` → **Pending payouts**.  
2. Or `/admin_retry_payout DEALCODE`.  
3. Check server logs for `nowpayments_payout_verified` or errors.

---

## Part 10 — Checklist (print this)

- [ ] Code pulled from GitHub (`main` branch)  
- [ ] `MAIN_BOT_TOKEN` + `OGMP_MM_REPORT_BOT_TOKEN` set  
- [ ] `ADMIN_IDS` = your numeric Telegram ID  
- [ ] Postgres + Redis running, `DATABASE_URL` + `REDIS_URL` correct  
- [ ] `PUBLIC_BASE_URL` is **HTTPS** and `/health` works  
- [ ] `PAYMENT_PROVIDER=nowpayments`  
- [ ] `NOWPAYMENTS_API_KEY` + `NOWPAYMENTS_IPN_SECRET` set  
- [ ] IPN URL configured in NOWPayments dashboard  
- [ ] `NOWPAYMENTS_EMAIL` + `NOWPAYMENTS_PASSWORD` (API password, not Google)  
- [ ] 2FA **enabled** on NOWPayments + `NOWPAYMENTS_2FA_SECRET` in `.env`  
- [ ] `NOWPAYMENTS_PAYOUT_VERIFY_CODE` empty  
- [ ] Custody / mass payouts enabled in NOWPayments  
- [ ] `npm run db:setup` + `npm start` running  
- [ ] Test deal completed: pay → release → seller received crypto  

---

## Part 11 — Useful admin commands

| Command | What it does |
|---------|----------------|
| `/admin` | Admin panel |
| `/admin_add TELEGRAM_ID` | Add admin |
| `/admin_release DEALCODE` | Force release + payout |
| `/admin_retry_payout DEALCODE` | Retry seller payout |
| `/admin_list` | List admins |

---

## Part 12 — If something breaks

| Problem | Fix |
|---------|-----|
| Bot does not reply | Check token; only one instance running; `deleteWebhook` runs on start |
| `DATABASE_URL` connection refused | Wrong host (`localhost` vs `postgres`); start Docker DB |
| Payment never detected | `PUBLIC_BASE_URL` wrong; IPN secret mismatch; check `/webhooks/payments/nowpayments` |
| No pay address for buyer | Seller must **Set payout wallet** first |
| Payout not sent | Email/password wrong; 2FA secret wrong; check **Pending payouts** |
| Google login only | Use **Reset password** for API password (Part 6.4A) |

More detail: [ENV_SETUP.md](./ENV_SETUP.md) · [AUTOMATION.md](./AUTOMATION.md)

---

## Your `.env` template (copy and fill blanks)

```env
NODE_ENV=production
DATABASE_URL=postgresql://ogmp:ogmp@localhost:5432/ogmp_mm?schema=public
REDIS_URL=redis://localhost:6379

MAIN_BOT_TOKEN=
OGMP_MM_REPORT_BOT_TOKEN=
ADMIN_IDS=

PUBLIC_BASE_URL=https://YOUR-HOSTNAME-HERE
SERVER_PORT=8080
NOTIFICATION_WORKER_ENABLED=true

PAYMENT_PROVIDER=nowpayments
NOWPAYMENTS_API_KEY=
NOWPAYMENTS_IPN_SECRET=
NOWPAYMENTS_EMAIL=
NOWPAYMENTS_PASSWORD=
NOWPAYMENTS_2FA_SECRET=
NOWPAYMENTS_PAYOUT_VERIFY_CODE=

AUTO_RELEASE_ENABLED=true
AUTO_SEND_DELIVERY_AFTER_PAYMENT=true
REQUIRE_GATEWAY_JOIN=false
```

Set `REQUIRE_GATEWAY_JOIN=false` only for easier first test; turn back to `true` for production.
