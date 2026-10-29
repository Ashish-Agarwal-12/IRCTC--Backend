// The concurrency core: every change to seat inventory goes through these helpers, inside a
// transaction, after locking the inventory rows it touches.

import { Prisma, type CoachClass, type PassengerStatus, type Quota } from "../../generated/prisma/client.js";
import { enqueueNotification } from "../notifications/enqueue.js";
import { pickSeats } from "./seat-picking.js";

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

// Seats of this class on this train with no allocation on this schedule.
export async function freeSeats(tx: Tx, scheduleId: string, trainId: string, coachClass: CoachClass) {
    const seats = await tx.seat.findMany({
        where: { coach: { trainId, class: coachClass }, allocations: { none: { scheduleId } } },
        select: { id: true, number: true, berthType: true, coach: { select: { code: true } } },
    });
    return seats.map((s) => ({ id: s.id, number: s.number, berthType: s.berthType, coachCode: s.coach.code }));
}

// --------------------------------------------------------------------------- the RAC/WL cascade

// One queue: the passengers of one quota in one class of one schedule.
export interface QueueKey {
    scheduleId: string;
    coachClass: CoachClass;
    quota: Quota;
}

// RAC and waitlist numbers are *current positions*: RAC 1 is next in line for a berth. So the
// numbers must stay 1..n with no gaps. This closes the gaps in one set-based UPDATE (ROW_NUMBER
// over the current order), however many passengers moved, instead of one update per passenger.
async function renumberQueue(tx: Tx, key: QueueKey, status: "RAC" | "WAITLISTED") {
    // A column name can't be a bound parameter; Prisma.raw inserts one of two fixed strings, never user input.
    const column = Prisma.raw(status === "RAC" ? `"racNumber"` : `"waitlistNumber"`);
    await tx.$executeRaw`
        UPDATE "Passenger" AS p SET ${column} = q.n
        FROM (
            SELECT p2.id, ROW_NUMBER() OVER (ORDER BY p2.${column}, b."createdAt", p2.position) AS n
            FROM "Passenger" p2 JOIN "Booking" b ON b.id = p2."bookingId"
            WHERE b."scheduleId" = ${key.scheduleId} AND b.class = ${key.coachClass}::"CoachClass"
              AND b.quota = ${key.quota}::"Quota" AND p2.status = ${status}::"PassengerStatus"
        ) AS q
        WHERE p.id = q.id AND p.${column} IS DISTINCT FROM q.n`;
}

const queueWhere = (key: QueueKey, status: PassengerStatus) => ({
    status,
    booking: { scheduleId: key.scheduleId, class: key.coachClass, quota: key.quota },
});

// The passenger at the front of a queue.
const queueHead = (tx: Tx, key: QueueKey, status: "RAC" | "WAITLISTED") =>
    tx.passenger.findFirst({
        where: queueWhere(key, status),
        orderBy: status === "RAC" ? { racNumber: "asc" } : { waitlistNumber: "asc" },
        select: { id: true, bookingId: true, requestedBerth: true },
    });

// Takes passengers out of a queue (cancelled, or their hold expired) and moves everyone behind
// them up. Call only after lockClassInventory for the same schedule + class: the lock is what
// stops two cascades (or a cascade and a booking) from promoting the same passenger or handing
// out the same berth. Everything happens in the caller's transaction, so the whole cascade
// commits or none of it does.
//
// The rules, in order:
//   1. Each confirmed berth freed goes to RAC 1; if there's no RAC, to WL 1; if nobody waits, back to the pool.
//   2. Each RAC place freed (an RAC passenger left, or RAC 1 just got a berth) goes to WL 1.
//   3. Renumber both queues so positions are 1..n again.
// Returns the ids of bookings whose passengers moved up.
export async function releasePassengers(tx: Tx, key: QueueKey, passengerIds: string[]): Promise<Set<string>> {
    const leaving = await tx.passenger.findMany({
        where: { id: { in: passengerIds }, status: { not: "CANCELLED" } },
        select: { id: true, status: true },
    });
    const moved = new Set<string>();
    if (leaving.length === 0) return moved;

    const ids = leaving.map((p) => p.id);
    await tx.seatAllocation.deleteMany({ where: { passengerId: { in: ids } } });
    await tx.passenger.updateMany({ where: { id: { in: ids } }, data: { status: "CANCELLED", racNumber: null, waitlistNumber: null } });

    const inventory = await tx.seatInventory.findUniqueOrThrow({
        where: { scheduleId_class_quota: { scheduleId: key.scheduleId, class: key.coachClass, quota: key.quota } },
    });
    const { trainId } = await tx.trainSchedule.findUniqueOrThrow({ where: { id: key.scheduleId }, select: { trainId: true } });

    // 1. Freed berths.
    let berths = leaving.filter((p) => p.status === "CONFIRMED").length;
    while (berths > 0) {
        const head = (await queueHead(tx, key, "RAC")) ?? (await queueHead(tx, key, "WAITLISTED"));
        if (!head) break;
        const [seat] = pickSeats(await freeSeats(tx, key.scheduleId, trainId, key.coachClass), [head.requestedBerth ?? undefined]);
        await tx.passenger.update({ where: { id: head.id }, data: { status: "CONFIRMED", racNumber: null, waitlistNumber: null } });
        await tx.seatAllocation.create({ data: { scheduleId: key.scheduleId, seatId: seat.id, passengerId: head.id } });
        moved.add(head.bookingId);
        berths -= 1;
    }

    // 2. Freed RAC places. A promoted passenger joins the back of RAC: the large number sorts after
    // everyone already there, and step 3 turns it into the right position.
    let racCount = await tx.passenger.count({ where: queueWhere(key, "RAC") });
    while (racCount < inventory.racCapacity) {
        const head = await queueHead(tx, key, "WAITLISTED");
        if (!head) break;
        await tx.passenger.update({ where: { id: head.id }, data: { status: "RAC", racNumber: 1_000_000 + racCount, waitlistNumber: null } });
        moved.add(head.bookingId);
        racCount += 1;
    }

    // 3. Positions back to 1..n, and counters that match the queues.
    await renumberQueue(tx, key, "RAC");
    await renumberQueue(tx, key, "WAITLISTED");
    await tx.seatInventory.update({
        where: { id: inventory.id },
        data: {
            availableSeats: { increment: berths }, // berths nobody was waiting for
            racBooked: racCount,
            waitlistBooked: await tx.passenger.count({ where: queueWhere(key, "WAITLISTED") }),
        },
    });

    // Paid bookings whose passengers moved up get an email with their new status (and ticket).
    // Unpaid ones don't: the confirmation email will show the status once they pay.
    const paid = await tx.booking.findMany({ where: { id: { in: [...moved] }, status: "CONFIRMED" }, select: { id: true } });
    for (const { id } of paid) await enqueueNotification(tx, "STATUS_CHANGED", id);
    return moved;
}

// --------------------------------------------------------------------------- expired holds

// Expires every overdue hold in one class of one schedule and gives its places to the queue.
// Call only after lockClassInventory for the same schedule + class.
export async function releaseExpiredHolds(tx: Tx, scheduleId: string, coachClass: CoachClass, now: Date) {
    const due = await tx.booking.findMany({
        where: { scheduleId, class: coachClass, status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
        select: { id: true, quota: true },
    });

    let released = 0;
    for (const booking of due) {
        // Conditional update: only flips the status if it's still PENDING_PAYMENT. If a payment
        // confirmed it a moment ago, count is 0 and the seats stay with their owner.
        const { count } = await tx.booking.updateMany({
            where: { id: booking.id, status: "PENDING_PAYMENT", holdExpiresAt: { lte: now } },
            data: { status: "EXPIRED" },
        });
        if (count === 0) continue;

        const passengers = await tx.passenger.findMany({ where: { bookingId: booking.id }, select: { id: true } });
        // Freed berths go to RAC/WL passengers already waiting, ahead of any new booking.
        await releasePassengers(tx, { scheduleId, coachClass, quota: booking.quota }, passengers.map((p) => p.id));
        released += 1;
    }
    return released;
}
