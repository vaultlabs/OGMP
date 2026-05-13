import type { Deal, Payment, Payout } from "@prisma/client";
import type { PaymentAddressResult, PaymentProvider, PaymentStatusResult, PayoutResult } from "./payment-provider.types.js";
import { logger } from "../utils/logger.js";

/**
 * NOWPayments-style integration skeleton.
 * TODO: Add real `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, and `PUBLIC_BASE_URL` in production.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJ3
 */
export class NowPaymentsProvider implements PaymentProvider {
  readonly name = "nowpayments";

  verifyWebhook(_payload: Buffer | string, signatureHeader: string | undefined): boolean {
    // TODO: Implement IPN HMAC verification per NOWPayments documentation using NOWPAYMENTS_IPN_SECRET.
    void _payload;
    void signatureHeader;
    logger.warn("NOWPayments IPN verification not configured — rejecting webhook");
    return false;
  }

  parseWebhook(payload: unknown): {
    idempotencyKey: string;
    paymentExternalId?: string;
    result: PaymentStatusResult;
  } {
    void payload;
    throw new Error("NOWPayments parseWebhook not implemented — configure provider");
  }

  async createPaymentAddress(
    _deal: Deal,
    _expectedAmount: string,
    _currency: string,
    _network: string,
  ): Promise<PaymentAddressResult> {
    void _deal;
    void _expectedAmount;
    void _currency;
    void _network;
    throw new Error(
      "NOWPayments createPaymentAddress not implemented. Wire API calls to create invoice/payment.",
    );
  }

  async checkPaymentStatus(_payment: Payment): Promise<PaymentStatusResult> {
    void _payment;
    throw new Error("NOWPayments checkPaymentStatus not implemented");
  }

  async createPayout(_payout: Payout, _destinationAddress: string): Promise<PayoutResult> {
    void _payout;
    void _destinationAddress;
    throw new Error("NOWPayments createPayout not implemented");
  }
}
