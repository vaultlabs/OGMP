# Full automation — what OGMP does vs what NOWPayments requires

You asked for **zero manual steps**. Here is the honest split: the **Telegram bot is already automated**; **NOWPayments security** is what still makes you click “approve” in their dashboard unless you change account settings once.

---

## What the bot already does automatically (no admin)

| Step | Automated? |
|------|------------|
| Buyer/seller terms, deal room, delivery lock | Yes |
| Payment address + buyer pay-in (IPN/poll) | Yes |
| Unlock vault / DM files after pay | Yes |
| Buyer **Release to seller** → deal `released` | Yes (`AUTO_RELEASE_ENABLED=true`) |
| Create NOWPayments payout API call | Yes |
| **6-digit payout verify** (2FA) | Yes — if `NOWPAYMENTS_2FA_SECRET` is the full **15-character** key in `.env` |
| Notify seller payout sent / failed | Yes |

You should **not** need to open NOWPayments for each deal **if** the checklist at the bottom is done.

---

## What you still “approve” today (NOWPayments, not OGMP)

These are **NOWPayments account security** features. The public API **cannot** add a new seller wallet to your whitelist or click “approve payout” in the dashboard for you.

### 1. Approve / verify the payout transaction

Usually one of:

- **2FA verify** — NOWPayments requires `POST /v1/payout/{id}/verify` with a 6-digit code.  
  **OGMP does this automatically** using `NOWPAYMENTS_2FA_SECRET` (same secret as Google Authenticator).
- If you still get email codes or dashboard “Confirm payout”, then either:
  - `NOWPAYMENTS_2FA_SECRET` is wrong/short → fix `.env` and restart, or
  - 2FA on payouts is **email-only** on your account → enable **Authenticator 2FA** on NOWPayments, or
  - Verify failed in logs → see `nowpayments_payout_verify_failed`

### 2. Approve the wallet address

NOWPayments **wallet whitelisting** means: payouts only go to addresses you pre-approved in:

**Dashboard → Settings → Whitelist → Whitelist addresses**  
(or **Mass Payouts → Whitelist addresses**)

Each seller sets a **different** TRC20/ERC20 address per deal. You **cannot** manually whitelist thousands of addresses (dashboard limit is small; new address per deal).

**For a real escrow marketplace you have two choices:**

| Option | Effort | Automation |
|--------|--------|--------------|
| **A — Disable wallet whitelist (recommended for OGMP)** | One email to NOWPayments | Any seller address works via API |
| **B — Keep whitelist on** | You approve **every** new seller wallet in dashboard before each payout | **Not** fully automatic |

### 3. Approve the server IP

**IP whitelisting** means: API payouts only work from IPs you listed.

- **Codespaces:** IP changes → you must re-whitelist after restart (bad for 24/7).
- **VPS with static IP:** whitelist once.

**For full automation on a VPS:** whitelist your server IP once, or ask NOWPayments to disable IP whitelist (same email as below).

---

## One-time setup for true hands-off payouts

### Step 1 — Email NOWPayments (disable whitelist restrictions)

From the email registered on your NOWPayments account, send to **whitelist@nowpayments.io**:

```text
Subject: Disable payout whitelisting for API escrow (OGMP)

Hello,

I operate an escrow service using the NOWPayments Mass Payouts API. Each deal pays out to a different seller wallet address.

Please disable the following on my account (I accept all related risks):

1. Wallet address whitelisting on payouts
2. IP address whitelisting on payouts (if applicable)

Account email: YOUR_NOWPAYMENTS_EMAIL

Thank you.
```

NOWPayments documents this in their Integration Guide. Response may take **1–3 business days**. Until they confirm, you must keep approving wallets/IPs in the dashboard.

Optional third line (only if you want email codes gone and use API TOTP only):

```text
3. Email-based 2FA confirmation on payouts (I use Authenticator + API verify instead)
```

### Step 2 — `.env` on the server (Codespaces or VPS)

```env
PAYMENT_PROVIDER=nowpayments
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_EMAIL=...
NOWPAYMENTS_PASSWORD=...          # API password from Reset password — not Google
NOWPAYMENTS_2FA_SECRET=...        # Full 15-character key from 2FA setup
NOWPAYMENTS_PAYOUT_VERIFY_CODE=   # leave empty

AUTO_RELEASE_ENABLED=true
AUTO_SEND_DELIVERY_AFTER_PAYMENT=true
PUBLIC_BASE_URL=https://your-https-host
LOG_LEVEL=info
```

Restart bot after any `.env` change.

### Step 3 — Custody + balance

- Enable **Custody** in dashboard.
- **Withdrawal fee paid by → Receiver** (Settings → Payments → Payment Details).
- Keep enough **Custody balance in the deal coin** (e.g. USDT TRC20), not only “total balance”.

### Step 4 — Production hosting (strongly recommended)

| Codespaces | VPS (Railway, Hetzner, etc.) |
|------------|------------------------------|
| Stops when idle | Runs 24/7 |
| IP changes | **Static IP** — whitelist once |
| Fine for testing | Use for real money |

### Step 5 — Webhooks

On NOWPayments:

- Payment IPN: `https://YOUR-HOST/webhooks/payments/nowpayments`
- Payout IPN: `https://YOUR-HOST/webhooks/payouts/nowpayments`

---

## End-to-end flow after setup (no you in the loop)

1. Seller sets payout wallet in Telegram (OGMP — not NOWPayments dashboard).
2. Seller uploads delivery → buyer pays → buyer releases.
3. Bot: create payout → auto 2FA verify → IPN updates status → seller DM.

You only use `/admin_retry_payout` if something failed (balance, old whitelist, wrong 2FA secret).

---

## Troubleshooting “I still have to approve”

| Symptom | Cause | Fix |
|---------|--------|-----|
| Dashboard “confirm payout” | Verify not run or failed | Fix `NOWPAYMENTS_2FA_SECRET`, check logs `nowpayments_payout_verified` |
| “Invalid IP” | IP not whitelisted | Whitelist IP or email NOWPayments to disable IP whitelist |
| “Wallet not whitelisted” / payout rejected | Wallet whitelist on | Email NOWPayments to disable, or manually whitelist that address |
| “Insufficient balance” | Wrong Custody coin | Top up **same** coin/network as deal in Custody |
| Bot says success, no crypto | Payout stuck in NOWPayments | Dashboard → Payouts → check status; `/admin_retry_payout` |

---

## What OGMP cannot build (API limits)

- Auto-add seller wallets to NOWPayments whitelist (no public API).
- Auto-add Codespaces IP when it changes.
- Disable NOWPayments security without their support email.
- Pay sellers without Custody balance in that coin.

---

## Checklist — “fully automated”

- [ ] Email sent to **whitelist@nowpayments.io** (wallet + IP whitelist off) — **or** you accept manual wallet approval per seller
- [ ] Custody enabled, correct coin funded, fee payer = Receiver
- [ ] `NOWPAYMENTS_2FA_SECRET` = 15 chars, bot restarted
- [ ] `NOWPAYMENTS_PAYOUT_VERIFY_CODE` empty
- [ ] `AUTO_RELEASE_ENABLED=true`
- [ ] `PUBLIC_BASE_URL` HTTPS + IPN URLs set
- [ ] Server IP whitelisted **or** IP whitelist disabled by NOWPayments
- [ ] Test deal: release → seller paid without you opening NOWPayments

More: [AUTOMATION.md](./AUTOMATION.md), [ENV_SETUP.md](./ENV_SETUP.md), [SETUP_CODESPACES.md](./SETUP_CODESPACES.md).
