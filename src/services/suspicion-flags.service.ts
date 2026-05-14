import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

export type SuspiciousFlag = { code: string; detail?: string; at: string };

function parseFlags(raw: unknown): SuspiciousFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (typeof x !== "object" || !x) return null;
      const o = x as Record<string, unknown>;
      if (typeof o.code !== "string") return null;
      return {
        code: o.code,
        detail: typeof o.detail === "string" ? o.detail : undefined,
        at: typeof o.at === "string" ? o.at : new Date().toISOString(),
      } as SuspiciousFlag;
    })
    .filter((x): x is SuspiciousFlag => x !== null);
}

export async function appendSuspiciousFlag(userId: string, code: string, detail?: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) return;
  const cur = parseFlags(u.suspiciousFlags);
  const next: SuspiciousFlag[] = [...cur, { code, detail, at: new Date().toISOString() }].slice(-40);
  await prisma.user.update({
    where: { id: userId },
    data: { suspiciousFlags: next as unknown as Prisma.InputJsonValue },
  });
  logger.warn("suspicious_flag_appended", { userId, code, detail });
}

export async function flagHighValueNewUser(userId: string, amount: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) return;
  const joinedHours = (Date.now() - u.joinedAt.getTime()) / 36e5;
  if (joinedHours > 72) return;
  await appendSuspiciousFlag(userId, "HIGH_VALUE_NEW_USER", `amount=${amount}, joined_hours≈${joinedHours.toFixed(1)}`);
}

export async function scanSharedPayoutAddress(address: string): Promise<void> {
  const norm = address.trim().toLowerCase();
  if (norm.length < 8) return;
  const deals = await prisma.deal.findMany({
    where: { sellerPayoutAddress: { equals: address, mode: "insensitive" } },
    select: { sellerId: true },
    distinct: ["sellerId"],
    take: 30,
  });
  if (deals.length < 3) return;
  for (const d of deals) {
    if (d.sellerId) await appendSuspiciousFlag(d.sellerId, "SHARED_PAYOUT_ADDRESS", norm.slice(0, 14) + "…");
  }
}
