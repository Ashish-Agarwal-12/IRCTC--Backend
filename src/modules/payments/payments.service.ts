// Payments. The money moves in Razorpay's system, the seats live in our database, and neither can
// roll back the other. So instead of one transaction across both, every step is safe to repeat:
//
//   1. POST /payments/orders   create a Razorpay order for a held booking
//   2. user pays in Razorpay checkout
//   3. we learn the outcome, from any of three sources, all ending in settlePayment():
//        - POST /payments/verify   the browser, straight after paying (fast path)
//        - POST /payments/webhook  Razorpay, server to server (survives a closed browser)
//        - reconciliation job      asks Razorpay about open orders (survives lost webhooks and crashes)
//
// settlePayment() can run any number of times, in any order, from all three at once, and the result
// is the same: the booking is confirmed exactly once, or the money is refunded.

import { env } from "../../config/env.js";
import { AppError, BadRequestError, NotFoundError } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";
import { bookingInclude, toBookingView } from "../bookings/bookings.service.js";
import { GatewayRejectedError, fromRazorpay, paymentGateway, type GatewayPayment } from "./gateway.js";
import { isValidCheckoutSignature, isValidWebhookSignature } from "./signatures.js";
import { webhookEventSchema, type VerifyPaymentInput } from "./payments.schemas.js";
import { enqueueNotification } from "../notifications/outbox.js";

// --------------------------------------------------------------------------- 1. order

// Returns the order to open checkout with, and whether it was created now (201) or reused (200).
export async function createOrder(userId: string, pnr: string) {
    const gateway = paymentGateway();
    const booking = await prisma.booking.findFirst({
        where: { pnr, userId },
        include: { payments: { where: { status: "CREATED" }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!booking) throw new NotFoundError("Booking");
    if (booking.status === "CONFIRMED") throw new AppError(409, "ALREADY_PAID", "This booking is already paid");
    if (booking.status !== "PENDING_PAYMENT" || !booking.holdExpiresAt || booking.holdExpiresAt <= new Date()) {
        throw new AppError(409, "HOLD_EXPIRED", "The seat hold has expired; make a new booking");
    }

    // Opening checkout twice (two tabs, a retry) reuses the open order instead of making another.
    // Two requests at the very same moment can still create two orders; that's harmless, because
    // only one payment can confirm the booking and money on the other would be refunded.
    let payment = booking.payments[0]?.amount === booking.totalFare ? booking.payments[0] : undefined;
    const created = !payment;
    if (!payment) {
        // A gateway failure here throws 503 with nothing written: the hold is untouched, retry is safe.
        const order = await gateway.createOrder({
            amount: booking.totalFare,
            receipt: booking.pnr,
            notes: { pnr: booking.pnr, bookingId: booking.id }, // shown in the Razorpay dashboard
        });
        payment = await prisma.payment.create({
            data: { bookingId: booking.id, gatewayOrderId: order.id, amount: booking.totalFare },
        });
    }

    // Passed to Razorpay checkout's `prefill` option, so it doesn't ask for details the booking already has.
    const prefill = { contact: booking.contactPhone, email: booking.contactEmail };

    return {
        created,
        payment: {
            orderId: payment.gatewayOrderId,
            amount: payment.amount,
            currency: payment.currency,
            keyId: gateway.keyId,
            pnr: booking.pnr,
            holdExpiresAt: booking.holdExpiresAt,
            prefill,
            // Test-mode page that opens Razorpay checkout for this order. Details go after "#", so
            // they stay in the browser and never reach the server or its logs; the page also wipes
            // the phone and email from the address bar as soon as it has read them.
            checkoutUrl: `${env.APP_URL}/payments/checkout#` + new URLSearchParams({
                orderId: payment.gatewayOrderId, pnr: booking.pnr, amount: String(payment.amount), ...prefill,
            }),
        },
    };
}

// --------------------------------------------------------------------------- 3a. verify (browser)

// No login needed: the signature is the credential. Only Razorpay, holding our key secret, can
// produce a valid signature for this order + payment pair.
export async function verifyCheckout(input: VerifyPaymentInput) {
    const gateway = paymentGateway();
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = input;
    if (!isValidCheckoutSignature(env.RAZORPAY_KEY_SECRET!, orderId, paymentId, signature)) {
        throw new BadRequestError("INVALID_SIGNATURE", "Payment signature doesn't match");
    }
    // The signature proves Razorpay saw this payment, not that it succeeded or that the money is
    // ours yet, so ask Razorpay for its current state.
    const gatewayPayment = await gateway.fetchPayment(paymentId);
    if (gatewayPayment.orderId !== orderId) throw new BadRequestError("INVALID_SIGNATURE", "Payment doesn't belong to this order");

    const result = await settlePayment(gatewayPayment);
    if (result === "UNKNOWN_ORDER") throw new NotFoundError("Payment order");
    if (result === "NOT_PAID") {
        throw new AppError(402, "PAYMENT_NOT_COMPLETED", gatewayPayment.errorDescription ?? "The payment hasn't gone through");
    }
    const payment = await prisma.payment.findUniqueOrThrow({
        where: { gatewayOrderId: orderId },
        include: { booking: { include: bookingInclude } },
    });
    return { result, booking: toBookingView(payment.booking) };
}

// --------------------------------------------------------------------------- 3b. webhook (Razorpay)

// The events we act on. Razorpay sends many more; the rest are acknowledged and ignored.
const PAYMENT_EVENTS = new Set(["payment.captured", "payment.failed", "order.paid"]);

export async function handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, eventId: string | undefined) {
    const secret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Webhooks are not set up (RAZORPAY_WEBHOOK_SECRET is empty)");
    if (!rawBody || !signature || !isValidWebhookSignature(secret, rawBody, signature)) {
        throw new BadRequestError("INVALID_SIGNATURE", "Webhook signature doesn't match");
    }

    // Razorpay redelivers until it gets a 2xx, so the same event can arrive many times. Skipping
    // ones we've seen saves work; correctness doesn't depend on it, because settlePayment is
    // idempotent anyway. The event is recorded only after it's handled: if handling fails we
    // answer 500, Razorpay retries, and the retry isn't wrongly skipped.
    if (eventId && (await prisma.paymentEvent.findUnique({ where: { id: eventId } }))) return { handled: "duplicate" as const };

    const event = webhookEventSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    let handled: "processed" | "ignored" = "ignored";
    if (event.success && PAYMENT_EVENTS.has(event.data.event) && event.data.payload.payment) {
        await settlePayment(fromRazorpay(event.data.payload.payment.entity));
        handled = "processed";
    }
    if (eventId) {
        const type = event.success ? event.data.event : "unrecognised";
        await prisma.paymentEvent.createMany({ data: [{ id: eventId, type }], skipDuplicates: true });
    }
    return { handled };
}

// --------------------------------------------------------------------------- the core

export type SettleResult = "CONFIRMED" | "REFUND_PENDING" | "REFUNDED" | "NOT_PAID" | "UNKNOWN_ORDER";

// Applies what Razorpay says about one payment to our database. Idempotent.
export async function settlePayment(reported: GatewayPayment): Promise<SettleResult> {
    let gatewayPayment = reported;

    if (gatewayPayment.status === "failed" || gatewayPayment.status === "created") {
        // One failed attempt doesn't close the order: the user can retry on the same checkout.
        if (gatewayPayment.errorDescription) {
            await prisma.payment.updateMany({
                where: { gatewayOrderId: gatewayPayment.orderId, status: "CREATED" },
                data: { lastError: gatewayPayment.errorDescription },
            });
        }
        return (await prisma.payment.count({ where: { gatewayOrderId: gatewayPayment.orderId } })) ? "NOT_PAID" : "UNKNOWN_ORDER";
    }

    // "authorized": the bank approved it but the money isn't ours until we capture. Capture
    // *before* confirming, so a booking is never CONFIRMED without money (if the booking then
    // can't be confirmed, the money is refunded below). Test accounts usually auto-capture.
    if (gatewayPayment.status === "authorized") {
        const known = await prisma.payment.findUnique({ where: { gatewayOrderId: gatewayPayment.orderId } });
        if (!known) return "UNKNOWN_ORDER"; // not our order: don't take the money
        gatewayPayment = await capture(gatewayPayment);
    }

    const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findUnique({ where: { gatewayOrderId: gatewayPayment.orderId } });
        if (!payment) return { result: "UNKNOWN_ORDER" as const };

        // One payer at a time per booking. Locks only the booking row, never seat inventory, so it
        // can't deadlock with the hold sweeper (which locks inventory, then bookings).
        await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${payment.bookingId} FOR UPDATE`;
        const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });

        // Already settled (a webhook after the verify call, or a second webhook): change nothing.
        if (current.gatewayPaymentId === gatewayPayment.id) {
            const settled = { CAPTURED: "CONFIRMED", REFUNDED: "REFUNDED" } as const;
            return { result: settled[current.status as keyof typeof settled] ?? "REFUND_PENDING", paymentId: current.id };
        }
        if (current.gatewayPaymentId) {
            // Razorpay allows only one successful payment per order, so this shouldn't happen.
            logger.error({ orderId: current.gatewayOrderId, paymentId: gatewayPayment.id }, "Second payment on one order; needs manual review");
            return { result: "REFUND_PENDING" as const };
        }

        const booking = await tx.booking.findUniqueOrThrow({ where: { id: payment.bookingId } });
        const amountMatches = gatewayPayment.amount === payment.amount && gatewayPayment.currency === payment.currency;

        // The rule: if the seats are still held, the payment confirms them. A hold past
        // holdExpiresAt that the sweeper hasn't released yet still counts as held (at most ~15 s);
        // the sweeper's conditional update then finds CONFIRMED and leaves it alone.
        if (booking.status === "PENDING_PAYMENT" && amountMatches) {
            await tx.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
            await tx.payment.update({
                where: { id: payment.id },
                data: { status: "CAPTURED", gatewayPaymentId: gatewayPayment.id, lastError: null },
            });
            // Any other open orders for this booking are no longer needed.
            await tx.payment.updateMany({
                where: { bookingId: booking.id, status: "CREATED", id: { not: payment.id } },
                data: { status: "EXPIRED" },
            });
            // Ticket email, committed together with the confirmation (see notifications/outbox.ts).
            await enqueueNotification(tx, "BOOKING_CONFIRMED", booking.id);
            return { result: "CONFIRMED" as const };
        }

        // Money arrived, but there are no seats to give for it: hold expired and released, booking
        // already paid through another order, or a wrong amount. Record the debt first, in the same
        // transaction, so even a crash right now leaves a REFUND_PENDING row for the job to pay out.
        const reason = !amountMatches ? "Amount doesn't match the order"
            : booking.status === "CONFIRMED" ? "Booking was already paid"
            : "Seat hold expired before the payment arrived";
        await tx.payment.update({
            where: { id: payment.id },
            data: { status: "REFUND_PENDING", gatewayPaymentId: gatewayPayment.id, lastError: reason },
        });
        // Tell the user why they were charged without getting seats. (A duplicate payment on an
        // already-confirmed booking is refunded quietly: they have their ticket.)
        if (booking.status !== "CONFIRMED") await enqueueNotification(tx, "REFUND_INITIATED", booking.id);
        logger.warn({ orderId: payment.gatewayOrderId, reason }, "Payment can't be used; refunding");
        return { result: "REFUND_PENDING" as const, paymentId: payment.id };
    });

    // The refund is a network call, so it happens after the transaction (never hold locks while
    // waiting on Razorpay). If it fails, the row stays REFUND_PENDING and the job retries.
    if (result.result === "REFUND_PENDING" && result.paymentId) {
        return (await refundOwed(result.paymentId)) ? "REFUNDED" : "REFUND_PENDING";
    }
    return result.result;
}

async function capture(payment: GatewayPayment): Promise<GatewayPayment> {
    try {
        return await paymentGateway().capturePayment(payment.id, payment.amount);
    } catch (err) {
        // Captured meanwhile (auto-capture, or another of our three paths): fine, carry on.
        if (!(err instanceof GatewayRejectedError)) throw err;
        const fresh = await paymentGateway().fetchPayment(payment.id);
        if (fresh.status !== "captured") throw err;
        return fresh;
    }
}

// Pays back a REFUND_PENDING payment. Returns true once it's REFUNDED. Safe to call repeatedly:
// Razorpay's own record of what's been refunded is checked first, and Razorpay refuses to refund
// more than was paid, so even two concurrent calls can't refund twice.
export async function refundOwed(paymentRowId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentRowId } });
    if (!payment || !payment.gatewayPaymentId) return false;
    if (payment.status === "REFUNDED") return true;
    if (payment.status !== "REFUND_PENDING") return false;

    try {
        const gateway = paymentGateway();
        const current = await gateway.fetchPayment(payment.gatewayPaymentId);
        let refundId: string | null = null;
        if (current.amountRefunded < current.amount) refundId = (await gateway.refundPayment(payment.gatewayPaymentId)).id;
        await prisma.payment.updateMany({
            where: { id: payment.id, status: "REFUND_PENDING" },
            data: { status: "REFUNDED", ...(refundId && { refundId }) },
        });
        return true;
    } catch (err) {
        logger.error({ err, paymentId: payment.id }, "Refund failed; the reconciliation job will retry");
        return false;
    }
}
