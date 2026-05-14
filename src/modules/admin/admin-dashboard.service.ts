import { prisma } from "../../db/prisma.js";

export type AdminDashboardSnapshot = {
  activeDeals: number;
  fundedDeals: number;
  disputedDeals: number;
  releaseRequested: number;
  openReports: number;
  frozenDeals: number;
  completedDeals: number;
  totalUsers: number;
  feesEarnedApprox: string;
};

export async function getAdminDashboardSnapshot(): Promise<AdminDashboardSnapshot> {
  const [
    activeDeals,
    fundedDeals,
    disputedDeals,
    releaseRequested,
    openReports,
    frozenDeals,
    completedDeals,
    totalUsers,
    feeAgg,
  ] = await Promise.all([
    prisma.deal.count({
      where: { status: { notIn: ["released", "refunded", "cancelled"] } },
    }),
    prisma.deal.count({ where: { status: "funded" } }),
    prisma.deal.count({ where: { status: "disputed" } }),
    prisma.deal.count({ where: { status: "release_requested" } }),
    prisma.report.count({
      where: { status: { in: ["submitted", "under_review", "waiting_for_buyer", "waiting_for_seller"] } },
    }),
    prisma.deal.count({ where: { frozen: true } }),
    prisma.deal.count({ where: { status: "released" } }),
    prisma.user.count({ where: { banned: false } }),
    prisma.deal.aggregate({
      where: { status: "released" },
      _sum: { feeAmount: true },
    }),
  ]);
  return {
    activeDeals,
    fundedDeals,
    disputedDeals,
    releaseRequested,
    openReports,
    frozenDeals,
    completedDeals,
    totalUsers,
    feesEarnedApprox: feeAgg._sum.feeAmount?.toString() ?? "0",
  };
}
