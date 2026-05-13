import { getRedis } from "../../utils/redis.js";
import type { CreateDealInput } from "../../modules/deals/deal.service.js";
import type { ParticipantRole } from "@prisma/client";

export type CreateDealWizard =
  | { step: "role" }
  | { step: "title"; creatorRole: ParticipantRole }
  | { step: "description"; creatorRole: ParticipantRole; title: string }
  | { step: "amount"; creatorRole: ParticipantRole; title: string; description: string }
  | {
      step: "network";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
      amount: string;
    }
  | {
      step: "fee_payer";
      creatorRole: ParticipantRole;
      title: string;
      description: string;
      amount: string;
      currency: CreateDealInput["currency"];
      network: string;
    }
  | { step: "confirm"; draft: CreateDealInput };

const ttlSec = 30 * 60;
const wizardKey = (telegramId: bigint) => `ogmp:wizard:create:${telegramId.toString()}`;

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

export function toCreateDealInput(
  base: Extract<CreateDealWizard, { step: "fee_payer" }>,
  feePayer: CreateDealInput["feePayer"],
): CreateDealInput {
  return {
    creatorRole: base.creatorRole,
    title: base.title,
    description: base.description,
    dealTerms: base.description,
    deliveryInstructions: "As coordinated privately between buyer and seller.",
    proofRequirements: undefined,
    amount: base.amount,
    currency: base.currency,
    network: base.network,
    feePayer,
  };
}
