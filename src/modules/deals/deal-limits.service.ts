import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { getDealLimits } from "../../services/platform-settings.service.js";
import { ValidationError } from "../../utils/errors.js";

const Decimal = Prisma.Decimal;

function isVerifiedUser(u: { profileBadge: string | null; gatewayVerified: boolean }): boolean {
  const b = u.profileBadge?.toLowerCase() ?? "";
  if (b.includes("verified")) return true;
  return u.gatewayVerified === true;
}

/** Approximate USD notional for caps (USDT treated 1:1; other assets use raw amount as conservative stand-in). */
function notionUsd(amount: Prisma.Decimal, currency: string): Prisma.Decimal {
  if (currency === "USDT") return amount;
  return amount;
}

export async function assertDealLimitsForCreate(params: {
  creatorId: string;
  amount: Prisma.Decimal;
  currency: string;
}): Promise<void> {
  const limits = await getDealLimits();
  const notion = notionUsd(params.amount, params.currency);

  if (limits.minDealUsd) {
    const min = new Decimal(limits.minDealUsd);
    if (notion.lt(min)) {
      throw new ValidationError(`Minimum deal size is ${limits.minDealUsd} USD notional for this asset.`);
    }
  }

  const u = await prisma.user.findUnique({ where: { id: params.creatorId } });
  if (!u) throw new ValidationError("User not found");

  const capUsd = isVerifiedUser(u) ? limits.maxVerifiedUserUsd : limits.maxNewUserUsd;
  if (capUsd) {
    const max = new Decimal(capUsd);
    if (notion.gt(max)) {
      throw new ValidationError(
        isVerifiedUser(u)
          ? `Maximum deal size for your account is ${capUsd} USD notional. Ask an admin if you need a higher limit.`
          : `New accounts are limited to ${capUsd} USD notional per deal until verified. Contact support for a higher limit.`,
      );
    }
  }

  if (limits.maxActiveDealsPerUser != null && limits.maxActiveDealsPerUser > 0) {
    const active = await prisma.deal.count({
      where: {
        OR: [{ buyerId: params.creatorId }, { sellerId: params.creatorId }, { creatorId: params.creatorId }],
        status: { notIn: ["released", "refunded", "cancelled"] },
      },
    });
    if (active >= limits.maxActiveDealsPerUser) {
      throw new ValidationError(
        `You already have ${active} active deals (limit ${limits.maxActiveDealsPerUser}). Close or finish one before starting another.`,
      );
    }
  }

  if (limits.dailyDealsPerUser != null && limits.dailyDealsPerUser > 0) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const today = await prisma.deal.count({
      where: { creatorId: params.creatorId, createdAt: { gte: start } },
    });
    if (today >= limits.dailyDealsPerUser) {
      throw new ValidationError(
        `Daily new-deal limit reached (${limits.dailyDealsPerUser}). Try again tomorrow or ask an admin.`,
      );
    }
  }
}
