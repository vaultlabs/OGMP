import type { Deal, PaymentRecordStatus, Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { userFacingDealStatus, userFacingDeliveryState } from "../../modules/deals/user-facing-status.js";
import { sellerPayoutReady } from "../../modules/deals/seller-payout.service.js";
import {
  formatCryptoAmount,
  previewSellerPayoutAmount,
  resolveBuyerPayAmount,
  resolveDealPaymentAmounts,
} from "../../services/fee.service.js";
import { maskPayoutAddress } from "../../services/payout.service.js";
import { escapeTelegramHtml } from "../../utils/telegram-html.js";
import { PAYMENT_EXACT_AMOUNT_WARNING_HTML } from "./payment-copy.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

export type DealCardContext = {
  sellerLockedCount: number;
  paymentStatus: PaymentRecordStatus | null;
  paymentExpectedAmount: Prisma.Decimal | null;
  paymentReceivedAmount: Prisma.Decimal | null;
  isBuyer: boolean;
  isSeller: boolean;
  buyerCanPay: boolean;
};

export async function loadDealCardContext(dealId: string, viewerUserId: string | null): Promise<{
  deal: Deal & { buyer: { telegramId: bigint; username: string | null; firstName: string | null } | null; seller: { telegramId: bigint; username: string | null; firstName: string | null } | null; activeReport: { reportCode: string; status: string } | null };
  ctx: DealCardContext;
} | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, activeReport: true },
  });
  if (!deal) return null;
  const pay = await prisma.payment.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
  const sellerLockedCount = deal.sellerId
    ? await prisma.dealMessage.count({
        where: { dealId, lockedForBuyer: true, senderId: deal.sellerId },
      })
    : 0;
  const { isBuyerPaymentReady } = await import("../../services/delivery.service.js");
  const buyerCanPay = await isBuyerPaymentReady(dealId);
  return {
    deal,
    ctx: {
      sellerLockedCount,
      paymentStatus: pay?.status ?? null,
      paymentExpectedAmount: pay?.expectedAmount ?? null,
      paymentReceivedAmount: pay?.receivedAmount ?? null,
      isBuyer: !!viewerUserId && deal.buyerId === viewerUserId,
      isSeller: !!viewerUserId && deal.sellerId === viewerUserId,
      buyerCanPay,
    },
  };
}

function fmtUserLine(u: { telegramId: bigint; username: string | null; firstName: string | null }): string {
  const un = u.username ? `@${u.username}` : "no username";
  return `${u.firstName ?? "User"} (${un})`;
}

/** Compact HTML deal card — essentials + role-specific next step (no duplicate footers). */
type DealUserLine = { telegramId: bigint; username: string | null; firstName: string | null };

export function formatDealCardHtml(
  d: Deal & {
    buyer: DealUserLine | null;
    seller: DealUserLine | null;
    activeReport: { reportCode: string; status: string } | null;
  },
  cardCtx: DealCardContext,
  viewerUserId: string | null,
): string {
  const e = escapeTelegramHtml;
  const buyer = d.buyer ? fmtUserLine(d.buyer) : "(waiting)";
  const seller = d.seller ? fmtUserLine(d.seller) : "(waiting)";
  const displayStatus = userFacingDealStatus(d, {
    hasLockedDelivery: cardCtx.sellerLockedCount > 0,
    paymentStatus: cardCtx.paymentStatus,
  });
  const delivery = userFacingDeliveryState(d.status, cardCtx.sellerLockedCount > 0);
  const payAmounts = resolveDealPaymentAmounts(d);
  const paymentRef =
    cardCtx.paymentExpectedAmount || cardCtx.paymentReceivedAmount
      ? {
          expectedAmount: cardCtx.paymentExpectedAmount ?? payAmounts.buyerPays,
          receivedAmount: cardCtx.paymentReceivedAmount,
        }
      : null;
  const buyerPays = resolveBuyerPayAmount(d, paymentRef);
  const sellerPreview = previewSellerPayoutAmount(d, paymentRef);
  const hideEscrowFromBuyer =
    cardCtx.isBuyer &&
    (d.status === "waiting_payment" || d.status === "payment_detected") &&
    cardCtx.sellerLockedCount === 0;

  const lines: string[] = [
    DIV,
    `<b>OGMP MM</b> · Deal <code>${e(d.dealCode)}</code>`,
    DIV,
    "",
    `<b>Status</b>  ${e(displayStatus)}${d.frozen ? " · frozen" : ""}`,
    `<b>Deal price</b>  ${e(formatCryptoAmount(payAmounts.dealAmount))} ${e(d.currency)} · ${e(d.network)}`,
    `<b>${d.paymentAddress ? "Buyer sends" : "Est. buyer sends"}</b>  ${e(formatCryptoAmount(buyerPays))} ${e(d.currency)}`,
    `<b>Seller gets</b>  ${e(formatCryptoAmount(sellerPreview.payout))} ${e(d.currency)}${sellerPreview.capped ? " (net)" : ""}`,
    `<b>Vault</b>  ${e(delivery)}`,
    `<b>Buyer</b>  ${e(buyer)}`,
    `<b>Seller</b>  ${e(seller)}`,
  ];

  if (cardCtx.isSeller) {
    lines.push(
      `<b>Your wallet</b>  ${
        sellerPayoutReady(d) ? e(maskPayoutAddress(d.sellerPayoutAddress!)) : e("not set yet")
      }`,
    );
  }

  if (
    cardCtx.isBuyer &&
    cardCtx.sellerLockedCount > 0 &&
    !d.paymentAddress &&
    (d.status === "waiting_payment" || d.status === "payment_detected")
  ) {
    lines.push("", `<b>Pay address</b>  ${e("pending — seller must finish wallet setup")}`);
  } else if (d.paymentAddress && d.status !== "pending_acceptance" && !hideEscrowFromBuyer) {
    lines.push(
      "",
      `<b>Escrow address</b>`,
      `<code>${e(d.paymentAddress)}</code>`,
      `<b>Send exactly</b>  ${e(formatCryptoAmount(buyerPays))} ${e(d.currency)}`,
      "",
      PAYMENT_EXACT_AMOUNT_WARNING_HTML,
    );
  } else if (hideEscrowFromBuyer) {
    lines.push("", `<b>Pay address</b>  ${e("opens after seller locks delivery")}`);
  }

  if (d.activeReport) {
    lines.push(`<b>Case</b>  ${e(d.activeReport.reportCode)} (${e(d.activeReport.status.replace(/_/g, " "))})`);
  }

  const next = dealNextStepLine(d, cardCtx, viewerUserId);
  if (next) lines.push("", `<b>Next</b>  ${e(next)}`);

  return lines.join("\n");
}

function dealNextStepLine(
  d: Pick<Deal, "status" | "dealCode">,
  cardCtx: DealCardContext,
  _viewerUserId: string | null,
): string | null {
  if (d.status === "pending_acceptance") return "Both sides accept terms.";
  if (d.status === "waiting_payment" || d.status === "payment_detected") {
    if (cardCtx.isSeller) {
      if (!sellerPayoutReady(d as Deal)) return "Set payout wallet, then upload delivery in Deal room.";
      if (cardCtx.sellerLockedCount === 0) return "Deal room → upload photo/doc/zip → locks vault.";
      return "Buyer can pay — tap Submit Delivery if they need a reminder.";
    }
    if (cardCtx.isBuyer) {
      if (cardCtx.buyerCanPay) return "Send the exact amount only (more/less may be lost) → I Have Paid → Check Payment.";
      if (cardCtx.sellerLockedCount > 0) return "Waiting on seller wallet / pay address.";
      return "Waiting for seller to lock delivery.";
    }
  }
  if (d.status === "funded") {
    if (cardCtx.isBuyer) return "Download files → review → Release to seller.";
    if (cardCtx.isSeller) return "Buyer is reviewing delivery.";
  }
  if (d.status === "item_delivered") {
    if (cardCtx.isBuyer) return "Confirm received or open a case.";
    if (cardCtx.isSeller) return "Waiting for buyer confirm.";
  }
  if (d.status === "released") return "Deal complete.";
  return null;
}
