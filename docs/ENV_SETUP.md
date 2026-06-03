# OGMP MM — Environment variables (what to fill & how)

Copy `.env.example` to `.env` in the project root. **Never commit `.env`** (it has secrets).

---

## Quick start (production + full automation)

| Variable | What to put |
|----------|-------------|
| `MAIN_BOT_TOKEN` | Escrow bot token from [@BotFather](https://t.me/BotFather) |
| `OGMP_MM_REPORT_BOT_TOKEN` | Second bot token (reports/cases) |
| `DATABASE_URL` | Your Postgres connection string |
| `REDIS_URL` | Your Redis URL |
| `PUBLIC_BASE_URL` | `https://your-domain.com` (HTTPS, no trailing slash) |
| `ADMIN_IDS` | Your Telegram numeric user ID |
| `PAYMENT_PROVIDER` | `nowpayments` |
| `NOWPAYMENTS_API_KEY` | API key from NOWPayments dashboard → API |
| `NOWPAYMENTS_IPN_SECRET` | IPN secret from NOWPayments → IPN settings |
| `NOWPAYMENTS_EMAIL` | Same email you use to log in to NOWPayments |
| `NOWPAYMENTS_PASSWORD` | That account password |
| `NOWPAYMENTS_2FA_SECRET` | Base32 secret from Google Authenticator setup (see below) |

Leave `NOWPAYMENTS_PAYOUT_VERIFY_CODE` **empty** if you use `NOWPAYMENTS_2FA_SECRET` (recommended).

---

## 1. Core (required)

### `NODE_ENV`
- **Example:** `production`
- **How:** Use `production` on a live server; `development` locally.

### `DATABASE_URL`
- **What:** PostgreSQL connection string for Prisma.
- **Codespaces / Docker Compose:**  
  `postgresql://ogmp:ogmp@postgres:5432/ogmp_mm?schema=public`
- **Your PC (local Postgres):**  
  `postgresql://USER:PASSWORD@localhost:5432/ogmp_mm?schema=public`
- **How:** Create database `ogmp_mm`, run `npm run db:setup`.

### `REDIS_URL`
- **What:** Redis for queues, locks, sessions.
- **Docker:** `redis://redis:6379`
- **Local:** `redis://localhost:6379`

### `MAIN_BOT_TOKEN`
- **What:** Telegram token for the **main escrow bot**.
- **How:** BotFather → `/newbot` → copy token like `7123456789:AAH...`
- **Fill:** paste entire token, no quotes.

### `TELEGRAM_BOT_TOKEN`
- **What:** Legacy alias for `MAIN_BOT_TOKEN`.
- **How:** Leave empty if `MAIN_BOT_TOKEN` is set.

### `OGMP_MM_REPORT_BOT_TOKEN`
- **What:** Separate bot for **Open Case / evidence** flow.
- **How:** Create a second bot in BotFather; paste token.

### `SERVER_PORT`
- **What:** HTTP port for health + payment webhooks.
- **Example:** `8080`
- **How:** Your reverse proxy (nginx, Caddy) forwards `443` → this port.

---

## 2. Admins

### `ADMIN_IDS`
- **What:** Comma-separated **numeric** Telegram user IDs with admin access.
- **How to get your ID:** Message [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot).
- **Example:** `123456789` or `111,222,333`
- **Note:** You can add more later with `/admin_add` (no restart).

### `ADMIN_TELEGRAM_IDS`
- **What:** Same as `ADMIN_IDS` (merged list).
- **How:** Usually leave empty; use only `ADMIN_IDS`.

---

## 3. Public URLs & bot names

### `PUBLIC_BASE_URL`
- **What:** Public HTTPS URL where this app is reachable (for NOWPayments IPN).
- **Example:** `https://escrow.yourdomain.com`
- **How:** Must be internet-accessible; used as:
  - `https://YOUR_DOMAIN/webhooks/payments/nowpayments`
  - `https://YOUR_DOMAIN/webhooks/payouts/nowpayments`
- **Wrong:** `http://localhost:8080` (NOWPayments cannot call localhost).

### `BOT_PUBLIC_USERNAME`
- **What:** Main bot @username **without** `@` (for t.me links).
- **Example:** `MyEscrowBot`
- **How:** Optional; bot learns username from Telegram if empty.

### `REPORT_BOT_USERNAME`
- **What:** Report bot @username without `@`.
- **How:** Optional; filled from Telegram after report bot starts.

---

## 4. Payments — NOWPayments (live crypto)

### `PAYMENT_PROVIDER`
- **Values:** `nowpayments` (live) or `mock` (fake payments, local test).
- **Production:** `nowpayments`

### `NOWPAYMENTS_API_KEY`
- **How:** [NOWPayments](https://account.nowpayments.io) → **API** → generate key.
- **Fill:** paste key only, no spaces.

### `NOWPAYMENTS_IPN_SECRET`
- **How:** NOWPayments → **IPN Settings** → generate **IPN Secret**.
- **Fill:** paste secret; same value must be in the dashboard callback config.

### `NOWPAYMENTS_API_BASE`
- **What:** API host override.
- **How:** Leave **empty** (uses `https://api.nowpayments.io`).

### `NOWPAYMENTS_EMAIL` + `NOWPAYMENTS_PASSWORD`
- **What:** Dashboard login used for **mass payout** API (`POST /v1/auth`).
- **How:** Same email/password you use at [account.nowpayments.io](https://account.nowpayments.io).
- **Required** for automatic seller payouts.

### `NOWPAYMENTS_2FA_SECRET` (recommended — fully automated payouts)
- **What:** Base32 secret from **Google Authenticator** when you enabled 2FA on NOWPayments.
- **How to get it:**
  1. NOWPayments → Account → enable **2FA** (Google Authenticator).
  2. When shown QR code, choose **“Can’t scan?” / manual entry** and copy the **secret key** (letters A–Z and digits, often 16+ chars).
  3. Paste into `.env` as one line (spaces OK):  
     `NOWPAYMENTS_2FA_SECRET=JBSWY3DPEHPK3PXP`
  4. Keep the same secret in Google Authenticator on your phone (codes must match NOWPayments).
- **Result:** Bot generates a fresh 6-digit code on **every** payout verify — **you never paste codes manually**.

### `NOWPAYMENTS_PAYOUT_VERIFY_CODE` (fallback only)
- **What:** Single 6-digit code from email (if 2FA is **off** on NOWPayments).
- **How:** Only if you refuse to use `NOWPAYMENTS_2FA_SECRET`; code expires ~1 hour — **not** fully automated.
- **Leave empty** when using `NOWPAYMENTS_2FA_SECRET`.

### Enable on NOWPayments dashboard
- **Custody** / balance for payouts
- **Mass payouts** API enabled
- IPN callback URLs pointing to your `PUBLIC_BASE_URL` paths above

---

## 5. Payments — Mock (local test, no real crypto)

### `PAYMENT_PROVIDER=mock`

### `MOCK_WEBHOOK_SECRET`
- **What:** HMAC secret for simulating payment webhooks in dev.
- **Example:** `change_me_to_a_long_random_string` (32+ random chars)

---

## 6. Escrow behaviour

### `AUTO_RELEASE_ENABLED`
- **Default:** `true`
- **What:** Buyer “Release to seller” completes deal without admin.
- **How:** Set `false` only if you want every release to need `/admin_release`.

### `AUTO_SEND_DELIVERY_AFTER_PAYMENT`
- **Default:** `true`
- **What:** After pay confirms, bot DMs each delivery file to buyer.
- **How:** `false` = buyer only gets “Download Files” button.

---

## 7. OGMP Gateway (optional gate before bot)

### `REQUIRE_GATEWAY_JOIN`
- **Default:** `true` — users must pass gateway screen on `/start`.

### `GATEWAY_JOIN_URL`
- **Example:** `https://t.me/OGMP_GatewayBot`

### `GATEWAY_USERNAME`
- **Example:** `@OGMP_GatewayBot`

### `GATEWAY_CHAT_ID`
- **What:** Telegram channel/supergroup id (`-100…`) to verify membership.
- **How:** Add main bot as admin there; get id from @getidsbot; leave empty for honor-system “Continue”.

---

## 8. Fees (optional overrides)

### `PLATFORM_FEE_PERCENT`
- **Default:** `0.01` (= 1% OGMP fee)

### `MIN_FEE` / `MAX_FEE`
- **Default:** `MIN_FEE=0`, `MAX_FEE` empty

### `NOWPAYMENTS_SERVICE_FEE_PERCENT`
- **Default:** `0.01` — used only for **quotes** before invoice; real fee comes from NOWPayments `pay_amount`.

---

## 9. Reports & uploads

### `REPORT_SESSION_EXPIRY_MINUTES`
- **Default:** `60`

### `MAX_UPLOAD_SIZE_MB`
- **Default:** `50`

### `BLOCKED_FILE_EXTENSIONS`
- **Default:** `.exe,.bat,...` — comma-separated, with leading dots.

### `SUPPORT_USERNAME`
- **What:** @username shown for support (no `@`).

---

## 10. Workers & limits

### `NOTIFICATION_WORKER_ENABLED`
- **Default:** `true` — run notification queue in same process as bots.

### `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`
- **Defaults:** `10000` / `30` — anti-spam per user.

### `LOG_LEVEL`
- **Values:** `debug` | `info` | `warn` | `error`
- **Production:** `info`

---

## 11. Optional / advanced

### `WEBHOOK_SECRET` / `APP_SECRET_KEY`
- Leave empty unless you add custom integrations.

### `HIGH_VALUE_DEAL_THRESHOLD` / `REQUIRE_ADMIN_APPROVAL_FOR_HIGH_VALUE`
- High-value deal gates (see seed / admin settings).

---

## Checklist before going live

1. [ ] Postgres + Redis running  
2. [ ] `npm run db:setup`  
3. [ ] `.env` filled (section 1–4 minimum)  
4. [ ] `PUBLIC_BASE_URL` reachable over HTTPS  
5. [ ] NOWPayments IPN + payout IPN URLs configured  
6. [ ] `NOWPAYMENTS_2FA_SECRET` set (Authenticator secret)  
7. [ ] `ADMIN_IDS` = your Telegram ID  
8. [ ] `npm run build && npm start` (or PM2/Docker)  
9. [ ] Test: small deal end-to-end (seller wallet → pay → release → seller receives crypto)

Full flow: [AUTOMATION.md](./AUTOMATION.md)
