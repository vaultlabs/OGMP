import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

export async function writeAuditLog(params: {
  eventType: string;
  userId?: string | null;
  dealId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        eventType: params.eventType,
        userId: params.userId ?? undefined,
        dealId: params.dealId ?? undefined,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (e) {
    logger.error("audit_log_failed", { err: String(e), ...params });
  }
}
