/** Shared buyer payment warnings — exact amount is critical for escrow processors. */

export const PAYMENT_EXACT_AMOUNT_WARNING = [
  "⚠️ IMPORTANT — read before you pay",
  "",
  "Send the EXACT amount shown — not more, not less.",
  "Sending too little OR too much can mean lost funds.",
  "Use only the coin and network on this deal.",
  "Never pay outside OGMP MM.",
].join("\n");

export const PAYMENT_EXACT_AMOUNT_WARNING_HTML = [
  "⚠️ <b>Read before you pay</b>",
  "",
  "Send the <b>exact</b> amount shown — <b>not more, not less</b>.",
  "Wrong amounts can be <b>lost</b> and may not be recovered.",
  "Use only this deal’s <b>coin + network</b>. Never pay outside OGMP MM.",
].join("\n");

export const PAYMENT_EXACT_AMOUNT_SHORT = "Send the exact amount only — more or less may be lost.";
