import type { User } from "@prisma/client";

/** Community tier label derived from activity (admin `profileBadge` overrides separately). */
export function computeCommunityBadge(u: Pick<User, "completedDeals" | "totalVolumeUsd" | "reputationScore">): string {
  const vol = Number(u.totalVolumeUsd.toString());
  const rep = Number(u.reputationScore.toString());
  const c = u.completedDeals;
  if (vol >= 50_000) return "High Volume Trader";
  if (c >= 10 && rep >= 4.2) return "Trusted Trader";
  if (c >= 3) return "Active Trader";
  return "New Trader";
}
