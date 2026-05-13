/**
 * Friendly check: is .env filled in enough to run the bot?
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

console.log("\n🔍 OGMP MM — quick check\n");

if (!existsSync(envPath)) {
  console.log("❌ There is no .env file yet.\n");
  console.log("👉 Run this first:  npm run first-time\n");
  console.log("   (That makes a new .env file for you.)\n");
  process.exit(1);
}

config({ path: envPath });

const inCodespaces = process.env.CODESPACES === "true";
const dbUrlEarly = process.env.DATABASE_URL ?? "";
const redisEarly = process.env.REDIS_URL ?? "";

if (!inCodespaces && dbUrlEarly.includes("@postgres:")) {
  console.log("\n❌ Wrong place for this DATABASE_URL\n");
  console.log("   Your .env says host **postgres**. That ONLY works inside **GitHub Codespaces** (or Docker),");
  console.log("   NOT in the black CMD window on your own PC.\n");
  console.log("   Pick ONE:\n");
  console.log("   • **GitHub (no Docker on your PC):** Open https://github.com/vaultlabs/OGMP → green **Code** →");
  console.log("     **Codespaces** → **Create codespace** → in *that* browser terminal run `npm run dev`.\n");
  console.log("   • **Stay on your PC:** Change DATABASE_URL to use **localhost** and install PostgreSQL + Redis");
  console.log("     on Windows (no Docker) — see README section *Local Postgres + Redis (no Docker)*.\n");
  process.exit(1);
}

if (!inCodespaces && redisEarly.startsWith("redis://redis:") && !redisEarly.includes("localhost")) {
  console.log("\n❌ Wrong REDIS_URL for your PC\n");
  console.log("   **redis://redis:6379** only works in Codespaces/Docker.");
  console.log("   On your PC use: REDIS_URL=redis://localhost:6379\n");
  process.exit(1);
}

if (inCodespaces) {
  const db = process.env.DATABASE_URL ?? "";
  if (db.includes("localhost") || db.includes("127.0.0.1")) {
    console.log(
      "  ⚠️  You are inside GitHub Codespaces. DATABASE_URL should use hostname postgres, not localhost.",
    );
    console.log("     Example: postgresql://ogmp:ogmp@postgres:5432/ogmp_mm?schema=public\n");
  }
  const red = process.env.REDIS_URL ?? "";
  if (red.includes("localhost") || red.includes("127.0.0.1")) {
    console.log("  ⚠️  In Codespaces use REDIS_URL=redis://redis:6379\n");
  }
}

let bad = 0;

function line(ok, msg) {
  console.log(ok ? `  ✅ ${msg}` : `  ❌ ${msg}`);
  if (!ok) bad += 1;
}

line(!!process.env.DATABASE_URL?.trim(), "DATABASE_URL is filled in");
line(!!process.env.REDIS_URL?.trim(), "REDIS_URL is filled in");

const hasBotToken = !!(process.env.MAIN_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim());
line(hasBotToken, "MAIN_BOT_TOKEN or TELEGRAM_BOT_TOKEN is filled in (from BotFather)");

const hasAdmin = !!(
  process.env.ADMIN_IDS?.trim() ||
  process.env.ADMIN_TELEGRAM_IDS?.trim()
);
line(hasAdmin, "ADMIN_IDS or ADMIN_TELEGRAM_IDS is filled in (your Telegram number)");

line(!!process.env.MOCK_WEBHOOK_SECRET?.trim(), "MOCK_WEBHOOK_SECRET is filled in (any long random text is ok)");

const dbUrl = process.env.DATABASE_URL ?? "";
if (dbUrl.includes("@postgres:") && !dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1") && inCodespaces) {
  console.log("  ℹ️  DATABASE_URL uses hostname postgres — correct for Codespaces.");
}
const redisUrl = process.env.REDIS_URL ?? "";
if (redisUrl.startsWith("redis://redis:") && !redisUrl.includes("localhost") && !redisUrl.includes("127.0.0.1") && inCodespaces) {
  console.log("  ℹ️  REDIS_URL uses redis host — correct for Codespaces.");
}

const reportTok = process.env.OGMP_MM_REPORT_BOT_TOKEN?.trim();
if (reportTok) {
  console.log("  ℹ️  Report bot token is set — the report bot will start too.");
} else {
  console.log("  ℹ️  No report bot token — only the main bot will start (that is ok for testing).");
}

console.log("");
if (bad === 0) {
  const next = inCodespaces
    ? "🎉 Looks good! Run:  npm run dev\n"
    : "🎉 Looks good! Try:  npm run db:setup   then   npm run dev\n";
  console.log(next);
  process.exit(0);
}

console.log(`👉 Fix the ${bad} problem(s) above inside your .env file, then run me again:\n`);
console.log("   npm run check-setup\n");
process.exit(1);
