import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { loadConfig } from "../config/index.js";

export const BOT_KEYS = {
  MAINTENANCE_ENABLED: "ogmp.maintenance.enabled",
  MAINTENANCE_MESSAGE: "ogmp.maintenance.message",
  DEAL_LIMITS_JSON: "ogmp.deal_limits.json",
  OFFICIAL_SUPPORT_USERNAMES_JSON: "ogmp.official_support_usernames.json",
  JOIN_EXPIRY_HOURS: "ogmp.join_expiry_hours",
  TERMS_EXPIRY_HOURS: "ogmp.terms_expiry_hours",
  HIGH_VALUE_THRESHOLD_USD: "ogmp.high_value.threshold_usd",
  REQUIRE_HIGH_VALUE_APPROVAL: "ogmp.high_value.require_approval",
  LAST_PAYMENT_WATCH_AT: "ogmp.sys.last_payment_watch_at",
  PAYOUT_REQUIRE_DOUBLE_CONFIRM: "ogmp.payout.require_double_confirm",
} as const;

export type DealLimitsJson = {
  minDealUsd?: string;
  maxNewUserUsd?: string;
  maxVerifiedUserUsd?: string;
  dailyDealsPerUser?: number;
  maxActiveDealsPerUser?: number;
};

const DEFAULT_DEAL_LIMITS: DealLimitsJson = {
  minDealUsd: "1",
  maxNewUserUsd: "250",
  maxVerifiedUserUsd: "50000",
  dailyDealsPerUser: 20,
  maxActiveDealsPerUser: 15,
};

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.botSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.botSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function isMaintenanceEnabled(): Promise<boolean> {
  const v = await getSetting(BOT_KEYS.MAINTENANCE_ENABLED);
  return v === "true" || v === "1";
}

export async function getMaintenanceCustomMessage(): Promise<string | null> {
  const v = await getSetting(BOT_KEYS.MAINTENANCE_MESSAGE);
  return v?.trim() ? v.trim() : null;
}

export async function setMaintenanceEnabled(on: boolean): Promise<void> {
  await setSetting(BOT_KEYS.MAINTENANCE_ENABLED, on ? "true" : "false");
}

export async function setMaintenanceMessage(text: string): Promise<void> {
  await setSetting(BOT_KEYS.MAINTENANCE_MESSAGE, text.slice(0, 2000));
}

export async function getDealLimits(): Promise<DealLimitsJson> {
  const raw = await getSetting(BOT_KEYS.DEAL_LIMITS_JSON);
  if (!raw) return { ...DEFAULT_DEAL_LIMITS };
  try {
    return { ...DEFAULT_DEAL_LIMITS, ...(JSON.parse(raw) as DealLimitsJson) };
  } catch {
    return { ...DEFAULT_DEAL_LIMITS };
  }
}

export async function setDealLimitsJson(obj: DealLimitsJson): Promise<void> {
  await setSetting(BOT_KEYS.DEAL_LIMITS_JSON, JSON.stringify({ ...DEFAULT_DEAL_LIMITS, ...obj }));
}

export async function getOfficialSupportUsernames(): Promise<string[]> {
  const raw = await getSetting(BOT_KEYS.OFFICIAL_SUPPORT_USERNAMES_JSON);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.map((x) => String(x).replace(/^@+/, "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function setOfficialSupportUsernames(usernames: string[]): Promise<void> {
  const cleaned = usernames.map((u) => u.replace(/^@+/, "").trim()).filter(Boolean);
  await setSetting(BOT_KEYS.OFFICIAL_SUPPORT_USERNAMES_JSON, JSON.stringify(cleaned));
}

export async function getJoinExpiryHours(): Promise<number> {
  const v = await getSetting(BOT_KEYS.JOIN_EXPIRY_HOURS);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 720) : 72;
}

export async function getTermsExpiryHours(): Promise<number> {
  const v = await getSetting(BOT_KEYS.TERMS_EXPIRY_HOURS);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 720) : 72;
}

export async function getHighValueThresholdUsd(): Promise<Prisma.Decimal> {
  const cfg = loadConfig();
  const db = await getSetting(BOT_KEYS.HIGH_VALUE_THRESHOLD_USD);
  const raw = db?.trim() || cfg.HIGH_VALUE_DEAL_THRESHOLD?.trim();
  if (!raw) return new Prisma.Decimal("5000");
  return new Prisma.Decimal(raw);
}

export async function getRequireHighValueApproval(): Promise<boolean> {
  const cfg = loadConfig();
  const db = await getSetting(BOT_KEYS.REQUIRE_HIGH_VALUE_APPROVAL);
  if (db === "true" || db === "1") return true;
  if (db === "false" || db === "0") return false;
  return cfg.REQUIRE_ADMIN_APPROVAL_FOR_HIGH_VALUE;
}

export async function setRequireHighValueApproval(v: boolean): Promise<void> {
  await setSetting(BOT_KEYS.REQUIRE_HIGH_VALUE_APPROVAL, v ? "true" : "false");
}

export async function setHighValueThresholdUsd(s: string): Promise<void> {
  await setSetting(BOT_KEYS.HIGH_VALUE_THRESHOLD_USD, s);
}

export async function getRequirePayoutDoubleConfirm(): Promise<boolean> {
  const v = await getSetting(BOT_KEYS.PAYOUT_REQUIRE_DOUBLE_CONFIRM);
  return v === "true" || v === "1";
}

export async function setRequirePayoutDoubleConfirm(on: boolean): Promise<void> {
  await setSetting(BOT_KEYS.PAYOUT_REQUIRE_DOUBLE_CONFIRM, on ? "true" : "false");
}

export async function touchLastPaymentWatch(): Promise<void> {
  await setSetting(BOT_KEYS.LAST_PAYMENT_WATCH_AT, String(Date.now()));
}

export async function getLastPaymentWatchAt(): Promise<number | null> {
  const v = await getSetting(BOT_KEYS.LAST_PAYMENT_WATCH_AT);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
