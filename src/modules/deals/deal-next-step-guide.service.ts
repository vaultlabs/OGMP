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
      const text = "Next: accept your deal terms (or wait for your counterparty to join).";
      kb.text("Accept terms", `d:a:${code}`).text("View deal", `d:v:${code}`);
      return { text, kb };
    }
    case "waiting_payment":
    case "payment_detected": {
      if (isSeller) {
        const text = "Next: open Deal room and upload delivery. The buyer pays after files are locked.";
        kb.text("Upload / Deal room", `dr:enter:${code}`).text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text = "Next: wait for the seller to lock delivery, then pay from the deal card.";
        kb.text("View deal", `d:v:${code}`).row().text("Check payment", `bx:cp:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "funded": {
      if (isSeller) {
        const text = "Next: if the buyer is not in review yet, tap Mark delivered; otherwise wait for confirmation.";
        kb.text("Mark delivered", `d:del:${code}`).text("View deal", `d:v:${code}`).row();
        kb.text("Upload / Deal room", `dr:enter:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text = "Next: open the deal or check your recent messages for delivery files.";
        kb.text("View deal", `d:v:${code}`).text("Download files", `bx:dl:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "item_delivered": {
      if (isBuyer) {
        const text = "Next: review the delivery, then confirm release or open a dispute if something is wrong.";
        kb.text("Confirm received", `d:rel:${code}`).text("View deal", `d:v:${code}`).row();
        kb.text("Download files", `bx:dl:${code}`).text("Open dispute", `d:dp:${code}`);
        return { text, kb };
      }
      if (isSeller) {
        const text = "Next: wait for the buyer to confirm. You’ll get a message when they act.";
        kb.text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      return null;
    }
    case "release_requested": {
      if (isSeller) {
        const text = "Next: release is waiting on admin. You’ll be notified when it completes.";
        kb.text("View deal", `d:v:${code}`);
        return { text, kb };
      }
      if (isBuyer) {
        const text = "Next: admin is reviewing release. No action needed unless support contacts you.";
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
      `The ${side.toLowerCase()} accepted the deal terms.`,
      "",
      "Open the deal and accept terms to continue.",
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
        "Next: upload your delivery in Deal room first. The buyer pays after your files are locked.",
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
        "Next: wait for the seller to upload and lock delivery. You’ll get a payment notice with the escrow address when it’s time to pay.",
      ].join("\n"),
      buttons: [[{ text: "View deal", cb: `d:v:${deal.dealCode}` }]],
    });
  }
}

export function viewDealButtonRow(dealCode: string): { text: string; cb: string }[][] {
  return [[{ text: "View deal", cb: `d:v:${dealCode}` }]];
}
