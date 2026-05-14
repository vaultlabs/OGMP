import { prisma } from "../../db/prisma.js";
import { userFacingDealStatus, userFacingDeliveryState } from "../../modules/deals/user-facing-status.js";
import { COMMUNITY_TRUST_LINE, MAIN_UI_PARSE_MODE, RULER_HTML, TRUST_OPS_FOOTER } from "./trust-copy.js";
import { escapeTelegramHtml } from "../../utils/telegram-html.js";

export { MAIN_UI_PARSE_MODE };

function lineUser(u: { username: string | null; firstName: string | null; telegramId: bigint } | null): string {
  if (!u) return "(pending)";
  const un = u.username ? `@${escapeTelegramHtml(u.username)}` : "no username";
  return `${escapeTelegramHtml(u.firstName ?? "User")} (${un})`;
}

/** Rich banner when entering the in-chat deal room (Telegram HTML). */
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
  const payLine = pay ? escapeTelegramHtml(pay.status.replace(/_/g, " ")) : "—";
  const caseLine = d.activeReport
    ? `${escapeTelegramHtml(d.activeReport.reportCode)} (${escapeTelegramHtml(d.activeReport.status.replace(/_/g, " "))})`
    : "none open";
  const protection = d.frozen ? "paused — Case Review" : "on";
  return [
    `<b>OGMP MM</b> · <i>Deal room</i>`,
    RULER_HTML,
    "",
    `<b>Deal ID</b> ${escapeTelegramHtml(d.dealCode)}`,
    `<b>Status</b> ${escapeTelegramHtml(displayStatus)}`,
    `<b>Buyer</b> ${lineUser(d.buyer)}`,
    `<b>Seller</b> ${lineUser(d.seller)}`,
    `<b>Amount</b> ${escapeTelegramHtml(d.amount.toString())} ${escapeTelegramHtml(d.currency)}`,
    `<b>Network</b> ${escapeTelegramHtml(d.network)}`,
    `<b>Delivery vault</b> ${escapeTelegramHtml(delivery)}`,
    `<b>Escrow step</b> ${payLine}`,
    `<b>Deal Protection</b> ${escapeTelegramHtml(protection)}`,
    `<b>Case Review</b> ${caseLine}`,
    "",
    "<b>What</b> Chat and uploads for this deal.",
    "<b>Safe</b> Keep payment and files inside OGMP MM only.",
    "<b>Next</b> Use deal card buttons, or upload here as seller — <code>/done_room</code> when finished.",
    "",
    `<i>${escapeTelegramHtml(COMMUNITY_TRUST_LINE)}</i>`,
    "",
    `<i>${escapeTelegramHtml(TRUST_OPS_FOOTER)}</i>`,
  ].join("\n");
}
