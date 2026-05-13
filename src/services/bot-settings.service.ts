import { prisma } from "../db/prisma.js";
import { loadConfig } from "../config/index.js";

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
  const existing = await prisma.botSetting.findUnique({
    where: { key: KEYS.AUTO_RELEASE_ENABLED },
  });
  if (!existing) {
    await prisma.botSetting.create({
      data: { key: KEYS.AUTO_RELEASE_ENABLED, value: String(cfg.AUTO_RELEASE_ENABLED) },
    });
  }
}
