// The concurrency core: every change to seat inventory goes through these helpers, inside a
// transaction, after locking the inventory rows it touches.

import { Prisma, type CoachClass } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

// Locks every SeatInventory row (all quotas) of one class on one schedule until the transaction
// ends. Any other transaction that calls this for the same schedule + class waits here.
//
// Why all quotas, not just the one being booked: GENERAL and TATKAL bookings in AC3 pick physical
// seats from the same coaches. If they held different locks, both could read seat B1-23 as free.
// Locking the whole class makes "read the free seats, then take some" one indivisible step.
//
// Why raw SQL: Prisma's query API has no SELECT ... FOR UPDATE. `$queryRaw` with a template
// literal sends ${values} as bound parameters, never pasted into the SQL, so it's injection-safe.
// ORDER BY makes every transaction lock rows in the same order, which rules out deadlocks
// (A holds GENERAL waiting for TATKAL while B holds TATKAL waiting for GENERAL).
export async function lockClassInventory(tx: Tx, scheduleId: string, coachClass: CoachClass) {
    return tx.$queryRaw<{ id: string; quota: string }[]>`
        SELECT id, quota FROM "SeatInventory"
        WHERE "scheduleId" = ${scheduleId} AND class = ${coachClass}::"CoachClass"
        ORDER BY quota
        FOR UPDATE`;
}

// Expires every overdue hold in one class of one schedule and gives its seats back.
// Call only after lockClassInventory for the same schedule + class.
export async function releaseExpiredHolds(tx: Tx, scheduleId: string, coachClass: CoachClass, now: Date) {
    const due = await tx.booking.findMany({
        where: { scheduleId, class: coachClass, status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
        select: { id: true, quota: true },
    });

    let released = 0;
    for (const booking of due) {
        // Conditional update: only flips the status if it's still PENDING_PAYMENT. If a payment
        // confirmed it a moment ago (Phase 5), count is 0 and the seats stay with their owner.
        const { count } = await tx.booking.updateMany({
            where: { id: booking.id, status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
            data: { status: "EXPIRED" },
        });
        if (count === 0) continue;

        const passengers = await tx.passenger.findMany({
            where: { bookingId: booking.id, status: { not: "CANCELLED" } },
            select: { id: true, status: true },
        });
        const confirmed = passengers.filter((p) => p.status === "CONFIRMED").length;
        const rac = passengers.filter((p) => p.status === "RAC").length;

        await tx.seatAllocation.deleteMany({ where: { passengerId: { in: passengers.map((p) => p.id) } } });
        await tx.passenger.updateMany({ where: { bookingId: booking.id }, data: { status: "CANCELLED" } });
        // Waitlist numbers are tickets in a queue, not seats, so waitlistIssued isn't decremented.
        // KNOWN GAP until Phase 9: freed berths go back to the pool instead of promoting existing
        // RAC/WL passengers, so a new booking can get a berth ahead of them.
        await tx.seatInventory.update({
            where: { scheduleId_class_quota: { scheduleId, class: coachClass, quota: booking.quota } },
            data: { availableSeats: { increment: confirmed }, racBooked: { decrement: rac } },
        });
        released += 1;
    }
    return released;
}
