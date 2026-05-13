import { z } from "zod";

export const createDealSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(4000),
  dealTerms: z.string().min(10).max(8000),
  deliveryInstructions: z.string().min(5).max(4000),
  proofRequirements: z.string().max(2000).optional(),
  creatorRole: z.enum(["buyer", "seller"]),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.enum(["USDT", "BTC", "ETH", "LTC"]),
  network: z.string().min(2).max(32),
  feePayer: z.enum(["buyer", "seller", "split"]),
  sellerPayoutAddress: z.string().min(8).max(128).optional(),
  buyerRefundAddress: z.string().min(8).max(128).optional(),
});

export const supportTicketSchema = z.object({
  dealCode: z.string().max(32).optional(),
  issueType: z.string().min(2).max(64),
  message: z.string().min(5).max(4000),
});

export const disputeEvidenceSchema = z.object({
  message: z.string().min(5).max(4000),
});

export const reviewSchema = z.object({
  stars: z.number().int().min(1).max(5),
  text: z.string().max(2000).optional(),
});
