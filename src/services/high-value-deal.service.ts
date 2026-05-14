import { Prisma } from "@prisma/client";
import { getHighValueThresholdUsd, getRequireHighValueApproval } from "./platform-settings.service.js";

/** Returns "pending" when admin must approve before a payment address is issued. */
export async function resolveInitialHighValueApprovalKey(amount: Prisma.Decimal): Promise<string | null> {
  if (!(await getRequireHighValueApproval())) return null;
  const t = await getHighValueThresholdUsd();
  if (amount.gte(t)) return "pending";
  return null;
}
