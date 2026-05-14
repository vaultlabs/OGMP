import { escapeTelegramHtml } from "../../utils/telegram-html.js";
import { getMaintenanceCustomMessage } from "../../services/platform-settings.service.js";
import { MAIN_UI_PARSE_MODE } from "./trust-copy.js";

export { MAIN_UI_PARSE_MODE };

export async function formatMaintenanceHtml(): Promise<string> {
  const custom = await getMaintenanceCustomMessage();
  const extra = custom ? `\n\n${escapeTelegramHtml(custom)}` : "";
  return [
    `<code>━━━━━━━━━━━━━━━━━━</code>`,
    `<b>OGMP MM</b> · <i>Maintenance</i>`,
    `<code>━━━━━━━━━━━━━━━━━━</code>`,
    "",
    "<b>OGMP MM is currently under maintenance.</b>",
    "",
    "<b>Active deals are still protected.</b>",
    "Please check again shortly.",
    extra,
    "",
    "<i>Admin commands:</i>",
    "<code>/admin_maint_on</code>",
    "<code>/admin_maint_off</code>",
    "<code>/admin_maint_msg Your message…</code>",
  ].join("\n");
}
