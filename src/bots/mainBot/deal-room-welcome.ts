import { prisma } from "../../db/prisma.js";
import { userFacingDealStatus, userFacingDeliveryState } from "../../modules/deals/user-facing-status.js";
import { COMMUNITY_TRUST_LINE, TRUST_OPS_FOOTER } from "./trust-copy.js";

function lineUser(u: { username: string | null; firstName: string | null; telegramId: bigint } | null): string {
  if (!u) return "(pending)";
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un})`;
}

/** Plain-text banner when entering the in-chat deal room (no HTML). */
export async function formatDealRoomEntryPlain(dealId: string): Promise<string> {
  const d = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, activeReport: true },
  });
  if (!d) return "Deal not found.";
  const sellerLockedCount = d.sellerId
    ? await prisma.dealMessage.count({
        where: { dealId, lockedForBuyer: true, senderId: d.sellerId },
      })
    : 0;
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  const displayStatus = userFacingDealStatus(d, {
    hasLockedDelivery: sellerLockedCount > 0,
    paymentStatus: pay?.status ?? null,
  });
  const delivery = userFacingDeliveryState(d.status, sellerLockedCount > 0);
  const payLine = pay ? pay.status.replace(/_/g, " ") : "—";
  const caseLine = d.activeReport
    ? `${d.activeReport.reportCode} (${d.activeReport.status.replace(/_/g, " ")})`
    : "none open";
  const protection = d.frozen ? "paused — Case Review" : "on";
  return [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Deal Room",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `Deal ID: ${d.dealCode}`,
    `Status: ${displayStatus}`,
    `Buyer: ${lineUser(d.buyer)}`,
    `Seller: ${lineUser(d.seller)}`,
    `Amount: ${d.amount.toString()} ${d.currency}`,
    `Network: ${d.network}`,
    `Delivery Vault: ${delivery}`,
    `Escrow step: ${payLine}`,
    `Deal Protection: ${protection}`,
    `Case Review: ${caseLine}`,
    "",
    "What: chat + uploads for this deal.",
    "Safe: keep payment and files inside OGMP MM only.",
    "Next: use deal card buttons, or upload here as seller — /done_room when finished.",
    "",
    COMMUNITY_TRUST_LINE,
    "",
    TRUST_OPS_FOOTER,
  ].join("\n");
}
