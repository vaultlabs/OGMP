import { loadConfig } from "../config/index.js";
import type { PaymentProvider } from "./payment-provider.types.js";
import { MockPaymentProvider } from "./mock-payment.provider.js";
import { NowPaymentsProvider } from "./nowpayments.provider.js";

export function getPaymentProvider(): PaymentProvider {
  const cfg = loadConfig();
  if (cfg.PAYMENT_PROVIDER === "nowpayments") return new NowPaymentsProvider();
  return new MockPaymentProvider();
}
