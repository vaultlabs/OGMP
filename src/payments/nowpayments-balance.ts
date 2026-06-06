import { loadConfig } from "../config/index.js";
import { getNowpaymentsBearerToken } from "./nowpayments-auth.js";
import { mapCurrencyNetworkToPayCurrency } from "./nowpayments.provider.js";
import { logger } from "../utils/logger.js";

const DEFAULT_API_BASE = "https://api.nowpayments.io";

export type NowpaymentsBalanceRow = { amount: number; pendingAmount: number };

export async function fetchNowpaymentsBalance(): Promise<Record<string, NowpaymentsBalanceRow> | null> {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER !== "nowpayments") return null;
  const apiKey = cfg.NOWPAYMENTS_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const bearer = await getNowpaymentsBearerToken();
    const base = (cfg.NOWPAYMENTS_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
    const res = await fetch(`${base}/v1/balance`, {
      headers: { "x-api-key": apiKey, Authorization: `Bearer ${bearer}` },
    });
    const text = await res.text();
    if (!res.ok) {
      logger.warn("nowpayments_balance_fetch_failed", { status: res.status, body: text.slice(0, 200) });
      return null;
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, NowpaymentsBalanceRow> = {};
    for (const [key, val] of Object.entries(data)) {
      if (!val || typeof val !== "object") continue;
      const row = val as Record<string, unknown>;
      const amount = typeof row.amount === "number" ? row.amount : Number(row.amount) || 0;
      const pendingAmount =
        typeof row.pendingAmount === "number" ? row.pendingAmount : Number(row.pendingAmount) || 0;
      out[key.toLowerCase()] = { amount, pendingAmount };
    }
    return out;
  } catch (e) {
    logger.warn("nowpayments_balance_fetch_error", { err: String(e) });
    return null;
  }
}

export function formatInsufficientBalanceHelp(params: {
  dealCode: string;
  currency: string;
  network: string;
  payoutAmount: string;
  balance: Record<string, NowpaymentsBalanceRow> | null;
}): string {
  const payCur = mapCurrencyNetworkToPayCurrency(params.currency, params.network);
  const row = params.balance?.[payCur];
  const avail = row ? String(row.amount) : "(could not read — check dashboard)";
  const pending = row ? String(row.pendingAmount) : "—";
  const lines = [
    "NOWPayments rejected the payout: Insufficient balance.",
    "",
    `Deal: ${params.dealCode}`,
    `Payout needs: ${params.payoutAmount} ${params.currency} (${params.network})`,
    `API coin key: ${payCur}`,
    `Available in that coin: ${avail}`,
    `Pending in that coin: ${pending}`,
    "",
    "This is usually NOT wrong .env — it means custody does not have enough in that exact coin:",
    "",
    "1. Open account.nowpayments.io → Custody (not only the main dashboard total).",
    "2. Check balance for the same coin/network as the deal (e.g. USDT TRC20 → usdttrc20).",
    "3. Buyer payments may sit in Payments until you convert / move to Custody.",
    "4. Settings → Payments → Payment Details → set Withdrawal fee paid by → Receiver (sender-paid fees need extra balance).",
    "5. If you have funds in another coin, OGMP auto-converts via API when NOWPAYMENTS_AUTO_CUSTODY_CONVERT=true (needs enough USDC/etc. in Custody).",
    "",
    "After topping up Custody in the right coin, run /admin_retry_payout again.",
  ];
  return lines.join("\n");
}
