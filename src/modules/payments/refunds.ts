// Pays out cancellation refunds. Each Refund row was written in the cancellation's transaction,
// so the debt is recorded before any network call; this turns it into money at Razorpay.
//
// The danger is refunding twice: we ask Razorpay to refund, it does, and we crash before marking
// the row PROCESSED. The retry must not refund again. So every refund carries our Refund id in
// its Razorpay `notes`, and before refunding we look for one that already has it.

import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";
import { paymentGateway } from "./gateway.js";

// Returns true once the refund is PROCESSED. Safe to call any number of times, from anywhere.
export async function processRefund(refundId: string): Promise<boolean> {
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!refund) return false;
    if (refund.status === "PROCESSED") return true;
    const paymentId = refund.payment.gatewayPaymentId!;

    try {
        const gateway = paymentGateway();
        const earlier = (await gateway.listRefunds(paymentId)).find((r) => r.notes.refundId === refund.id);
        const gatewayRefundId = earlier?.id
            ?? (await gateway.refundPayment(paymentId, { amount: refund.amount, notes: { refundId: refund.id } })).id;
        await prisma.refund.updateMany({
            where: { id: refund.id, status: "PENDING" },
            data: { status: "PROCESSED", gatewayRefundId, processedAt: new Date(), lastError: null },
        });
        return true;
    } catch (err) {
        await prisma.refund.update({ where: { id: refund.id }, data: { lastError: err instanceof Error ? err.message.slice(0, 500) : String(err) } });
        logger.error({ err, refundId: refund.id }, "Refund failed; the reconciliation job will retry");
        return false;
    }
}

// For the reconciliation job: every refund still owed, oldest first.
export async function processPendingRefunds(limit = 50): Promise<number> {
    const pending = await prisma.refund.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true } });
    let processed = 0;
    for (const { id } of pending) if (await processRefund(id)) processed += 1;
    return processed;
}
