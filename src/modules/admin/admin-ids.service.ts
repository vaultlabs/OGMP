import { logAdminAction } from "./admin.repository.js";
import { ForbiddenError } from "../../utils/errors.js";

async function db() {
  const { prisma } = await import("../../db/prisma.js");
  return prisma;
}

const SETTING_KEY = "EXTRA_ADMIN_IDS";

function parseIds(raw: string): bigint[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return BigInt(s);
      } catch {
        return null;
      }
    })
    .filter((x): x is bigint => x !== null);
}

function envAdminIds(): Set<string> {
  const merged = [process.env.ADMIN_IDS ?? "", process.env.ADMIN_TELEGRAM_IDS ?? ""].filter(Boolean).join(",");
  return new Set(parseIds(merged).map((b) => b.toString()));
}

/** In-memory cache of admins added via bot (refreshed on boot and on add/remove). */
let extraAdminIds = new Set<string>();

export async function refreshExtraAdminIdsCache(): Promise<void> {
  const row = await (await db()).botSetting.findUnique({ where: { key: SETTING_KEY } });
  extraAdminIds = new Set(parseIds(row?.value ?? "").map((b) => b.toString()));
}

export function isAdminTelegramId(telegramId: bigint): boolean {
  const id = telegramId.toString();
  return envAdminIds().has(id) || extraAdminIds.has(id);
}

export function getAllAdminTelegramIds(): string[] {
  return [...new Set([...envAdminIds(), ...extraAdminIds])];
}

function assertCanManageAdmins(actorTelegramId: bigint): void {
  if (!isAdminTelegramId(actorTelegramId)) throw new ForbiddenError("Admin only");
}

export async function addExtraAdmin(actorTelegramId: bigint, newAdminTelegramId: bigint): Promise<void> {
  assertCanManageAdmins(actorTelegramId);
  await refreshExtraAdminIdsCache();
  const next = new Set(extraAdminIds);
  next.add(newAdminTelegramId.toString());
  await (await db()).botSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: [...next].join(",") },
    update: { value: [...next].join(",") },
  });
  extraAdminIds = next;
  await logAdminAction({
    adminTelegramId: actorTelegramId,
    action: "admin_add",
    metadata: { added: newAdminTelegramId.toString() },
  });
}

export async function removeExtraAdmin(actorTelegramId: bigint, removeTelegramId: bigint): Promise<void> {
  assertCanManageAdmins(actorTelegramId);
  if (envAdminIds().has(removeTelegramId.toString())) {
    throw new ForbiddenError("Cannot remove env ADMIN_IDS admins here — edit .env instead");
  }
  await refreshExtraAdminIdsCache();
  const next = new Set(extraAdminIds);
  next.delete(removeTelegramId.toString());
  await (await db()).botSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: [...next].join(",") },
    update: { value: [...next].join(",") },
  });
  extraAdminIds = next;
  await logAdminAction({
    adminTelegramId: actorTelegramId,
    action: "admin_remove",
    metadata: { removed: removeTelegramId.toString() },
  });
}
