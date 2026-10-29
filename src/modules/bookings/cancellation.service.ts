// Cancelling passengers: by the user (DELETE /bookings/:pnr), or by chart preparation (waitlisted
// passengers left at chart time). Both go through cancelPassengersLocked, which:
//   1. works out each passenger's refund from their status *at this moment* (read under the lock),
//   2. runs the RAC/WL cascade (inventory.ts), so people behind them move up,
//   3. records the refund owed and the email to send, in the same transaction,
// and after the commit the refund is paid out (and retried by the reconciliation job if it fails).

import { Prisma } from "../../generated/prisma/client.js";
import { AppError, BadRequestError, NotFoundError } from "../../shared/error.js";
import { prisma } from "../../shared/prisma.js";
import { departureInstant } from "../trains/search.service.js";
import { enqueueNotification } from "../notifications/enqueue.js";
import { processRefund } from "../payments/refunds.js";
import { bookingInclude, toBookingView } from "./bookings.service.js";
import { lockClassInventory, releasePassengers } from "./inventory.js";
import { cancellationRefund } from "./refund-rules.js";
import { passengersCancelled } from "../../shared/metrics.js";

type Tx = Prisma.TransactionClient;

export const TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 };

const cancelInclude = {
    passengers: { orderBy: { position: "asc" } },
    payments: { where: { status: "CAPTURED" } },
    fromStop: { select: { departureMinutes: true } },
    schedule: { select: { journeyDate: true, train: { select: { departureMinutes: true } } } },
} satisfies Prisma.BookingInclude;

// Locks one booking row (after its class inventory). The payment path locks this same row, so a
// cancellation and a payment for one booking take turns instead of interleaving.
async function lockBooking(tx: Tx, bookingId: string) {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
    return tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: cancelInclude });
}

export type LockedBooking = Awaited<ReturnType<typeof lockBooking>>;

export function boardingDeparture(booking: LockedBooking): Date {
    return departureInstant(booking.schedule.journeyDate, booking.schedule.train.departureMinutes, booking.fromStop.departureMinutes!);
}

// Cancels `passengerIds` of a booking whose class inventory and row are locked by the caller.
// Returns what each passenger gets back, and the id of the Refund row to pay out after commit.
export async function cancelPassengersLocked(tx: Tx, booking: LockedBooking, passengerIds: string[], why: string, now: Date) {
    const leaving = booking.passengers.filter((p) => passengerIds.includes(p.id) && p.status !== "CANCELLED");
    const payment = booking.status === "CONFIRMED" ? booking.payments[0] : undefined;
    // Every passenger on a booking pays the same fare, and totalFare is always fare × passengers.
    const fare = booking.totalFare / booking.passengers.length;
    const msBeforeDeparture = boardingDeparture(booking).getTime() - now.getTime();

    const lines = leaving.map((p) => {
        const decision = payment
            ? cancellationRefund({ status: p.status, quota: booking.quota, coachClass: booking.class, fare, msBeforeDeparture })
            : { refund: 0, charge: 0, rule: "Not paid: nothing to refund" };
        return { position: p.position, name: p.name, previousStatus: p.status, ...decision };
    });

    await releasePassengers(tx, { scheduleId: booking.scheduleId, coachClass: booking.class, quota: booking.quota }, leaving.map((p) => p.id));

    const stillTravelling = booking.passengers.filter((p) => p.status !== "CANCELLED" && !passengerIds.includes(p.id)).length;
    if (stillTravelling === 0) await tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });

    const amount = lines.reduce((sum, l) => sum + l.refund, 0);
    const reason = `${why}: ${leaving.length} passenger${leaving.length === 1 ? "" : "s"}`;
    const refund = payment && amount > 0
        ? await tx.refund.create({ data: { bookingId: booking.id, paymentId: payment.id, amount, reason } })
        : null;
    if (payment) {
        await enqueueNotification(tx, "BOOKING_CANCELLED", booking.id, { reason, refund: amount, passengers: lines });
    }
    return { lines, refundAmount: amount, refundId: refund?.id ?? null };
}

// --------------------------------------------------------------------------- by the user

// Cancels the whole booking, or only the passengers at `positions` (1-based, as on the ticket).
export async function cancelBooking(userId: string, pnr: string, positions: number[] | undefined, now = new Date()) {
    const found = await prisma.booking.findFirst({ where: { pnr, userId }, select: { id: true, scheduleId: true, class: true } });
    if (!found) throw new NotFoundError("Booking");

    const result = await prisma.$transaction(async (tx) => {
        await lockClassInventory(tx, found.scheduleId, found.class);
        const booking = await lockBooking(tx, found.id);

        if (booking.status === "CANCELLED" || booking.status === "EXPIRED") {
            throw new AppError(409, "NOT_CANCELLABLE", `This booking is already ${booking.status}`);
        }
        if (boardingDeparture(booking) <= now) throw new AppError(409, "CANCELLATION_CLOSED", "The train has already left your boarding station");

        const active = booking.passengers.filter((p) => p.status !== "CANCELLED");
        let targets = active;
        if (positions) {
            const unknown = positions.filter((n) => !active.some((p) => p.position === n));
            if (unknown.length) throw new BadRequestError("INVALID_PASSENGERS", `No passenger to cancel at position ${unknown.join(", ")}`);
            targets = active.filter((p) => positions.includes(p.position));
            // The open payment order is for the whole party, so an unpaid booking is paid or cancelled whole.
            if (booking.status === "PENDING_PAYMENT" && targets.length < active.length) {
                throw new BadRequestError("PARTIAL_CANCEL_UNPAID", "An unpaid booking can only be cancelled as a whole");
            }
        }
        return cancelPassengersLocked(tx, booking, targets.map((p) => p.id), "Cancelled by you", now);
    }, TX_OPTIONS);

    passengersCancelled.inc({ reason: "user" }, result.lines.length);
    // Pay it out now if Razorpay answers; otherwise the reconciliation job retries.
    const processed = result.refundId ? await processRefund(result.refundId) : false;
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: found.id }, include: bookingInclude });
    return {
        booking: toBookingView(booking),
        cancellation: {
            passengers: result.lines,
            refund: result.refundId ? { amount: result.refundAmount, status: processed ? "PROCESSED" as const : "PENDING" as const } : null,
        },
    };
}
