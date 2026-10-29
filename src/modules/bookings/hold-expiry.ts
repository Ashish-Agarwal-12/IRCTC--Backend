// Releases seats of holds whose 10 minutes ran out without payment.
//
// Two mechanisms, so "released immediately" holds where it matters:
// 1. Lazily: every booking first releases expired holds in the class it's about to book
//    (bookings.service.ts). Nobody can be refused a seat that an expired hold still sits on.
// 2. This sweeper, every few seconds, so availability in search catches up even when nobody books.
//
// The database is the source of truth: holdExpiresAt is stored on the booking, so a crash or
// restart loses nothing; the next sweep picks up whatever expired while the server was down.
// Several server instances can sweep at once safely: they queue on the same row locks, and the
// conditional status update lets only one of them expire each booking.

import { prisma } from "../../shared/prisma.js";
import { logger } from "../../shared/logger.js";
import { lockClassInventory, releaseExpiredHolds } from "./inventory.js";

// Returns how many bookings were expired.
export async function expireHolds(now = new Date()): Promise<number> {
    // groupBy gives one row per schedule + class that has overdue holds: each needs one lock.
    const groups = await prisma.booking.groupBy({
        by: ["scheduleId", "class"],
        where: { status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
    });

    let expired = 0;
    for (const { scheduleId, class: coachClass } of groups) {
        // One short transaction per class, so a sweep never holds many locks at once and blocks bookings.
        expired += await prisma.$transaction(async (tx) => {
            await lockClassInventory(tx, scheduleId, coachClass);
            return releaseExpiredHolds(tx, scheduleId, coachClass, now);
        });
    }
    return expired;
}

// Starts the periodic sweep; returns a function that stops it (used on shutdown).
export function startHoldSweeper(intervalMs = 15_000): () => void {
    let running = false;
    const timer = setInterval(async () => {
        if (running) return; // a slow sweep is still going; don't start a second one on top of it
        running = true;
        try {
            const expired = await expireHolds();
            if (expired > 0) logger.info({ expired }, "Released expired seat holds");
        } catch (err) {
            // Never let a failed sweep crash the server; the next one retries.
            logger.error({ err }, "Hold sweep failed");
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref(); // don't keep the process alive just for this timer
    return () => clearInterval(timer);
}
