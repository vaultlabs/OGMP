import { prisma } from "../../db/prisma.js";
import { NotFoundError, ValidationError } from "../../utils/errors.js";

const ALLOWED_KINDS = new Set(["USDT_TRC20", "USDT_ERC20", "BTC", "ETH", "LTC"]);

export async function listSavedWallets(userId: string) {
  return prisma.savedWallet.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function addSavedWallet(params: {
  userId: string;
  kind: string;
  currency: string;
  network: string;
  address: string;
  label?: string;
}) {
  const k = params.kind.toUpperCase();
  if (!ALLOWED_KINDS.has(k)) {
    throw new ValidationError(`Unsupported wallet kind. Use: ${[...ALLOWED_KINDS].join(", ")}`);
  }
  return prisma.savedWallet.create({
    data: {
      userId: params.userId,
      kind: k,
      currency: params.currency,
      network: params.network,
      address: params.address.trim(),
      label: params.label?.slice(0, 64),
    },
  });
}

export async function deleteSavedWallet(userId: string, walletId: string): Promise<void> {
  const r = await prisma.savedWallet.deleteMany({ where: { id: walletId, userId } });
  if (!r.count) throw new NotFoundError("Wallet not found");
}
