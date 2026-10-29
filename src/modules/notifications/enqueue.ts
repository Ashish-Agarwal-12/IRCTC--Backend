// Queue an email inside the transaction that makes the change it reports. Kept apart from the
// worker (outbox.ts) so any module can enqueue without importing what the worker needs to send.

import type { NotificationType, Prisma } from "../../generated/prisma/client.js";

export function enqueueNotification(
    tx: Prisma.TransactionClient, type: NotificationType, bookingId: string, payload?: Prisma.InputJsonValue,
) {
    return tx.outboxMessage.create({ data: { type, bookingId, payload } });
}
