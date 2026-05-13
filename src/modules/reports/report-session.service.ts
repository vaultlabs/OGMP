import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { loadConfig } from "../../config/index.js";
import { NotFoundError, ValidationError } from "../../utils/errors.js";

export function hashReportToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createReportSession(params: {
  dealId: string;
  userId: string;
}): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = randomBytes(24).toString("base64url");
  const tokenHash = hashReportToken(rawToken);
  const mins = loadConfig().REPORT_SESSION_EXPIRY_MINUTES;
  const expiresAt = new Date(Date.now() + mins * 60 * 1000);
  await prisma.reportSession.create({
    data: {
      dealId: params.dealId,
      userId: params.userId,
      tokenHash,
      expiresAt,
    },
  });
  return { rawToken, expiresAt };
}

export type ValidatedReportSession = {
  sessionId: string;
  dealId: string;
  userId: string;
};

export async function validateReportStartToken(
  rawToken: string,
  telegramUserId: bigint,
): Promise<ValidatedReportSession> {
  const hash = hashReportToken(rawToken);
  const session = await prisma.reportSession.findUnique({
    where: { tokenHash: hash },
    include: { user: true, deal: true },
  });
  if (!session) throw new NotFoundError("Invalid or expired report link.");
  if (session.expiresAt < new Date()) throw new ValidationError("Report link expired.");
  if (session.usedAt) throw new ValidationError("This report link was already used.");
  if (session.user.telegramId !== telegramUserId) {
    throw new ValidationError("This report link is tied to another Telegram account.");
  }
  return { sessionId: session.id, dealId: session.dealId, userId: session.userId };
}

export async function markReportSessionUsed(sessionId: string): Promise<void> {
  await prisma.reportSession.update({
    where: { id: sessionId },
    data: { usedAt: new Date() },
  });
}
