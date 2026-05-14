import { prisma } from "../db/prisma.js";
import { getRedis } from "../utils/redis.js";
import { getReportBotToken } from "../config/index.js";
import { getLastPaymentWatchAt, isMaintenanceEnabled } from "./platform-settings.service.js";

export async function buildSystemStatusLines(isAdmin: boolean): Promise<string[]> {
  let db = "unknown";
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = "ok";
  } catch {
    db = "error";
  }
  let redis = "unknown";
  try {
    const p = await getRedis().ping();
    redis = p === "PONG" ? "ok" : String(p);
  } catch {
    redis = "error";
  }
  const reportBot = getReportBotToken() ? "configured" : "not configured";
  const maint = (await isMaintenanceEnabled()) ? "ON" : "OFF";
  const lastPay = await getLastPaymentWatchAt();
  const lastPayLine = lastPay ? new Date(lastPay).toISOString() : "—";
  const payAge =
    lastPay != null ? `${Math.max(0, Math.round((Date.now() - lastPay) / 1000))}s ago` : "never recorded";

  const base = [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — System status",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `Main bot: running`,
    `Payment checker: last run ${payAge}`,
    `Report bot: ${reportBot}`,
    `Redis: ${redis}`,
    `Database: ${db}`,
    `Maintenance: ${maint}`,
    `Last payment watch (UTC): ${lastPayLine}`,
  ];
  if (!isAdmin) return base;
  return [
    ...base,
    "",
    "Admin detail:",
    `• DB ping: ${db}`,
    `• Redis ping: ${redis}`,
    `• Payment watcher records timestamp after each sweep (up to 50 waiting deals).`,
    `• Maintenance blocks new deal creation only; existing deals stay readable.`,
  ];
}
