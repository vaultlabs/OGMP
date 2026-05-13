import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";

export async function logAdminAction(params: {
  adminTelegramId: bigint;
  action: string;
  dealId?: string | null;
  targetTelegramId?: bigint | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.adminActionLog.create({
      data: {
        adminTelegramId: params.adminTelegramId,
        action: params.action,
        dealId: params.dealId ?? undefined,
        targetTelegramId: params.targetTelegramId ?? undefined,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (e) {
    logger.error("admin_action_log_failed", { err: String(e), action: params.action });
  }
}
