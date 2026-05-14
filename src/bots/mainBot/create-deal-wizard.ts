import { getRedis } from "../../utils/redis.js";
import type { CreateDealInput } from "../../modules/deals/deal.service.js";
import type { ParticipantRole } from "@prisma/client";

export type CreateDealWizard =
  | { step: "role" }
  | { step: "title"; creatorRole: ParticipantRole }
  | { step: "description"; creatorRole: ParticipantRole; title: string }
  | {
      step: "party_terms";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
    }
  | {
      step: "party_terms_text";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
    }
  | {
      step: "amount";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
      partyTermsExtra?: string;
    }
  | {
      step: "network";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
      amount: string;
      partyTermsExtra?: string;
    }
  | {
      step: "fee_payer";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
      amount: string;
      currency: CreateDealInput["currency"];
      network: string;
      partyTermsExtra?: string;
    }
  | { step: "confirm"; draft: CreateDealInput };

const ttlSec = 30 * 60;
const wizardKey = (telegramId: bigint) => `ogmp:wizard:create:${telegramId.toString()}`;

const DEFAULT_DELIVERY_INSTRUCTIONS =
  "Seller uploads files in OGMP MM Deal room and locks delivery before the buyer is shown the escrow payment address. Buyer pays only after at least one seller-locked delivery exists. Use /done_room when finished uploading.";

/** Composes stored deal_terms: summary + OGMP mechanics + optional party-written guarantees. */
export function buildDealTerms(description: string, partyTermsExtra: string): string {
  const summary = description.trim();
  const ogmp =
    "OGMP MM escrow mechanics: Both parties accept these terms in the bot. The seller posts delivery in Deal room and locks it; the buyer receives the payment address only after locked delivery exists. Funds stay in escrow until release rules are met.";
  const extra = partyTermsExtra.trim();
  if (extra.length > 0) {
    return `Deal summary (agreed scope):\n${summary}\n\n${ogmp}\n\nParty-agreed terms, guarantees, or conditions:\n${extra}\n`;
  }
  return `Deal summary (agreed scope):\n${summary}\n\n${ogmp}\n\nParty-agreed additions: none (standard escrow flow only).\n`;
}

export async function getCreateWizard(telegramId: bigint): Promise<CreateDealWizard | null> {
  const r = getRedis();
  const raw = await r.get(wizardKey(telegramId));
  if (!raw) return null;
  return JSON.parse(raw) as CreateDealWizard;
}

export async function setCreateWizard(telegramId: bigint, state: CreateDealWizard): Promise<void> {
  const r = getRedis();
  await r.set(wizardKey(telegramId), JSON.stringify(state), "EX", ttlSec);
}

export async function clearCreateWizard(telegramId: bigint): Promise<void> {
  const r = getRedis();
  await r.del(wizardKey(telegramId));
}

/** When true, plain-text messages should go to the create wizard, not Deal room. */
export function createWizardExpectsPlainText(w: CreateDealWizard | null): boolean {
  if (!w) return false;
  return (
    w.step === "title" ||
    w.step === "description" ||
    w.step === "party_terms_text" ||
    w.step === "amount"
  );
}

export function toCreateDealInput(
  base: Extract<CreateDealWizard, { step: "fee_payer" }>,
  feePayer: CreateDealInput["feePayer"],
): CreateDealInput {
  return {
    creatorRole: base.creatorRole,
    title: base.title,
    description: base.description,
    dealTerms: buildDealTerms(base.description, base.partyTermsExtra ?? ""),
    deliveryInstructions: DEFAULT_DELIVERY_INSTRUCTIONS,
    proofRequirements: undefined,
    amount: base.amount,
    currency: base.currency,
    network: base.network,
    feePayer,
  };
}
