import type { User } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

export async function upsertTelegramUser(input: {
  telegramId: bigint;
  username?: string;
  firstName?: string;
}): Promise<User> {
  return prisma.user.upsert({
    where: { telegramId: input.telegramId },
    create: {
      telegramId: input.telegramId,
      username: input.username,
      firstName: input.firstName,
    },
    update: {
      username: input.username,
      firstName: input.firstName,
    },
  });
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
