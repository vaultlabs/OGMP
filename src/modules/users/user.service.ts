import type { User } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

export type OgmpBotSource = "main" | "report";

export async function ensureTelegramMember(input: {
  telegramId: bigint;
  username?: string;
  firstName?: string;
  bot: OgmpBotSource;
}): Promise<User> {
  const now = new Date();
  const existing = await prisma.user.findUnique({ where: { telegramId: input.telegramId } });

  let lastSeenUsername = existing?.lastSeenUsername ?? null;
  let usernameChangeCount = existing?.usernameChangeCount ?? 0;
  const newUsername = input.username?.trim() || null;
  if (newUsername && existing?.username && existing.username !== newUsername) {
    lastSeenUsername = existing.username;
    usernameChangeCount += 1;
  } else if (!lastSeenUsername && existing?.username) {
    lastSeenUsername = existing.username;
  }

  const botPatch =
    input.bot === "main"
      ? { registeredOnMainBot: true, lastSeenMainBotAt: now }
      : { registeredOnReportBot: true, lastSeenReportBotAt: now };

  return prisma.user.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      username: input.username,
      firstName: input.firstName,
      lastSeenUsername: newUsername,
      registeredOnMainBot: input.bot === "main",
      registeredOnReportBot: input.bot === "report",
      lastSeenMainBotAt: input.bot === "main" ? now : null,
      lastSeenReportBotAt: input.bot === "report" ? now : null,
    },
    update: {
      username: input.username,
      firstName: input.firstName,
      lastSeenUsername,
      usernameChangeCount,
      ...botPatch,
    },
  });
}

/** @deprecated Prefer ensureTelegramMember with explicit bot source. */
export async function upsertTelegramUser(input: {
  telegramId: bigint;
  username?: string;
  firstName?: string;
}): Promise<User> {
  return ensureTelegramMember({ ...input, bot: "main" });
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

export async function banUserByTelegramId(telegramId: bigint, reason: string): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramId },
    data: { banned: true, bannedReason: reason },
  });
}

export async function unbanUserByTelegramId(telegramId: bigint): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramId },
    data: { banned: false, bannedReason: null },
  });
}
