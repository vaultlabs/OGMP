import type { Deal, Payment, Payout } from "@prisma/client";

export type PaymentAddressResult = {
  address: string;
  reference?: string;
  providerRef?: string;
  expiresAt?: Date;
  /** When omitted, the deal flow uses `SupportedCoin.confirmationsRequired`. */
  requiredConfirmations?: number;
};

export type PaymentStatusResult = {
  status:
    | "pending"
    | "detecting"
    | "confirming"
    | "confirmed"
    | "underpaid"
    | "overpaid"
    | "expired"
    | "failed";
  receivedAmount: string;
  txHash?: string;
  confirmations: number;
  requiredConfirmations: number;
  raw?: unknown;
};

export type PayoutResult = {
  payoutId: string;
  txHash?: string;
  status: "pending" | "processing" | "completed" | "failed";
  raw?: unknown;
};

export interface PaymentProvider {
  readonly name: string;
  createPaymentAddress(deal: Deal, expectedAmount: string, currency: string, network: string): Promise<PaymentAddressResult>;
  checkPaymentStatus(payment: Payment): Promise<PaymentStatusResult>;
  createPayout(payout: Payout, destinationAddress: string): Promise<PayoutResult>;
  verifyWebhook(payload: Buffer | string, signatureHeader: string | undefined): boolean;
  /** Parse provider-specific webhook into normalized status update */
  parseWebhook(payload: unknown): {
    idempotencyKey: string;
    paymentExternalId?: string;
    result: PaymentStatusResult;
  };
}
