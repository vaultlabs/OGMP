/** Shared trust / community lines — keep factual, not hypey. */
export const COMMUNITY_TRUST_LINE = "Trusted by 1,100+ OGMP community members.";
export const COMMUNITY_TRUST_ALT = "Part of a growing 1,100+ member trading community.";

/** One-line safety + brand (used under many screens). */
export const TRUST_OPS_FOOTER =
  "Deal Protection: escrow holds funds, the Delivery Vault holds files, and Case Review is there if something goes wrong.";

export const PREMIUM_WELCOME = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM — Secure Middleman",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: escrow deals with a clear path from upload to release.",
  "Safe: funds stay in escrow; files stay in the Delivery Vault until payment confirms.",
  "Next: create or join a deal, or open How It Works.",
  "",
  COMMUNITY_TRUST_LINE,
  "",
  "Vault → Pay → Unlock → Buyer Review → Release Request",
  "",
  "Choose an option below.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export const WHY_TRUST_PAGE = [
  "━━━━━━━━━━━━━━━━━━",
  "Why Trust OGMP MM?",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: one place for the whole deal.",
  "Safe: Deal Protection (escrow + Delivery Vault + optional Case Review).",
  "Next: start a deal and keep everything inside this bot.",
  "",
  `• ${COMMUNITY_TRUST_LINE}`,
  "• Payment sits in escrow before the Delivery Vault unlocks",
  "• Timeline + evidence for Case Review if needed",
  "",
  "Always trade in the deal room. Never pay outside OGMP MM.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export const HOW_IT_WORKS_PAGE = [
  "━━━━━━━━━━━━━━━━━━",
  "How OGMP MM Works",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What happens (simple):",
  "1. Seller → Delivery Vault (locked)",
  "2. Buyer → pay into escrow (Deal Protection)",
  "3. Payment confirms → vault unlocks",
  "4. Buyer Review → you confirm",
  "5. Release Request → seller gets paid",
  "",
  "Safe: nothing leaves escrow until the right step.",
  "Next: Create Deal or Join Deal.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export const SAFETY_RULES_PAGE = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM — Safety Rules",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: rules that keep Deal Protection real.",
  "Safe: stay in-bot; escrow + Delivery Vault only.",
  "Next: read once, then trade only inside the deal room.",
  "",
  "• Never pay outside OGMP MM",
  "• Check usernames; don’t trust screenshots alone",
  "• Finish Buyer Review before confirming",
  "• Use Case Review + evidence if something is wrong",
  "• Illegal or fraudulent deals are not allowed",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export function supportPageText(supportUsername: string | undefined): string {
  const handle = supportUsername?.trim().replace(/^@+/, "") || "your_support_handle";
  return [
    "━━━━━━━━━━━━━━━━━━",
    "OGMP MM — Support",
    "━━━━━━━━━━━━━━━━━━",
    "",
    "What: help for questions vs. deal problems.",
    "Safe: deal money/files stay under Deal Protection in-bot.",
    "Next: deal issue → Open Case; general → /support format in this bot.",
    "",
    `Official support: @${handle}`,
    "",
    "Only trust admins listed inside this bot.",
    "",
    TRUST_OPS_FOOTER,
  ].join("\n");
}

export const REPORT_BOT_HOME_PAGE = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM REPORT — Case Review",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: open or add to a Case Review for a deal.",
  "Safe: your escrow deal stays linked — don’t move payment outside OGMP MM.",
  "Next: start from the main bot deal card, then follow prompts here.",
  "",
  "Clear screenshots speed Case Review.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export const DEAL_PROTECTION_BEFORE_PAY = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM — Deal Protection",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "What: you’re paying escrow to unlock the Delivery Vault.",
  "Safe: funds are not released to the seller until Buyer Review + Release Request (or Case Review if needed).",
  "Next: send only the right coin/network to the address on the next screen.",
  "",
  "Never pay outside this deal room.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");
