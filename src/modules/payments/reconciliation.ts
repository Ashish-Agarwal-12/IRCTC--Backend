// The safety net for payments. The browser's verify call and Razorpay's webhook both normally
// settle a payment within seconds, but either can be lost: the user closes the tab, our server is
// down when the webhook arrives, a crash lands between two steps. This job asks Razorpay directly
// and fixes whatever we missed, so a paid booking is never left unconfirmed and a refund owed is
// never forgotten. Everything it calls is idempotent, so it can overlap with the other two paths.

import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";
import { startIntervalJob } from "../../shared/interval-job.js";
import { paymentGateway } from "./gateway.js";
import { refundOwed, settlePayment } from "./payments.service.js";
import { processPendingRefunds } from "./refunds.js";

const BATCH = 50;
// Give the fast paths (verify, webhook) a minute before stepping in.
const GRACE_MS = 60_000;

// Returns how many payments it changed.
export async function reconcilePayments(now = new Date()): Promise<number> {
    const gateway = paymentGateway();
    let changed = 0;

    // 1. Open orders: did anyone pay them without us hearing about it?
    const open = await prisma.payment.findMany({
        where: { status: "CREATED", createdAt: { lte: new Date(now.getTime() - GRACE_MS) } },
        include: { booking: { select: { status: true } } },
        orderBy: { createdAt: "asc" },
        take: BATCH,
    });
    for (const payment of open) {
        try {
            const attempts = await gateway.listOrderPayments(payment.gatewayOrderId);
            const paid = attempts.find((a) => a.status === "captured" || a.status === "authorized");
            if (paid) {
                await settlePayment(paid);
                changed += 1;
            } else if (payment.booking.status !== "PENDING_PAYMENT") {
                // Nobody paid and the booking no longer needs it (hold expired, or paid via another
                // order). If someone pays it after all, settlePayment still refunds them.
                const { count } = await prisma.payment.updateMany({
                    where: { id: payment.id, status: "CREATED" },
                    data: { status: "EXPIRED" },
                });
                changed += count;
            }
        } catch (err) {
            // One unreachable order mustn't stop the rest of the batch.
            logger.error({ err, orderId: payment.gatewayOrderId }, "Couldn't reconcile order");
        }
    }

    // 2. Whole-payment refunds we owe but couldn't issue yet (gateway was down, or we crashed before calling it).
    const owed = await prisma.payment.findMany({ where: { status: "REFUND_PENDING" }, orderBy: { updatedAt: "asc" }, take: BATCH });
    for (const payment of owed) {
        if (await refundOwed(payment.id)) changed += 1;
    }

    // 3. Cancellation refunds not yet issued.
    changed += await processPendingRefunds(BATCH);
    return changed;
}

// Every minute. Started only when Razorpay keys are configured (see server.ts).
export function startPaymentReconciler(intervalMs = 60_000): () => void {
    return startIntervalJob("payment-reconciliation", intervalMs, () => reconcilePayments());
}
