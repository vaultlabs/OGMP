import { escapeTelegramHtml } from "../../utils/telegram-html.js";

/** Use with all strings in this file that use HTML tags. */
export const MAIN_UI_PARSE_MODE = "HTML" as const;

/** Plain one-liners (also embedded in HTML deal cards via escape). */
export const COMMUNITY_TRUST_LINE = "Trusted by 1,100+ OGMP community members.";
export const COMMUNITY_TRUST_ALT = "Part of a growing 1,100+ member trading community.";
export const TRUST_OPS_FOOTER =
  "Deal Protection: escrow holds funds, the Delivery Vault holds files, and Case Review is there if something goes wrong.";

export const RULER_HTML = "<code>────────────────────────</code>";

function footerHtml(): string {
  return [
    "",
    `<i>${TRUST_OPS_FOOTER}</i>`,
    "",
    `<i>${COMMUNITY_TRUST_LINE}</i>`,
  ].join("\n");
}

export const PREMIUM_WELCOME = [
  `<b>OGMP MM</b> · <i>Secure escrow</i>`,
  RULER_HTML,
  "",
  "<b>What</b>",
  "Structured crypto deals from delivery lock to release — without leaving Telegram.",
  "",
  "<b>Safe</b>",
  "Funds stay in escrow. Files stay in the Delivery Vault until payment confirms.",
  "",
  "<b>Next</b>",
  "Pick an action below. New here? Open <b>How it works</b> first.",
  "",
  "<i>Vault → Pay → Unlock → Buyer Review → Release</i>",
  footerHtml(),
].join("\n");

export const WHY_TRUST_PAGE = [
  `<b>Why trust OGMP MM</b>`,
  RULER_HTML,
  "",
  "<b>What</b>",
  "One guided flow for both sides — fewer hand‑wavy DMs, clearer checkpoints.",
  "",
  "<b>Safe</b>",
  "Escrow + Delivery Vault + optional Case Review. Keep every step inside this bot.",
  "",
  "<b>Highlights</b>",
  `• <i>${COMMUNITY_TRUST_LINE}</i>`,
  "• Payment stays in escrow before the vault unlocks",
  "• Timeline + evidence if Case Review opens",
  "",
  "<i>Never pay outside the address this bot shows for your deal.</i>",
  footerHtml(),
].join("\n");

export const HOW_IT_WORKS_PAGE = [
  `<b>How OGMP MM works</b>`,
  RULER_HTML,
  "",
  "<b>Flow</b>",
  "1. Seller fills the <b>Delivery Vault</b> (locked)",
  "2. Buyer pays into <b>escrow</b> (Deal Protection)",
  "3. Payment confirms → vault unlocks",
  "4. <b>Buyer Review</b> — inspect, then confirm",
  "5. <b>Release Request</b> — seller receives payout per rules",
  "",
  "<b>Safe</b>",
  "Nothing leaves escrow until the right step.",
  "",
  "<b>Next</b>",
  "Create a deal or join with an invite.",
  footerHtml(),
].join("\n");

export const SAFETY_RULES_PAGE = [
  `<b>Safety rules</b>`,
  RULER_HTML,
  "",
  "<b>What</b>",
  "Rules that keep Deal Protection meaningful.",
  "",
  "<b>Do</b>",
  "• Stay in‑bot for pay, files, and decisions",
  "• Verify usernames; screenshots can lie",
  "• Finish Buyer Review before you confirm",
  "• Use Case Review + evidence if something is wrong",
  "",
  "<b>Do not</b>",
  "• Illegal or fraudulent trades",
  "• “Side deals” outside the bot flow",
  footerHtml(),
].join("\n");

export function supportPageText(supportUsername: string | undefined): string {
  const handle = escapeTelegramHtml(supportUsername?.trim().replace(/^@+/, "") || "your_support_handle");
  return [
    `<b>Support</b>`,
    RULER_HTML,
    "",
    "<b>What</b>",
    "Help for general questions vs. in‑deal problems.",
    "",
    "<b>Deal problem?</b>",
    "Open <b>Case Review</b> from the deal card (main bot) — do not post secrets here.",
    "",
    "<b>Official contact</b>",
    `<a href="https://t.me/${handle}">@${handle}</a>`,
    "",
    ANTI_IMPERSONATION_HTML,
    "",
    "<i>Official admin roster is published from the bot settings (ask an admin if empty).</i>",
    footerHtml(),
  ].join("\n");
}

export const ANTI_IMPERSONATION_HTML =
  "<i>Only trust messages from this official bot. OGMP admins will never ask you to pay outside the deal flow.</i>";

export const REPORT_BOT_HOME_PAGE = [
  `<b>OGMP MM REPORT</b> · <i>Case Review</i>`,
  RULER_HTML,
  "",
  "<b>What</b>",
  "Open or add evidence to a Case Review tied to your escrow deal.",
  "",
  "<b>Safe</b>",
  "Keep payment and files inside OGMP MM — never “verify” by sending funds elsewhere.",
  "",
  "<b>Next</b>",
  "Start from the <b>main bot</b> deal card → Open Case, then continue here.",
  "",
  "<i>Clear screenshots speed up review.</i>",
  footerHtml(),
].join("\n");

/** Plain preamble still used inside legacy plain delivery blocks; prefer HTML builders in delivery.service. */
export const DEAL_PROTECTION_BEFORE_PAY = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM — Deal Protection",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: you are paying escrow to unlock the Delivery Vault.",
  "Safe: funds are not released to the seller until Buyer Review + Release Request (or Case Review if needed).",
  "Next: send only the right coin and network to the address on the next screen.",
  "",
  "Never pay outside this deal.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");
