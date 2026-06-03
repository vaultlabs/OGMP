# OGMP MM — Fully automated escrow

This bot runs **end-to-end escrow without manual steps** for normal deals. Admins only step in for disputes, stuck payouts, or policy exceptions.

## Flow (buyer + seller)

| Step | Who | What happens |
|------|-----|----------------|
| 1 | Both | Join deal → accept terms |
| 2 | **Seller** | **Set payout wallet** (required before buyer can pay) |
| 3 | Seller | Delivery Vault → upload → submit |
| 4 | Buyer | Pays exact quoted amount (OGMP 1% + NOWPayments fees) |
| 5 | Bot | Detects payment → confirms → unlocks vault / DMs files |
| 6 | Seller | Optional: Mark delivered |
| 7 | **Buyer** | **Release to seller** (confirmation step) |
| 8 | Bot | Marks deal `released` → **NOWPayments payout** to seller wallet |

Disputes: **Open Case** freezes the deal; use REPORT bot + `/admin_release` or `/admin_refund`.

## Environment (production)

Copy `.env.example` → `.env` and set:

### Core

```env
MAIN_BOT_TOKEN=
OGMP_MM_REPORT_BOT_TOKEN=
DATABASE_URL=
REDIS_URL=
PUBLIC_BASE_URL=https://your-server.example
SERVER_PORT=8080
NOTIFICATION_WORKER_ENABLED=true
```

### Admins

```env
# Comma-separated Telegram user IDs (numeric). Restart required to change.
ADMIN_IDS=YOUR_TELEGRAM_ID
```

**Add more admins without restart** (in bot, as an existing admin):

- `/admin_add TELEGRAM_ID`
- `/admin_remove TELEGRAM_ID`
- `/admin_list`

Or: Admin panel → **Manage admins**

### Payments (NOWPayments)

```env
PAYMENT_PROVIDER=nowpayments
NOWPAYMENTS_API_KEY=
NOWPAYMENTS_IPN_SECRET=
AUTO_RELEASE_ENABLED=true
```

### Automated seller payouts

```env
NOWPAYMENTS_EMAIL=          # Dashboard login email
NOWPAYMENTS_PASSWORD=       # Dashboard password
NOWPAYMENTS_PAYOUT_VERIFY_CODE=   # 2FA or email code for POST /v1/payout/.../verify
```

Enable **Custody / Mass payouts** in the NOWPayments dashboard.

**Webhooks** (must be reachable on `PUBLIC_BASE_URL`):

| URL | Purpose |
|-----|---------|
| `/webhooks/payments/nowpayments` | Buyer pay-in (IPN) |
| `/webhooks/payouts/nowpayments` | Seller payout status (IPN) |

### Dev / test without real crypto

```env
PAYMENT_PROVIDER=mock
```

Payouts complete instantly in the database.

## Admin panel (`/admin` or menu → Admin)

- **Dashboard** — counters including pending payouts  
- **Pending payouts** — queue + retry/mark commands  
- **Manage admins** — list + add/remove instructions  
- **Force release / refund** — help + commands below  

### Admin commands

| Command | Use |
|---------|-----|
| `/admin_release DEALCODE` | Force release + trigger payout |
| `/admin_refund DEALCODE` | Force refund |
| `/admin_retry_payout DEALCODE` | Resend NOWPayments payout for a released deal |
| `/admin_payout_update PAYOUT_UUID [tx_hash]` | Mark payout completed manually |
| `/admin_add TELEGRAM_ID` | Grant admin (stored in DB) |
| `/admin_remove TELEGRAM_ID` | Revoke bot-added admin |
| `/admin_list` | List all admin IDs |

## Payout verify code (important)

NOWPayments requires **POST /v1/payout/{id}/verify** with a 2FA or email code. Set `NOWPAYMENTS_PAYOUT_VERIFY_CODE` in `.env` (or refresh it when it expires). Without a valid code, payouts stay in `CREATING` and appear under **Pending payouts**.

For unattended production, plan one of:

- TOTP automation from your NOWPayments 2FA secret  
- A small cron that updates the env/code from email  
- Manual refresh when the admin panel shows failed payouts  

## Deploy checklist

1. Postgres + Redis running  
2. `npx prisma migrate deploy`  
3. `npm run build` && `npm start` (or your process manager)  
4. `PUBLIC_BASE_URL` reachable from the internet (HTTPS)  
5. NOWPayments IPN URLs configured to match the table above  
6. `ADMIN_IDS` includes your Telegram numeric ID  
7. Test: create deal → seller wallet → pay (sandbox/real) → release → seller receives payout  

## Verify locally

```bash
npm run verify
```
