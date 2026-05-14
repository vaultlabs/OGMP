# OGMP MM — Production checklist

Use this before pointing real users or funds at the system.

## Core configuration

- [ ] Set `MAIN_BOT_TOKEN` (or legacy `TELEGRAM_BOT_TOKEN`) from @BotFather.
- [ ] Set `OGMP_MM_REPORT_BOT_TOKEN` if you use the separate REPORT bot.
- [ ] Set `ADMIN_IDS` / `ADMIN_TELEGRAM_IDS` (comma-separated numeric Telegram user IDs).
- [ ] Set `DATABASE_URL` to production PostgreSQL (TLS URL if your host requires it).
- [ ] Set `REDIS_URL` to production Redis (enable persistence if you care about surviving Redis restarts).
- [ ] Set `PAYMENT_PROVIDER` (`mock` only for local dev; `nowpayments` for real flows).
- [ ] Set `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and `PUBLIC_BASE_URL` when using NOWPayments.
- [ ] Set `WEBHOOK_SECRET` and any provider-specific secrets; never commit them to git.
- [ ] Set `HIGH_VALUE_DEAL_THRESHOLD` and `REQUIRE_ADMIN_APPROVAL_FOR_HIGH_VALUE` if you use the high-value gate (DB settings can override later).

## Gateway and public identity

- [ ] Configure gateway: `REQUIRE_GATEWAY_JOIN`, `GATEWAY_JOIN_URL`, optional `GATEWAY_CHAT_ID` for strict membership checks.
- [ ] Set `BOT_PUBLIC_USERNAME` / `REPORT_BOT_USERNAME` for deep links.
- [ ] Set `SUPPORT_USERNAME` and run `/admin_official @handles` so the Support screen lists trusted admins.

## Database and migrations

- [ ] Run `npx prisma migrate deploy` on the production database.
- [ ] Run `npm run db:setup` or seed supported coins if this is a fresh environment.
- [ ] Confirm `initDefaultSettings()` ran once (app startup) so default bot settings rows exist.

## Launch hardening (verify in staging)

These behaviors are enforced in code; confirm them once before production traffic.

- [ ] **Buyer file gate**: until the deal has a payment-confirmed timestamp (`fundedAt`), the buyer must not see Telegram `file_id` values in the deal room / proof log (seller pre-fund uploads stay payment-locked).
- [ ] **Delivery DM bundle** only sends after `fundedAt` is set (same bar as on-chain confirmation).
- [ ] **Concurrent payment sync / double buyer confirm**: rapid webhook or double-tap does not double-advance the deal (per-deal Redis locks).
- [ ] **Disputes and reports** put the deal on admin hold (`frozen`) immediately when opened/submitted.
- [ ] **Admin payout completed** requires a transaction hash or admin note in `/admin_payout_update`.
- [ ] **Admin broadcasts** and **`/setbadge`** write rows to `admin_action_logs` when executed.

## Functional smoke tests

- [ ] `/start` as a normal user: gateway (if enabled), terms, main menu.
- [ ] Create deal wizard completes; **maintenance mode** blocks new deals for non-admins when enabled.
- [ ] Join deal via invite; both sides accept terms; **buyer/seller accepted** shows on deal card.
- [ ] High-value path: deal above threshold shows **admin approval** message; `/admin_hv_approve` issues payment address when configured.
- [ ] Seller locks delivery; buyer sees payment address; **copy buttons** return `<code>` snippets.
- [ ] `.txt` / document upload in Deal room; rate limit does not block normal use.
- [ ] Payment confirmation (mock webhook or provider sandbox) moves deal to funded and unlock flow runs.
- [ ] Seller **payout checks** (1–3) save `sellerPayoutConfirmedAt` when double-confirm is required.
- [ ] Buyer confirm / admin release respects **payout wallet** rules (`/admin_double_payout on` in production if you want strict confirmation).
- [ ] Open Case / REPORT bot flow; append evidence.
- [ ] Admin: force release / force refund on test deals; `/admin_export_deal` produces a `.txt` bundle.
- [ ] `/admin_payout_update` marks payout **completed** and seller receives the “payout sent” style DM.
- [ ] `/finddeal` returns only your deals as a user; admins see broader matches.

## Operations

- [ ] Schedule **Postgres backups** (`pg_dump` or managed snapshots); test a restore to a staging DB.
- [ ] Decide Redis durability (AOF/snapshot); document expected loss window for wizards and rate-limit keys.
- [ ] Ship **stdout logs** to your aggregator; optionally wire `src/services/monitoring.hooks.ts` to Sentry / Logtail / Datadog.
- [ ] Set up uptime checks on HTTP health and payment webhook endpoint.

## Post-launch

- [ ] Monitor `payment_address_deferred_high_value`, `suspicious_flag_appended`, and `bot_error` log lines.
- [ ] Review `admin_action_logs` and `audit_logs` periodically for abuse patterns.
