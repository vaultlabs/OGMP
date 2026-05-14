import { prisma } from "../db/prisma.js";

function line(s: string): string {
  return s;
}

/** Plain-text export for admin case review (attach as .txt). */
export async function buildDealCaseExportText(dealCode: string): Promise<string> {
  const deal = await prisma.deal.findUnique({
    where: { dealCode },
    include: {
      buyer: true,
      seller: true,
      creator: true,
      payments: { orderBy: { createdAt: "desc" }, take: 5 },
      payouts: { orderBy: { createdAt: "desc" }, take: 5 },
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
      timeline: { orderBy: { createdAt: "asc" }, take: 200 },
      reports: { include: { evidence: true, adminNotes: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!deal) return "Deal not found.";
  const parts: string[] = [];
  parts.push(line("=== OGMP MM — DEAL CASE EXPORT ==="));
  parts.push(`Deal code: ${deal.dealCode}`);
  parts.push(`Status: ${deal.status}`);
  parts.push(`Amount: ${deal.amount} ${deal.currency} ${deal.network}`);
  parts.push(`Frozen: ${deal.frozen} ${deal.frozenReason ?? ""}`);
  parts.push(`High-value approval: ${deal.highValueApproval ?? "n/a"}`);
  parts.push("");
  parts.push("--- Parties ---");
  parts.push(`Buyer: ${deal.buyer?.telegramId} ${deal.buyer?.username ?? ""}`);
  parts.push(`Seller: ${deal.seller?.telegramId} ${deal.seller?.username ?? ""}`);
  parts.push(`Creator: ${deal.creator.telegramId}`);
  parts.push("");
  parts.push("--- Payments ---");
  for (const p of deal.payments) {
    parts.push(
      `${p.id} ${p.status} exp=${p.expiresAt?.toISOString() ?? "—"} addr=${p.address ?? "—"} tx=${p.txHash ?? "—"}`,
    );
  }
  parts.push("");
  parts.push("--- Payouts ---");
  for (const o of deal.payouts) {
    parts.push(`${o.id} ${o.status} to=${o.toAddress} tx=${o.txHash ?? "—"} note=${o.adminNote ?? "—"}`);
  }
  parts.push("");
  parts.push("--- Timeline ---");
  for (const e of deal.timeline) {
    parts.push(`${e.createdAt.toISOString()} ${e.eventType} ${JSON.stringify(e.metadataJson ?? {})}`);
  }
  parts.push("");
  parts.push("--- Delivery / deal room files (metadata only) ---");
  for (const m of deal.messages) {
    parts.push(
      `${m.createdAt.toISOString()} ${m.messageType} from=${m.senderId} locked=${m.lockedForBuyer} name=${m.fileName ?? ""}`,
    );
  }
  parts.push("");
  parts.push("--- Reports ---");
  for (const r of deal.reports) {
    parts.push(`Report ${r.reportCode} status=${r.status} cat=${r.category}`);
    for (const ev of r.evidence) {
      parts.push(`  evidence ${ev.createdAt.toISOString()} ${ev.evidenceType} ${ev.fileName ?? ""}`);
    }
    for (const n of r.adminNotes) {
      parts.push(`  admin note ${n.createdAt.toISOString()}: ${n.note}`);
    }
  }
  parts.push("");
  parts.push("=== END EXPORT ===");
  return parts.join("\n");
}
