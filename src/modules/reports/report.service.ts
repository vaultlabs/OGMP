import type { ParticipantRole, ReportCategory, ReportStatus } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { allocateReportCode } from "./report-code.service.js";
import { appendDealTimelineEvent } from "../dealTimeline/timeline.service.js";
import { writeAuditLog } from "../../services/audit.service.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { assertFileAllowed } from "../../utils/file-safety.js";
import { enqueueAdminReportSubmitted, enqueueDealParticipantNotify } from "../notifications/notificationQueue.service.js";

/** Submitted / in-review only — drafts do not block the main bot "Report deal" flow. */
const SUBMITTED_REVIEW_REPORT_STATUSES: ReportStatus[] = [
  "submitted",
  "under_review",
  "waiting_for_buyer",
  "waiting_for_seller",
];

export async function findSubmittedReviewReportForDeal(dealId: string) {
  return prisma.report.findFirst({
    where: { dealId, status: { in: SUBMITTED_REVIEW_REPORT_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
}

export async function assertCanOpenNewReport(dealId: string, userId: string): Promise<void> {
  const existing = await findSubmittedReviewReportForDeal(dealId);
  if (existing) {
    throw new ConflictError(
      "This deal is already under review. Add more evidence through the OGMP MM REPORT bot until an admin closes the report.",
    );
  }
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.buyerId !== userId && deal.sellerId !== userId) {
    throw new ForbiddenError("Only the buyer or seller can start a report for this deal.");
  }
}

export async function createDraftReport(params: {
  dealId: string;
  reporterId: string;
  reporterRole: ParticipantRole;
  category: ReportCategory;
  description: string;
}): Promise<{ id: string; reportCode: string }> {
  const year = new Date().getUTCFullYear();
  const reportCode = await allocateReportCode(year);
  const r = await prisma.report.create({
    data: {
      reportCode,
      dealId: params.dealId,
      reporterId: params.reporterId,
      reporterRole: params.reporterRole,
      category: params.category,
      description: params.description,
      status: "draft",
    },
  });
  return { id: r.id, reportCode: r.reportCode };
}

export async function appendReportEvidence(params: {
  reportId: string;
  uploaderId: string;
  evidenceType: string;
  text?: string;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  caption?: string | null;
}): Promise<void> {
  assertFileAllowed({
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
  });
  await prisma.reportEvidence.create({
    data: {
      reportId: params.reportId,
      uploaderId: params.uploaderId,
      evidenceType: params.evidenceType,
      text: params.text ?? "",
      telegramFileId: params.telegramFileId ?? undefined,
      telegramFileUniqueId: params.telegramFileUniqueId ?? undefined,
      fileName: params.fileName ?? undefined,
      mimeType: params.mimeType ?? undefined,
      fileSize: params.fileSize ?? undefined,
      caption: params.caption ?? undefined,
    },
  });
}

export async function submitReportAndFreezeDeal(reportId: string): Promise<void> {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: { deal: true },
  });
  if (!report) throw new NotFoundError("Report not found");
  if (report.status !== "draft") throw new ValidationError("Report already submitted.");
  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: reportId },
      data: { status: "submitted", updatedAt: new Date() },
    });
    await tx.deal.update({
      where: { id: report.dealId },
      data: {
        frozen: true,
        frozenAt: new Date(),
        frozenReason: `Report ${report.reportCode} submitted`,
        activeReportId: reportId,
        version: { increment: 1 },
      },
    });
  });
  await appendDealTimelineEvent({
    dealId: report.dealId,
    actorId: report.reporterId,
    eventType: "report_opened",
    metadata: { reportCode: report.reportCode, reportId: report.id },
  });
  await appendDealTimelineEvent({
    dealId: report.dealId,
    eventType: "deal_frozen",
    metadata: { reportCode: report.reportCode },
  });
  await writeAuditLog({
    eventType: "report_submitted",
    userId: report.reporterId,
    dealId: report.dealId,
    metadata: { reportCode: report.reportCode },
  });
  await enqueueAdminReportSubmitted(reportId);
  const d = await prisma.deal.findUnique({
    where: { id: report.dealId },
    include: { buyer: true, seller: true },
  });
  if (d) {
    const line = `⚖ A *report* was filed on deal \`${d.dealCode}\` (${report.reportCode}). The deal is *frozen* pending admin review.`;
    for (const u of [d.buyer, d.seller]) {
      if (!u) continue;
      await enqueueDealParticipantNotify({
        targetTelegramId: u.telegramId,
        text: line,
        parseMode: "Markdown",
      });
    }
  }
}

export async function adminResolveReport(params: {
  reportId: string;
  adminTelegramId: bigint;
  newStatus: ReportStatus;
  note: string;
  dealAction?: "unfreeze" | "release" | "refund" | "partial";
}): Promise<void> {
  const report = await prisma.report.findUnique({
    where: { id: params.reportId },
    include: { deal: true },
  });
  if (!report) throw new NotFoundError("Report not found");
  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: params.reportId },
      data: {
        status: params.newStatus,
        resolvedAt: (
          [
            "resolved_release",
            "resolved_refund",
            "resolved_partial",
            "rejected",
            "closed",
          ] as ReportStatus[]
        ).includes(params.newStatus)
          ? new Date()
          : undefined,
        assignedAdminTelegramId: params.adminTelegramId,
      },
    });
    await tx.reportAdminNote.create({
      data: {
        reportId: params.reportId,
        adminTelegramId: params.adminTelegramId,
        note: params.note,
      },
    });
    if (params.dealAction === "unfreeze" || params.newStatus.startsWith("resolved")) {
      await tx.deal.update({
        where: { id: report.dealId },
        data: {
          frozen: false,
          frozenAt: null,
          frozenReason: null,
          activeReportId: null,
          version: { increment: 1 },
        },
      });
    }
  });
}

export async function loadReportForAdmin(reportId: string) {
  return prisma.report.findUnique({
    where: { id: reportId },
    include: {
      deal: { include: { buyer: true, seller: true } },
      reporter: true,
      evidence: { orderBy: { createdAt: "asc" } },
      adminNotes: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function addReportAdminNote(
  reportId: string,
  adminTelegramId: bigint,
  note: string,
): Promise<void> {
  await prisma.reportAdminNote.create({
    data: { reportId, adminTelegramId, note },
  });
}
