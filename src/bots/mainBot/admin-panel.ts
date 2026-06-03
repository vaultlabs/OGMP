import { InlineKeyboard } from "grammy";
import { TRUST_OPS_FOOTER } from "./trust-copy.js";

export const ADMIN_PANEL_INTRO = [
  "━━━━━━━━━━━━━━━━━━",
  "OGMP MM — Admin Dashboard",
  "━━━━━━━━━━━━━━━━━━",
  "",
  "Pick a tool below. Dashboard shows live counters.",
  "",
  TRUST_OPS_FOOTER,
].join("\n");

export function adminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Dashboard", "a:dash")
    .row()
    .text("Active deals", "a:act")
    .text("Open cases", "a:oc")
    .row()
    .text("Release requests", "a:relq")
    .text("Pending payouts", "a:pay")
    .row()
    .text("Disputed deals", "a:dis")
    .text("Users", "a:users")
    .row()
    .text("Broadcast", "a:bc:help")
    .row()
    .text("Export CSV", "a:csv")
    .text("Gateway", "a:gw:menu")
    .row()
    .text("Force release help", "a:fr")
    .text("Force refund help", "a:fref")
    .row()
    .text("Manage admins", "a:adm");
}
