# OGMP MM — Fully automated escrow

This bot runs **end-to-end escrow without manual steps** for normal deals. Admins only step in for disputes, stuck payouts, or policy exceptions.

**Still approving payouts or wallets in the NOWPayments dashboard?** That is NOWPayments security, not missing bot code. Read **[FULL_AUTOMATION_NOWPAYMENTS.md](./FULL_AUTOMATION_NOWPAYMENTS.md)** (email template to disable wallet/IP whitelist + full checklist).

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

### Automated seller payouts (no manual 2FA typing)

```env
NOWPAYMENTS_EMAIL=you@gmail.com
NOWPAYMENTS_PASSWORD=        # API password from Reset password — NOT Google sign-in
NOWPAYMENTS_2FA_SECRET=      # Authenticator secret from NOWPayments 2FA setup
```

**Google login on the website?** That’s fine. Use **Reset password** on the NOWPayments login page to set an API password for the same email. See [ENV_SETUP.md](./ENV_SETUP.md#nowpayments_email--nowpayments_password).

The bot **generates** the 6-digit verify code on every payout using `NOWPAYMENTS_2FA_SECRET`.  
Do **not** use `NOWPAYMENTS_PAYOUT_VERIFY_CODE` unless you refuse to set up 2FA secret.

**How to get the secret:** NOWPayments → Account → enable 2FA → “Can’t scan?” → copy the secret key into `.env`.

Enable **Custody / Mass payouts** in the NOWPayments dashboard.

**Multi-coin deals:** With `NOWPAYMENTS_AUTO_CUSTODY_CONVERT=true` (default), the bot swaps Custody into the deal’s coin before paying the seller — no manual convert per deal. See [FULL_AUTOMATION_NOWPAYMENTS.md](./FULL_AUTOMATION_NOWPAYMENTS.md).

**Every env variable explained:** [ENV_SETUP.md](./ENV_SETUP.md)

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

## Payout verify (automatic)

NOWPayments requires **POST /v1/payout/{id}/verify**. OGMP does this automatically using **`NOWPAYMENTS_2FA_SECRET`** (TOTP). No per-deal action from you.

If verify fails, check the secret matches Authenticator and use **Admin → Pending payouts** + `/admin_retry_payout DEALCODE`.

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
