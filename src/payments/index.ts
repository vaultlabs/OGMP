import { loadConfig } from "../config/index.js";
import { logger } from "../utils/logger.js";
import type { PaymentProvider } from "./payment-provider.types.js";
import { MockPaymentProvider } from "./mock-payment.provider.js";
import { NowPaymentsProvider } from "./nowpayments.provider.js";

/** Bumped when NOWPayments integration changes — check startup logs if you still see old stub errors. */
const NOWPAYMENTS_IMPL_TAG = "nowpayments_api_v1_2026_03";

let loggedProviderSelection = false;

export function getPaymentProvider(): PaymentProvider {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER === "nowpayments") {
    if (!loggedProviderSelection) {
      loggedProviderSelection = true;
      logger.info("payment_provider_selected", { provider: "nowpayments", impl: NOWPAYMENTS_IMPL_TAG });
    }
    return new NowPaymentsProvider();
  }
  if (!loggedProviderSelection) {
    loggedProviderSelection = true;
    logger.info("payment_provider_selected", { provider: "mock" });
  }
  return new MockPaymentProvider();
}
