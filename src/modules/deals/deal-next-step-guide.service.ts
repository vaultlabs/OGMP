import type { Deal } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import { prisma } from "../../db/prisma.js";
import { enqueueDmWithButtons } from "../notifications/notificationQueue.service.js";

const DIV = "━━━━━━━━━━━━━━━━━━";

/** In-chat “what now?” line + keyboard for the user who just acted. */
export function nextStepForActorReply(
  deal: Pick<Deal, "dealCode" | "status" | "buyerId" | "sellerId">,
  actorUserId: string,
): { text: string; kb: InlineKeyboard } | null {
  const code = deal.dealCode;
  const kb = new InlineKeyboard();
  const isBuyer = deal.buyerId === actorUserId;
  const isSeller = deal.sellerId === actorUserId;

  switch (deal.status) {
    case "pending_acceptance": {
      const text =
        "What: deal is waiting on terms.\nSafe: nothing moves until both accept.\nNext: Accept terms (or wait for them).";
      kb.text("Accept terms", `d:a:${code}`).text("View deal", `d:v:${code}`);
      return { text, kb };
    }
    case "waiting_payment":
    case "payment_detected": {
      if (isSeller) {
        const text =
          "What: Deal Protection is on — buyer pays after the Delivery Vault locks.\nSafe: your file stays locked until then.\nNext: Deal room → upload → lock.";
        kb.text("Upload / Deal room", `dr:enter:${code}`).text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text =
          "What: waiting on Delivery Vault lock.\nSafe: no pay address until vault is ready.\nNext: watch for Payment Required DM, then pay in-bot only.";
        kb.text("View deal", `d:v:${code}`).row().text("Check payment", `bx:cp:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "funded": {
      if (isSeller) {
        const text =
          "What: vault unlocked — buyer can review.\nSafe: escrow still holds funds.\nNext: Mark delivered if needed, or wait for Buyer Review.";
        kb.text("Mark delivered", `d:del:${code}`).text("View deal", `d:v:${code}`).row();
        kb.text("Upload / Deal room", `dr:enter:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text =
          "What: Delivery Vault unlocked.\nSafe: payment still in escrow until you confirm.\nNext: Download → Buyer Review → Confirm.";
        kb.text("View deal", `d:v:${code}`).text("Download files", `bx:dl:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "item_delivered": {
      if (isBuyer) {
        const text =
          "What: Buyer Review.\nSafe: escrow until you confirm.\nNext: Confirm Received — or Open Case for Case Review.";
        kb.text("Confirm received", `d:rel:${code}`).text("Open Case", `d:rp:${code}`).row();
        kb.text("Download files", `bx:dl:${code}`).text("Hold deal", `d:dp:${code}`);
        return { text, kb };
      }
      if (isSeller) {
        const text =
          "What: Buyer Review in progress.\nSafe: funds still in escrow.\nNext: wait for confirm or Case Review.";
        kb.text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "release_requested": {
      if (isSeller) {
        const text =
          "What: Release Request with admin.\nSafe: rules still apply — watch for the result.\nNext: wait for completion notice.";
        kb.text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text =
          "What: Release Request pending.\nSafe: escrow until admin completes.\nNext: no action unless support asks.";
        kb.text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "released":
    case "refunded":
    case "cancelled":
      return {
        text: "This deal is finished. You can open it anytime for the record.",
        kb: new InlineKeyboard().text("View deal", `d:v:${code}`),
      };
    default:
      return null;
  }
}

/** After both accepted terms but payment address creation failed — one clear next step (not "wait for vault"). */
export function nextStepAfterPaymentSetupFailed(
  deal: Pick<Deal, "dealCode" | "buyerId" | "sellerId">,
  actorUserId: string,
): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard().text("View deal", `d:v:${deal.dealCode}`);
  const isBuyer = deal.buyerId === actorUserId;
  const isSeller = deal.sellerId === actorUserId;
  if (isBuyer) {
    return {
      text: "What: escrow pay address did not issue yet.\nSafe: do not send crypto until the deal card shows a pay address.\nNext: wait one minute, then open View deal again. If it repeats: /support with your deal code only.",
      kb,
    };
  }
  if (isSeller) {
    return {
      text: "What: buyer pay address did not issue yet (payment setup on our side).\nSafe: do not ask the buyer to send crypto until a pay address appears on the deal card.\nNext: wait one minute, then View deal again. If it repeats: /support with your deal code only.",
      kb,
    };
  }
  return {
    text: "What: payment setup is delayed.\nNext: wait one minute, then View deal, or /support with your deal code only.",
    kb,
  };
}

export function joinSuccessKeyboard(dealCode: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Accept terms", `d:a:${dealCode}`)
    .text("View deal", `d:v:${dealCode}`)
    .row()
    .text("My deals", "m:deals");
}

export function createDealSuccessKeyboard(dealCode: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("View deal", `d:v:${dealCode}`)
    .text("Accept terms", `d:a:${dealCode}`)
    .row()
    .text("My deals", "m:deals");
}

/** DM the other party when one side has accepted terms and the deal is still pending acceptance. */
export async function notifyCounterpartyAfterTermsAccept(
  dealId: string,
  acceptedUserId: string,
): Promise<void> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });
  if (!deal || deal.status !== "pending_acceptance") return;

  const parts = await prisma.dealParticipant.findMany({
    where: { dealId },
    include: { user: true },
  });
  const other = parts.find((p) => p.userId !== acceptedUserId);
  if (!other?.user || other.termsAcceptedAt) return;

  const accepter = parts.find((p) => p.userId === acceptedUserId);
  const side = accepter?.role === "buyer" ? "Buyer" : "Seller";

  await enqueueDmWithButtons({
    chatId: other.user.telegramId.toString(),
      text: [
        DIV,
        "OGMP MM — Your turn",
        DIV,
        "",
        `Deal: ${deal.dealCode}`,
        "",
        `What: ${side} accepted terms.`,
        "Safe: deal stays paused until you accept too.",
        "Next: Accept terms.",
      ].join("\n"),
    buttons: [
      [
        { text: "View deal", cb: `d:v:${deal.dealCode}` },
        { text: "Accept terms", cb: `d:a:${deal.dealCode}` },
      ],
    ],
  });
}

/** After both sides accepted — payment address exists. Nudge seller-first flow. */
export async function notifyBothAfterPaymentLive(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true },
  });
  if (!deal || deal.status !== "waiting_payment" || !deal.paymentAddress) return;

  if (deal.seller) {
    await enqueueDmWithButtons({
      chatId: deal.seller.telegramId.toString(),
      text: [
        DIV,
        "OGMP MM — Deal is live",
        DIV,
        "",
        `Deal: ${deal.dealCode}`,
        "",
        "What: Deal Protection is active.",
        "Safe: buyer pays only after Delivery Vault locks.",
        "Next: Deal room → upload delivery.",
      ].join("\n"),
      buttons: [
        [
          { text: "Upload delivery", cb: `dr:enter:${deal.dealCode}` },
          { text: "View deal", cb: `d:v:${deal.dealCode}` },
        ],
      ],
    });
  }

  if (deal.buyer) {
    await enqueueDmWithButtons({
      chatId: deal.buyer.telegramId.toString(),
      text: [
        DIV,
        "OGMP MM — Deal is live",
        DIV,
        "",
        `Deal: ${deal.dealCode}`,
        "",
        "What: waiting on Delivery Vault.",
        "Safe: you are not asked to pay until the vault locks.",
        "Next: wait for Payment Required DM.",
      ].join("\n"),
      buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
    });
  }
}

export function viewDealButtonRow(dealCode: string): { text: string; cb: string }[][] {
  return [[{ text: "View deal", cb: `d:v:${dealCode}` }]];
}
