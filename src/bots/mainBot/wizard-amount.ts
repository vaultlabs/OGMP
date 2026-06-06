import { loadConfig } from "../../config/index.js";
import {
  fetchNowpaymentsMinPaymentAmount,
  formatNowpaymentsMinimumHint,
  validateInvoiceMeetsNowpaymentsMinimum,
} from "../../payments/nowpayments-min-amount.js";
import { computeProcessorInvoiceAmount } from "../../services/fee.service.js";
import { Prisma } from "@prisma/client";
import type { FeePayer } from "@prisma/client";

const Decimal = Prisma.Decimal;

export async function amountHintForCoin(params: {
  amount: string;
  currency: string;
  network: string;
  feePayer: FeePayer;
  escrowFee: Prisma.Decimal;
}): Promise<{ ok: boolean; line: string }> {
  if (loadConfig().PAYMENT_PROVIDER !== "nowpayments") {
    return { ok: true, line: "" };
  }
  const invoice = computeProcessorInvoiceAmount({
    amount: new Decimal(params.amount),
    feeAmount: params.escrowFee,
    feePayer: params.feePayer,
  });
  const minCheck = await validateInvoiceMeetsNowpaymentsMinimum({
    currency: params.currency,
    network: params.network,
    invoiceAmount: invoice.toString(),
  });
  const minInfo = await fetchNowpaymentsMinPaymentAmount({
    currency: params.currency,
    network: params.network,
  });
  if (!minInfo) return { ok: true, line: "" };
  const hint = formatNowpaymentsMinimumHint(minInfo, params.currency, params.network);
  if (!minCheck.ok) return { ok: false, line: `⚠️ ${minCheck.message}` };
  return { ok: true, line: `ℹ️ ${hint}` };
}
