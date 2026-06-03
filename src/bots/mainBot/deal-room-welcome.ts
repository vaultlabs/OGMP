import { prisma } from "../../db/prisma.js";
import { userFacingDealStatus, userFacingDeliveryState } from "../../modules/deals/user-facing-status.js";
import { COMMUNITY_TRUST_LINE, TRUST_OPS_FOOTER } from "./trust-copy.js";

function lineUser(u: { username: string | null; firstName: string | null; telegramId: bigint } | null): string {
  if (!u) return "(pending)";
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un})`;
}

function roleNextStep(
  deal: {
    status: string;
    buyerId: string | null;
    sellerId: string | null;
  },
  actorUserId: string | undefined,
  sellerLockedCount: number,
): string {
  if (!actorUserId) {
    return "Next: use deal card buttons, or upload here as seller — /done_room when finished.";
  }
  const isSeller = deal.sellerId === actorUserId;
  const isBuyer = deal.buyerId === actorUserId;

  if (isBuyer && (deal.status === "waiting_payment" || deal.status === "payment_detected")) {
    if (sellerLockedCount > 0) {
      return "Next: open Payment Required (DM) or View deal → pay escrow. You do not upload delivery — the seller already locked files.";
    }
    return "Next: wait for the seller to upload and lock product files. You will get Payment Required when the vault is ready — do not pay until then.";
  }

  if (isSeller && (deal.status === "waiting_payment" || deal.status === "payment_detected")) {
    if (sellerLockedCount > 0) {
      return "Next: add more files if needed, then Submit Delivery on the deal card so the buyer gets Payment Required.";
    }
    return "Next: send photo, video, or document (or .zip) here to lock the Delivery Vault. Text alone does not lock. Then Submit Delivery.";
  }

  if (isBuyer) {
    return "Next: use deal card buttons (Download, Release, Open Case). Chat here if you need to message the seller.";
  }
  if (isSeller) {
    return "Next: use deal card buttons, or upload/chat here — /done_room when finished.";
  }
  return "Next: use deal card buttons — /done_room when finished.";
}

/** Plain-text banner when entering the in-chat deal room (no HTML). */
export async function formatDealRoomEntryPlain(dealId: string, actorUserId?: string): Promise<string> {
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
  const roleLine =
    actorUserId && d.buyerId === actorUserId
      ? "Your role: Buyer (you pay escrow — you do not upload the product)."
      : actorUserId && d.sellerId === actorUserId
        ? "Your role: Seller (you upload and lock delivery files)."
        : null;
  return [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Deal Room",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `Deal ID: ${d.dealCode}`,
    `Status: ${displayStatus}`,
    ...(roleLine ? [roleLine] : []),
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
    roleNextStep(d, actorUserId, sellerLockedCount),
    "",
    COMMUNITY_TRUST_LINE,
    "",
    TRUST_OPS_FOOTER,
  ].join("\n");
}
