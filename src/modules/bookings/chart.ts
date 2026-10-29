// Chart preparation: 4 hours before a train leaves its origin, its passenger list is finalised.
// No more bookings, and passengers still waitlisted are cancelled with a refund (fare minus
// clerkage). RAC passengers stay: they travel sharing a berth, and can still be upgraded if a
// confirmed passenger cancels before departure.
//
// Order matters, for correctness under concurrent bookings:
//   1. Mark the schedule CHART_PREPARED (conditional, so it runs once even with several servers).
//   2. Then, class by class, lock the inventory and cancel the waitlist.
// A booking re-checks the schedule's status after taking the class lock (bookings.service.ts), so
// it either ran before step 2 reached its class (and its waitlisted passengers are cancelled with
// the rest) or sees CHART_PREPARED and is refused. Nobody can join a queue that's been cleared.
// Each class is its own short transaction, so bookings in other classes aren't held up.

import { NotFoundError, AppError } from "../../shared/error.js";
import { prisma } from "../../shared/prisma.js";
import { startIntervalJob } from "../../shared/interval-job.js";
import { addDays } from "../../shared/validation.js";
import { CLASS_ORDER } from "../trains/availability.js";
import { departureInstant } from "../trains/search.service.js";
import { processRefund } from "../payments/refunds.js";
import { TX_OPTIONS, cancelPassengersLocked } from "./cancellation.service.js";
import { lockClassInventory } from "./inventory.js";
import { chartsPrepared, passengersCancelled } from "../../shared/metrics.js";

export const CHART_HOURS_BEFORE_DEPARTURE = 4;

export async function prepareChart(scheduleId: string, now = new Date()) {
    const { count } = await prisma.trainSchedule.updateMany({
        where: { id: scheduleId, status: "SCHEDULED" },
        data: { status: "CHART_PREPARED", chartPreparedAt: now },
    });
    if (count === 0) {
        const schedule = await prisma.trainSchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
        if (!schedule) throw new NotFoundError("Schedule");
        throw new AppError(409, "CHART_ALREADY_PREPARED", `This schedule is ${schedule.status}, so its chart can't be prepared`);
    }

    const classes = (await prisma.seatInventory.findMany({ where: { scheduleId }, distinct: ["class"], select: { class: true } }))
        .map((i) => i.class)
        .sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));

    let cancelledPassengers = 0;
    const affectedBookings = new Set<string>();
    const refundIds: string[] = [];
    for (const coachClass of classes) {
        await prisma.$transaction(async (tx) => {
            await lockClassInventory(tx, scheduleId, coachClass);
            const waitlisted = await tx.passenger.findMany({
                where: { status: "WAITLISTED", booking: { scheduleId, class: coachClass } },
                select: { id: true, bookingId: true },
                orderBy: { bookingId: "asc" }, // fixed order of booking-row locks
            });
            const byBooking = new Map<string, string[]>();
            for (const p of waitlisted) byBooking.set(p.bookingId, [...(byBooking.get(p.bookingId) ?? []), p.id]);
            for (const [bookingId, passengerIds] of byBooking) {
                await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
                const booking = await tx.booking.findUniqueOrThrow({
                    where: { id: bookingId },
                    include: {
                        passengers: { orderBy: { position: "asc" } },
                        payments: { where: { status: "CAPTURED" } },
                        fromStop: { select: { departureMinutes: true } },
                        schedule: { select: { journeyDate: true, train: { select: { departureMinutes: true } } } },
                    },
                });
                const result = await cancelPassengersLocked(tx, booking, passengerIds, "Waitlisted at chart preparation", now);
                cancelledPassengers += result.lines.length;
                affectedBookings.add(bookingId);
                if (result.refundId) refundIds.push(result.refundId);
            }
        }, TX_OPTIONS);
    }

    chartsPrepared.inc();
    passengersCancelled.inc({ reason: "chart" }, cancelledPassengers);
    for (const id of refundIds) await processRefund(id); // failures are retried by the reconciliation job
    return { scheduleId, preparedAt: now, cancelledPassengers, affectedBookings: affectedBookings.size };
}

// Prepares every chart that's due. Returns how many it prepared.
export async function prepareDueCharts(now = new Date()): Promise<number> {
    // Cheap filter in SQL (nothing more than a couple of days out can be due), exact check in JS.
    const candidates = await prisma.trainSchedule.findMany({
        where: { status: "SCHEDULED", journeyDate: { lte: addDays(now, 2) } },
        select: { id: true, journeyDate: true, train: { select: { departureMinutes: true } } },
    });
    let prepared = 0;
    for (const s of candidates) {
        const departs = departureInstant(s.journeyDate, s.train.departureMinutes, 0);
        if (departs.getTime() - CHART_HOURS_BEFORE_DEPARTURE * 60 * 60_000 > now.getTime()) continue;
        try {
            await prepareChart(s.id, now);
            prepared += 1;
        } catch (err) {
            // Another server got there first: fine.
            if (!(err instanceof AppError && err.code === "CHART_ALREADY_PREPARED")) throw err;
        }
    }
    return prepared;
}

// Every minute. Started in server.ts.
export function startChartJob(intervalMs = 60_000): () => void {
    return startIntervalJob("chart-preparation", intervalMs, () => prepareDueCharts());
}
