import { z } from "zod";
import { pnrParamSchema } from "../bookings/bookings.schemas.js";

export const createOrderSchema = pnrParamSchema;

// Field names are Razorpay's, so the frontend can forward checkout's success response as-is.
export const verifyPaymentSchema = z.object({
    razorpay_order_id: z.string().regex(/^order_\w+$/, "Not a Razorpay order id"),
    razorpay_payment_id: z.string().regex(/^pay_\w+$/, "Not a Razorpay payment id"),
    razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/, "Signature is 64 hex characters"),
});

export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

// The part of a Razorpay webhook we read. Checked only after the signature is verified; anything
// that doesn't fit is acknowledged and ignored rather than retried forever.
export const webhookEventSchema = z.object({
    event: z.string(),
    payload: z.object({
        payment: z
            .object({
                entity: z.object({
                    id: z.string(),
                    order_id: z.string(),
                    amount: z.number().int(),
                    currency: z.string(),
                    status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
                    amount_refunded: z.number().int().default(0),
                    error_description: z.string().nullable().default(null),
                }),
            })
            .optional(),
    }),
});
