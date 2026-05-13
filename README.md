# OGMP MM

**OGMP MM** is a production-oriented Telegram bot that coordinates **lawful** peer-to-peer cryptocurrency escrow: deal creation, mutual acceptance, payment tracking, delivery confirmation, optional admin-gated release, disputes, reviews, and admin tooling.

> **Legitimate use only.** The bot surfaces Terms of Service prohibiting scams, fraud, stolen or illegal goods, account theft, carding, malware, drugs, weapons, doxxing, and other illegal activity. Users must accept terms before using the bot.

## Stack

- **Node.js 20+**, **TypeScript (strict)**
- **grammY** (Telegram)
- **PostgreSQL** + **Prisma ORM**
- **Redis** (rate limits, wizard state, distributed locks, mock payment simulation)
- **Express** (health check + payment webhooks)
- **Docker** / **docker-compose**

## Super simple start (read this first)

You only type a few things in order. **Do them one at a time.**

1. Open a terminal in this folder (the same folder as `package.json`).
2. Type: **`npm install`** and wait until it finishes.
3. Type: **`npm run first-time`** — this makes a **`.env`** file if you do not have one yet.
4. Open **`.env`** in Notepad. Fill in the lines the checker tells you about (bot token, database, etc.).
5. Type: **`npm run check-setup`** — it says **✅** or **❌** so you know what is missing.
6. Start the database: **`npm run docker:db`** (needs Docker Desktop running on your computer).
7. Type: **`npm run db:setup`** — this prepares the database tables and sample coins.
8. Type: **`npm run dev`** — this starts the bot. Leave this window open.
9. Open Telegram on your phone, search your bot, send **`/start`**.

If **`npm run check-setup`** shows all **✅**, you are ready for steps 6–9.

### Run in the cloud (no Docker / Node / Postgres on *your* PC)

Your project includes **`.devcontainer/`** so **GitHub Codespaces** (or VS Code Dev Containers) can build everything on **their** computers, not yours.

1. Put this project on **GitHub** (upload / push your folder to a new repo). You only use the **website** github.com — no Docker on your laptop.
2. On GitHub open your repo → green **Code** button → **Codespaces** → **Create codespace**.
3. Wait until the browser editor opens (first time can take a few minutes).
4. In the codespace, open the file **`.env`** and add at least **`MAIN_BOT_TOKEN=`** (from @BotFather) and **`ADMIN_IDS=`** (your Telegram number).  
   **Leave `DATABASE_URL` and `REDIS_URL` alone** if they already say `postgres` and `redis` — that is correct *inside* the cloud box.
5. In the terminal at the bottom run: **`npm run dev`**
6. On your phone open Telegram and talk to your bot.

You still need **internet** and a **free GitHub account**. You do **not** need to install Docker Desktop on Windows for this path.

**Important:** Run **`npm run dev`** only in the **terminal inside the browser Codespace**, not in **CMD on your Desktop** — your Desktop is a different computer and does not know the name `postgres`.

#### GitHub Codespaces — do this slowly, one line at a time

**A — Put the project on GitHub (one time)**

1. Log in at [github.com](https://github.com).
2. Click **+** (top right) → **New repository**.
3. Name it (example: `ogmp-mm`). Leave it **Public** or **Private**. **Do not** add a README if you already have this folder on your computer (avoids merge mess). Click **Create repository**.
4. Upload your project:
   - **Easy way:** On the new empty repo page, use **uploading an existing file** and drag your whole `ogmp mm` folder files (or use GitHub Desktop / `git` if you know it).

**B — Open the cloud computer**

5. Open that repo on GitHub.
6. Green **Code** button → tab **Codespaces** → **Create codespace on main** (or **…** → New with options… if you want a bigger machine).
7. Wait until a **VS Code in the browser** window opens. First time can take **5–10 minutes**. Do not close the tab.

**C — Tell the bot your secrets**

8. In Codespaces, open the **Terminal** menu → **New Terminal** (bottom panel).
9. Type exactly: **`npm run first-time`** and press Enter. (This makes a `.env` file if you do not have one.)
10. In the **file list on the left**, click **`.env`** to open it.
11. Fill in:
    - **`MAIN_BOT_TOKEN=`** — long token from Telegram **@BotFather** (`/newbot`).
    - **`ADMIN_IDS=`** — your Telegram user id (numbers only; bots like **@userinfobot** can show it).
    - **`MOCK_WEBHOOK_SECRET=`** — any long random text (for testing payments).
12. Make sure **`DATABASE_URL`** contains **`postgres`** as the host (not `localhost`) and **`REDIS_URL`** is **`redis://redis:6379`**. If your `.env` still says `localhost`, change database host to **`postgres`** for Codespaces.
13. Type: **`npm run check-setup`** — you want all green **✅**. Fix any **❌**, then run **`npm run check-setup`** again.

**D — Run the bot**

14. Type: **`npm run dev`** and leave the terminal running.
15. On your phone, open **Telegram**, find your bot, tap **Start** / send **`/start`**.

**Remember:** **`.env`** is secret. It is **`.gitignore`d`** — never paste your real token in a GitHub **Issue** or **Discussion**.

---

### If Docker will not start on your own PC (optional)

- **“docker is not recognized”** → Docker Desktop is **not installed**, or your terminal was opened **before** install — install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/), reboot, open Docker **once** until it says **Running**, then open a **new** terminal.
- **Docker opens then errors about WSL** → Install [WSL2](https://learn.microsoft.com/windows/wsl/install) and a Linux distro (Ubuntu), reboot, open Docker again.
- **Still stuck** → You can skip Docker and install **Postgres + Redis on Windows** instead (see **README** section *Local Postgres + Redis without Docker*).

---

## Quick start (development)

1. Copy `.env.example` → `.env` (or run **`npm run first-time`** once).

2. Set at least:

   - `DATABASE_URL` — use `localhost` when the app runs on your PC (see `.env.example`).
   - `REDIS_URL`
   - `MAIN_BOT_TOKEN` **or** `TELEGRAM_BOT_TOKEN` (from @BotFather)
   - `ADMIN_IDS` **or** `ADMIN_TELEGRAM_IDS` (comma-separated numeric Telegram user IDs)
   - `MOCK_WEBHOOK_SECRET` (for mock provider HMAC webhooks in dev)
   - Optional: `OGMP_MM_REPORT_BOT_TOKEN` for the separate report bot

3. Run **`npm run check-setup`** to verify required variables.

4. Start Postgres + Redis: **`npm run docker:db`** (or `docker compose up -d postgres redis`).

5. Install and migrate:

```bash
npm install
npm run db:setup
npm run dev
```

6. Open Telegram, start a chat with your bot, send `/start`, accept terms, and use the inline menu.

### Helpful npm commands

| Command | Purpose |
|--------|---------|
| `npm run first-time` | Create `.env` from `.env.example` if missing |
| `npm run check-setup` | Print what is missing in `.env` |
| `npm run docker:db` | Start Postgres + Redis in Docker |
| `npm run db:setup` | `prisma generate` + migrate + seed |
| `npm run dev` | Run bot with `tsx` + watch |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Vitest (state machine + mock provider) |
| `npm run lint` | ESLint |
| `npm run prisma:migrate` | Create a new migration in dev |
| `npm run prisma:migrate:deploy` | Apply migrations in prod |
| `npm run prisma:studio` | Prisma Studio |

## Local Postgres + Redis (no Docker)

Use this if Docker Desktop will not install or will not start.

1. **PostgreSQL** — install from [postgresql.org](https://www.postgresql.org/download/windows/) (remember the password you set for user `postgres`).  
2. Open **pgAdmin** or `psql` and create an empty database named **`ogmp_mm`**.  
3. **Redis** — from an elevated PowerShell try: `winget install Redis.Redis` (or install [Memurai](https://www.memurai.com/) / another Redis-compatible server for Windows). Start the Redis service.  
4. In **`.env`** set for example:

   - `DATABASE_URL=postgresql://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/ogmp_mm?schema=public`  
   - `REDIS_URL=redis://localhost:6379`

5. Run **`npm run db:setup`** then **`npm run dev`** (you do **not** need `npm run docker:db`).

---

## Docker / production

```bash
cp .env.example .env
# edit .env — set MAIN_BOT_TOKEN (or TELEGRAM_BOT_TOKEN), ADMIN_IDS, MOCK_WEBHOOK_SECRET, etc.

docker compose up --build
```

- **HTTP**: `GET /health` on `SERVER_PORT` (default `8080`)
- **Payment webhooks**: `POST /webhooks/payments/:provider` with raw JSON body (mock provider expects header `x-signature: sha256=<hmac>` using `MOCK_WEBHOOK_SECRET`)

The container runs `prisma migrate deploy` before starting the bot.

### AUTO_RELEASE_ENABLED

- Default **`AUTO_RELEASE_ENABLED=false`** in `.env` (and mirrored into `bot_settings` on first boot).
- When **false**, after the buyer confirms receipt the deal moves to **`release_requested`** and an admin must approve release (e.g. **`/admin_release`** or admin panel) before funds are marked released and payout rows are created.
- When **true**, buyer confirmation performs automatic release **after** internal checks (still requires seller payout address on the deal for payout row creation).

## Payment providers

- **`PAYMENT_PROVIDER=mock`**: generates deterministic mock addresses, reads simulated chain state from Redis, and verifies HMAC-signed webhooks. **Never use mock mode with real customer funds.**
- **`PAYMENT_PROVIDER=nowpayments`**: ships a **typed skeleton** (`src/payments/nowpayments.provider.ts`). Wire real API calls, IPN HMAC verification, and payout endpoints using your custodian’s documentation. **TODO:** add `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and `PUBLIC_BASE_URL` for IPN callback URLs.

Polling fallback: `src/jobs/paymentWatcher.job.ts` runs on an interval from `src/app.ts` (upgrade to a dedicated BullMQ/Redis worker fleet when you outgrow a single process).

## Security notes

- **Never** store private keys in the database; use a custodian or HSM-backed signing service.
- All privileged Telegram actions check **`ADMIN_IDS`** / **`ADMIN_TELEGRAM_IDS`** (numeric IDs), not usernames.
- Deals use **optimistic `version` fields** to reduce double-submit races; hot paths also use **Redis locks** where needed.
- **Webhook idempotency** is enforced via the `webhook_events` table (`idempotency_key` unique).
- **Audit trail**: `audit_logs`, `admin_action_logs`, and payment rows capture non-secret metadata for investigations.

## Backups

- Schedule `pg_dump` (or managed-backup snapshots) of the PostgreSQL volume (`pgdata` in compose).
- Test restores regularly; escrow state + audit tables are your source of truth in disputes.

## Logging

- JSON-friendly messages go to **stdout** (`logger` utility). In Docker, ship logs to your aggregator (Datadog, CloudWatch, ELK, etc.).

## Architecture (high level)

```
src/
  bots/mainBot/     # main Telegram bot
  bots/reportBot/   # report Telegram bot
  modules/          # deals, payments, reports, users, …
  services/         # fees, audit, escrow state machine
  payments/         # mock + provider skeletons
  jobs/             # polling watchers
  workers/          # BullMQ notification worker
  server/           # Express (health + webhooks)
  db/               # Prisma client
  config/           # env validation
```

## License

Proprietary / your organization — configure and deploy per your compliance program.
