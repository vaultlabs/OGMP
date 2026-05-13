import { prisma } from "../../db/prisma.js";
import { writeAuditLog } from "../../services/audit.service.js";

export async function createSupportTicket(params: {
  userId: string;
  issueType: string;
  message: string;
  dealCode?: string;
  fileId?: string;
}): Promise<void> {
  await prisma.supportTicket.create({
    data: {
      userId: params.userId,
      issueType: params.issueType,
      message: params.message,
      dealCode: params.dealCode,
      fileId: params.fileId,
    },
  });
  await writeAuditLog({
    eventType: "support_ticket_created",
    userId: params.userId,
    metadata: { issueType: params.issueType, dealCode: params.dealCode },
  });
}
