import { InlineKeyboard } from "grammy";
import type { CreateDealInput } from "../../modules/deals/deal.service.js";

const AMOUNT_EXAMPLES: Record<string, string> = {
  USDT: "50",
  BTC: "0.001",
  ETH: "0.05",
  LTC: "0.5",
};

export function coinNetworkLabel(currency: string, network: string): string {
  if (currency === "USDT" && network === "TRC20") return "USDT on Tron (TRC20)";
  if (currency === "USDT" && network === "ERC20") return "USDT on Ethereum (ERC20)";
  if (currency === "BTC") return "Bitcoin (BTC)";
  if (currency === "ETH") return "Ethereum (ETH)";
  if (currency === "LTC") return "Litecoin (LTC)";
  return `${currency} (${network})`;
}

/** Step 1 after terms — pick coin before typing any number. */
export function coinChoiceMessage(): string {
  return [
    "💰 <b>Step 1 — Pick the coin</b>",
    "",
    "Tap the coin the <b>buyer will pay in</b>.",
    "",
    "⚠️ <b>Important:</b> on the next step you type the amount <b>in that coin</b>.",
    "Not dollars. Not euros. The actual coin.",
    "",
    "• <b>USDT</b> = stablecoin (1 USDT is about $1, but you still type USDT)",
    "• <b>BTC / ETH / LTC</b> = regular crypto (type the coin amount, e.g. 0.001 BTC)",
  ].join("\n");
}

export function coinChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("USDT · Tron", "w:net:USDT:TRC20")
    .text("USDT · Ethereum", "w:net:USDT:ERC20")
    .row()
    .text("Bitcoin BTC", "w:net:BTC:BTC")
    .text("Ethereum ETH", "w:net:ETH:ETH")
    .row()
    .text("Litecoin LTC", "w:net:LTC:LTC");
}

/** Step 2 — amount in the coin they just picked. */
export function amountPromptMessage(currency: CreateDealInput["currency"], network: string): string {
  const label = coinNetworkLabel(currency, network);
  const example = AMOUNT_EXAMPLES[currency] ?? "10";
  return [
    `💰 <b>Step 2 — How much ${currency}?</b>`,
    "",
    `You chose: <b>${label}</b>`,
    "",
    `Type the deal price <b>in ${currency}</b> — numbers only.`,
    `❌ Do <b>not</b> type dollars ($). Type <b>${currency}</b>.`,
    "",
    `Example: <code>${example}</code>`,
  ].join("\n");
}

export function invalidAmountMessage(currency: string): string {
  const example = AMOUNT_EXAMPLES[currency] ?? "10";
  return [
    `That doesn't look right.`,
    "",
    `Type numbers only — how much <b>${currency}</b> for this deal?`,
    `Example: <code>${example}</code>`,
    "",
    `Remember: type ${currency}, not dollars.`,
  ].join("\n");
}

export function amountTooSmallMessage(currency: string, network: string, minHint: string): string {
  return [
    `⚠️ <b>Too small</b>`,
    "",
    `${minHint}`,
    "",
    `Type a <b>bigger number in ${currency}</b> and send it again.`,
    `Still in ${coinNetworkLabel(currency, network)} — not dollars.`,
  ].join("\n");
}

export function confirmDealHeader(currency: string, network: string): string {
  return [
    "✅ <b>Check everything</b>",
    "",
    `Coin: <b>${coinNetworkLabel(currency, network)}</b>`,
    `All amounts below are in <b>${currency}</b> (not dollars).`,
    "",
  ].join("\n");
}

export function feePayerPrompt(currency: string): string {
  return [
    `Who pays the 1% OGMP fee?`,
    "",
    `(Amounts are in <b>${currency}</b> — the coin you picked.)`,
  ].join("\n");
}

export function payoutWalletPrompt(currency: string, network: string): string {
  return [
    `💳 <b>Your payout wallet</b>`,
    "",
    `Coin: <b>${coinNetworkLabel(currency, network)}</b>`,
    "",
    `Send the wallet address where you want to receive <b>${currency}</b> when the deal completes.`,
    "",
    `⚠️ Wrong network = lost funds. Must be a <b>${network}</b> address for <b>${currency}</b>.`,
  ].join("\n");
}
