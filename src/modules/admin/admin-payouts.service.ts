import { prisma } from "../../db/prisma.js";
import { formatCryptoAmount } from "../../services/fee.service.js";
import { maskPayoutAddress } from "../../services/payout.service.js";

export type AdminPayoutRow = {
  payoutId: string;
  dealCode: string;
  status: string;
  amount: string;
  currency: string;
  network: string;
  toAddress: string;
  providerRef: string | null;
  adminNote: string | null;
  createdAt: Date;
};

export async function listAdminPayoutQueue(limit = 20): Promise<AdminPayoutRow[]> {
  const rows = await prisma.payout.findMany({
    where: { status: { in: ["pending", "processing", "failed"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { deal: { select: { dealCode: true } } },
  });
  return rows.map((p) => ({
    payoutId: p.id,
    dealCode: p.deal.dealCode,
    status: p.status,
    amount: formatCryptoAmount(p.amount),
    currency: p.currency,
    network: p.network,
    toAddress: p.toAddress,
    providerRef: p.providerRef,
    adminNote: p.adminNote,
    createdAt: p.createdAt,
  }));
}

export async function countPendingPayouts(): Promise<number> {
  return prisma.payout.count({
    where: { status: { in: ["pending", "processing", "failed"] } },
  });
}

export function formatAdminPayoutList(rows: AdminPayoutRow[]): string {
  if (rows.length === 0) {
    return "No pending, processing, or failed payouts.";
  }
  return rows
    .map((p, i) => {
      const lines = [
        `${i + 1}. ${p.dealCode} — ${p.status}`,
        `   ${p.amount} ${p.currency} (${p.network})`,
        `   Wallet: ${maskPayoutAddress(p.toAddress)}`,
        `   Payout ID: ${p.payoutId}`,
      ];
      if (p.providerRef) lines.push(`   Provider: ${p.providerRef}`);
      if (p.adminNote) lines.push(`   Note: ${p.adminNote.slice(0, 120)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
