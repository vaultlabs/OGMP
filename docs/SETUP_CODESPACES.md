# OGMP MM — Setup on GitHub Codespaces (A to Z)

**You do everything in the browser on github.com — not on your Windows PC.**

Repo: **https://github.com/vaultlabs/OGMP**

---

## What runs where

| Where | What runs |
|-------|-----------|
| **GitHub Codespaces** (cloud) | Node bot, Postgres, Redis, port 8080 |
| **Your phone** | Telegram + @BotFather |
| **nowpayments.io** (website) | API keys, IPN, 2FA |
| **Your PC** | Nothing required (no Docker, no `npm` on Desktop) |

---

## Part 1 — Open the project in Codespaces

1. Go to **https://github.com/vaultlabs/OGMP** in your browser.
2. Click the green **Code** button.
3. Open the **Codespaces** tab.
4. Click **Create codespace on main**.
5. Wait until the **VS Code in the browser** opens (first time **5–15 minutes**). Do not close the tab.

You now have a cloud computer. All commands below are in the **Terminal** at the bottom of that browser window (**Terminal → New Terminal**).

---

## Part 2 — Telegram bots (on your phone, @BotFather)

Do this on Telegram on your phone — not in Codespaces.

1. Search **@BotFather** → Start.
2. Send `/newbot` → name your escrow bot → pick username ending in `bot`.
3. Copy the **token** → you will paste it in Codespaces as `MAIN_BOT_TOKEN`.
4. `/newbot` again → create **report** bot → copy token → `OGMP_MM_REPORT_BOT_TOKEN`.

---

## Part 3 — Your admin Telegram ID (on your phone)

1. Search **@userinfobot** → Start.
2. Copy the number at **Id:** (digits only).
3. You will paste it in Codespaces as `ADMIN_IDS`.

---

## Part 4 — Create `.env` inside Codespaces

**In the Codespaces browser window only:**

1. **Terminal** (bottom) → type:

   ```bash
   npm run first-time
   ```

   Press Enter. This copies `.env.example` → `.env` if missing.

2. In the **left file explorer**, click **`.env`** to open it.

3. **Do not change** these if they already look like this (correct for Codespaces):

   ```env
   DATABASE_URL=postgresql://ogmp:ogmp@postgres:5432/ogmp_mm?schema=public
   REDIS_URL=redis://redis:6379
   ```

   If you see `localhost` in `DATABASE_URL`, change host to **`postgres`**.  
   If Redis says `localhost`, change to **`redis://redis:6379`**.

---

## Part 5 — Fill `.env` in Codespaces (secrets)

Edit **`.env` in the Codespaces editor** (left panel). Paste values from BotFather / NOWPayments / userinfobot.

### Required for any test

```env
NODE_ENV=production
MAIN_BOT_TOKEN=paste_escrow_bot_token_here
OGMP_MM_REPORT_BOT_TOKEN=paste_report_bot_token_here
ADMIN_IDS=paste_your_numeric_id_here
SERVER_PORT=8080
NOTIFICATION_WORKER_ENABLED=true
```

### For real crypto (NOWPayments)

```env
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

| Variable | Where to get it (website / app) |
|----------|----------------------------------|
| `NOWPAYMENTS_API_KEY` | **https://account.nowpayments.io** → log in → **API** → create/copy key |
| `NOWPAYMENTS_IPN_SECRET` | Same site → **IPN Settings** → generate secret |
| `NOWPAYMENTS_EMAIL` | The email on your NOWPayments account |
| `NOWPAYMENTS_PASSWORD` | **Not Google password.** On **https://account.nowpayments.io** login page → **Reset password** → set API password for that email |
| `NOWPAYMENTS_2FA_SECRET` | NOWPayments → **Account settings** → enable **2FA** → copy green box **Key: …** (also add to Google Authenticator on phone) |
| `NOWPAYMENTS_PAYOUT_VERIFY_CODE` | Leave **empty** if 2FA secret is set |

Leave empty: `NOWPAYMENTS_API_BASE`, `NOWPAYMENTS_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`

### Mock-only (skip if using nowpayments)

```env
MOCK_WEBHOOK_SECRET=any_long_random_string_here
```

---

## Part 6 — Public URL for NOWPayments (Codespaces only)

NOWPayments must reach your bot over **HTTPS**. In Codespaces you expose port **8080**.

### Step A — Start the bot first (Part 7), then:

1. In Codespaces, open the **PORTS** panel (bottom bar, near Terminal — tab may say **PORTS**).
2. Find port **8080**.
3. Right-click **8080** → **Port Visibility** → **Public** (not Private).
4. Copy the **Forwarded Address** URL. It looks like:

   `https://something-8080.app.github.dev`

   or similar `*.github.dev` link.

5. In **`.env`** in Codespaces set:

   ```env
   PUBLIC_BASE_URL=https://something-8080.app.github.dev
   ```

   No trailing slash. Must be **https**.

6. **Restart the bot** after changing `PUBLIC_BASE_URL` (Ctrl+C in terminal, then `npm run dev` again).

### Step B — Register URLs on NOWPayments website

On **https://account.nowpayments.io**:

| Setting | Value |
|---------|--------|
| Payment IPN callback | `https://YOUR-CODESPACE-URL/webhooks/payments/nowpayments` |
| Payout IPN (if separate) | `https://YOUR-CODESPACE-URL/webhooks/payouts/nowpayments` |

Replace `YOUR-CODESPACE-URL` with the host from step A (no path, no trailing slash in the base — full path only in the IPN fields).

### Step C — Test health in browser

Open in a new tab:

`https://YOUR-CODESPACE-URL/health`

You should see: `{"ok":true,"service":"ogmp-mm"}`

---

## Part 7 — Start the bot (Codespaces terminal only)

**Never run these on your PC’s CMD/PowerShell** — only in Codespaces terminal.

```bash
npm run check-setup
```

Fix every **❌** in `.env`, run again until all **✅**.

Then:

```bash
npm run dev
```

Leave this terminal running. You should see logs like `main_bot_started` and `http_server_listening`.

*(First Codespace creation may already have run `npm install` and `npm run db:setup` via devcontainer — if `db:setup` fails, run it once manually.)*

```bash
npm run db:setup
```

---

## Part 8 — Test on Telegram (phone)

1. Open your **escrow bot** in Telegram (the one from BotFather).
2. Send `/start`.
3. As admin, try `/admin` — should open admin panel.

### Mini deal test

| Step | Who | Action in Telegram |
|------|-----|-------------------|
| 1 | Buyer | `/create` → buyer → small USDT TRC20 deal |
| 2 | Seller | Join link → **Accept terms** |
| 3 | Seller | **Set payout wallet** → TRC20 address → confirm |
| 4 | Seller | Deal room → upload file → **Submit delivery** |
| 5 | Buyer | Pay exact amount from DM → **I Have Paid** |
| 6 | Buyer | **Release to seller** → Yes |
| 7 | Seller | Should see payout message; check wallet |

Admin stuck payout: `/admin` → **Pending payouts** or `/admin_retry_payout DEALCODE`

---

## Part 9 — Checklist (Codespaces)

- [ ] Codespace opened from **github.com/vaultlabs/OGMP** → Code → Codespaces  
- [ ] `.env` edited **inside Codespaces** (not on PC)  
- [ ] `DATABASE_URL` uses host **`postgres`**  
- [ ] `REDIS_URL=redis://redis:6379`  
- [ ] `MAIN_BOT_TOKEN` + `OGMP_MM_REPORT_BOT_TOKEN` from **@BotFather** (phone)  
- [ ] `ADMIN_IDS` from **@userinfobot** (phone)  
- [ ] Port **8080** set to **Public** in Codespaces PORTS tab  
- [ ] `PUBLIC_BASE_URL` = that **https://….github.dev** URL  
- [ ] NOWPayments IPN URLs use same host + `/webhooks/...`  
- [ ] `NOWPAYMENTS_*` filled from **account.nowpayments.io**  
- [ ] `NOWPAYMENTS_2FA_SECRET` set; `NOWPAYMENTS_PAYOUT_VERIFY_CODE` empty  
- [ ] `npm run dev` running in **Codespaces terminal**  
- [ ] `/health` works in browser  
- [ ] Test deal: pay → release → seller paid  

---

## Important Codespaces limits

1. **Codespace stops** when you close the browser or after idle time — bot goes offline. Fine for **testing**; for **24/7 production** use a VPS/Railway later with the same `.env` values (change `DATABASE_URL` / `REDIS_URL` to that host’s Postgres/Redis).
2. **Public port URL can change** if you recreate the codespace — update `PUBLIC_BASE_URL` and NOWPayments IPN again.
3. **Never commit `.env`** — it is gitignored. Only edit in Codespaces Secrets or the local `.env` file in the cloud editor.

### Optional: GitHub Codespaces secrets

For extra safety: **github.com** → your profile **Settings** → **Codespaces** → **Secrets** → add repository secrets (same names as env vars). Codespaces can inject them — for beginners, editing `.env` in the editor is enough.

---

## Quick reference — wrong vs right

| Wrong | Right |
|-------|--------|
| Run `npm run dev` on Windows CMD | Run only in **Codespaces** terminal |
| `DATABASE_URL` with `localhost` in Codespaces | Host **`postgres`** |
| `PUBLIC_BASE_URL=http://localhost:8080` | **https** `*.github.dev` from PORTS tab |
| Google password in `NOWPAYMENTS_PASSWORD` | Password from **Reset password** on NOWPayments |
| Paste token in GitHub Issue | Only in **`.env`** in Codespaces |

---

## More docs

- All env variables: [ENV_SETUP.md](./ENV_SETUP.md)  
- Automation flow: [AUTOMATION.md](./AUTOMATION.md)  
- PC / VPS setup (not Codespaces): [SETUP_A_TO_Z.md](./SETUP_A_TO_Z.md)
