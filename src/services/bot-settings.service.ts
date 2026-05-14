import { prisma } from "../db/prisma.js";
import { loadConfig } from "../config/index.js";
import { BOT_KEYS } from "./platform-settings.service.js";

const KEYS = {
  AUTO_RELEASE_ENABLED: "AUTO_RELEASE_ENABLED",
} as const;

export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const row = await prisma.botSetting.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value === "true" || row.value === "1";
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.botSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function isAutoReleaseEnabled(): Promise<boolean> {
  const env = loadConfig().AUTO_RELEASE_ENABLED;
  const db = await getBooleanSetting(KEYS.AUTO_RELEASE_ENABLED, env);
  return db;
}

export async function initDefaultSettings(): Promise<void> {
  const cfg = loadConfig();
  const defaults: { key: string; value: string }[] = [
    { key: KEYS.AUTO_RELEASE_ENABLED, value: String(cfg.AUTO_RELEASE_ENABLED) },
    { key: BOT_KEYS.MAINTENANCE_ENABLED, value: "false" },
    {
      key: BOT_KEYS.DEAL_LIMITS_JSON,
      value: JSON.stringify({
        minDealUsd: "1",
        maxNewUserUsd: "250",
        maxVerifiedUserUsd: "50000",
        dailyDealsPerUser: 20,
        maxActiveDealsPerUser: 15,
      }),
    },
    { key: BOT_KEYS.OFFICIAL_SUPPORT_USERNAMES_JSON, value: "[]" },
    { key: BOT_KEYS.PAYOUT_REQUIRE_DOUBLE_CONFIRM, value: "false" },
    { key: BOT_KEYS.JOIN_EXPIRY_HOURS, value: "72" },
    { key: BOT_KEYS.TERMS_EXPIRY_HOURS, value: "72" },
  ];
  for (const d of defaults) {
    const existing = await prisma.botSetting.findUnique({ where: { key: d.key } });
    if (!existing) {
      await prisma.botSetting.create({ data: { key: d.key, value: d.value } });
    }
  }
}
