import { Prisma } from "@prisma/client";
import { logger } from "../../utils/logger.js";

async function db() {
  return (await import("../../db/prisma.js")).prisma;
}

export async function logAdminAction(params: {
  adminTelegramId: bigint;
  action: string;
  dealId?: string | null;
  targetTelegramId?: bigint | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await (await db()).adminActionLog.create({
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
