import type { User } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { appendSuspiciousFlag } from "../../services/suspicion-flags.service.js";
import { logAdminAction } from "../admin/admin.repository.js";

export async function upsertTelegramUser(input: {
  telegramId: bigint;
  username?: string;
  firstName?: string;
}): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { telegramId: input.telegramId } });
  const oldUn = existing?.username ?? "";
  const newUn = input.username ?? "";
  const changed = !!existing && oldUn !== newUn;

  const user = await prisma.user.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      username: input.username,
      firstName: input.firstName,
    },
    update: {
      username: input.username,
      firstName: input.firstName,
      ...(changed ? { usernameChangeCount: { increment: 1 }, lastSeenUsername: newUn || oldUn || null } : {}),
    },
  });
  if (changed && user.usernameChangeCount >= 4) {
    void appendSuspiciousFlag(user.id, "USERNAME_CHURN", `to=${newUn}`).catch(() => {});
  }
  return user;
}

export async function acceptTermsForUser(telegramId: bigint): Promise<User> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) throw new Error("User not found");
  return prisma.user.update({
    where: { id: user.id },
    data: { termsAcceptedAt: new Date() },
  });
}

export async function findUserByTelegramId(telegramId: bigint): Promise<User | null> {
  return prisma.user.findUnique({ where: { telegramId } });
}

export async function markUserGatewayAccess(input: {
  userId: string;
  verified: boolean;
}): Promise<User> {
  const now = new Date();
  return prisma.user.update({
    where: { id: input.userId },
    data: {
      gatewayAcceptedAt: now,
      gatewayVerified: input.verified,
      gatewayVerifiedAt: input.verified ? now : null,
    },
  });
}

export async function banUserByTelegramId(
  telegramId: bigint,
  reason: string,
  adminTelegramId: bigint,
): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramId },
    data: { banned: true, bannedReason: reason },
  });
  await logAdminAction({
    adminTelegramId,
    action: "user_ban",
    targetTelegramId: telegramId,
    metadata: { reason },
  });
}

export async function unbanUserByTelegramId(telegramId: bigint, adminTelegramId: bigint): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramId },
    data: { banned: false, bannedReason: null },
  });
  await logAdminAction({
    adminTelegramId,
    action: "user_unban",
    targetTelegramId: telegramId,
  });
}
