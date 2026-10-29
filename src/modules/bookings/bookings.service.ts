// Booking = holding seats for 10 minutes while the user pays (payment arrives in Phase 5).
// The hard requirement: a berth is never given to two passengers, however many requests race.

import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type CoachClass } from "../../generated/prisma/client.js";
import { prisma } from "../../shared/prisma.js";
import { AppError, BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../shared/error.js";
import { todayUtc, toIsoDate, toSkipTake, type Pagination } from "../../shared/validation.js";
import { allotPassengers, fareFor, isBookable } from "../trains/availability.js";
import { moment, resolveJourney } from "../trains/search.service.js";
import { freeSeats, lockClassInventory, releaseExpiredHolds } from "./inventory.js";
import { pickSeats } from "./seat-picking.js";
import { renderTicketPdf, ticketContent } from "./ticket.js";
import type { CreateBookingInput } from "./bookings.schemas.js";

export const HOLD_MINUTES = 10;

// --------------------------------------------------------------------------- view

export const bookingInclude = {
    passengers: {
        orderBy: { position: "asc" },
        include: { allocation: { include: { seat: { include: { coach: { select: { code: true } } } } } } },
    },
    schedule: { select: { journeyDate: true, train: { select: { number: true, name: true, departureMinutes: true } } } },
    fromStop: { include: { station: { select: { code: true, name: true, city: true } } } },
    toStop: { include: { station: { select: { code: true, name: true, city: true } } } },
    refunds: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.BookingInclude;

type BookingWithDetails = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

export function toBookingView(booking: BookingWithDetails) {
    const { journeyDate, train } = booking.schedule;
    return {
        pnr: booking.pnr,
        status: booking.status,
        // Only meaningful while PENDING_PAYMENT: pay before this or the seats are released.
        holdExpiresAt: booking.status === "PENDING_PAYMENT" ? booking.holdExpiresAt : null,
        train: { number: train.number, name: train.name },
        journeyDate: toIsoDate(journeyDate),
        from: { station: booking.fromStop.station, departure: moment(journeyDate, train.departureMinutes, booking.fromStop.departureMinutes!) },
        to: { station: booking.toStop.station, arrival: moment(journeyDate, train.departureMinutes, booking.toStop.arrivalMinutes!) },
        class: booking.class,
        quota: booking.quota,
        totalFare: booking.totalFare,
        passengers: booking.passengers.map((p) => ({
            position: p.position,
            name: p.name,
            age: p.age,
            gender: p.gender,
            berthPreference: p.requestedBerth,
            status: p.status,
            racNumber: p.racNumber,
            waitlistNumber: p.waitlistNumber,
            berth: p.allocation
                ? { coach: p.allocation.seat.coach.code, number: p.allocation.seat.number, type: p.allocation.seat.berthType }
                : null,
        })),
        // Money coming back from cancellations (partial or full).
        refunds: booking.refunds.map((r) => ({ amount: r.amount, reason: r.reason, status: r.status, createdAt: r.createdAt })),
        createdAt: booking.createdAt,
    };
}

// --------------------------------------------------------------------------- create

// 10 random digits, first one non-zero. Unique index on Booking.pnr catches the (rare) collision.
function generatePnr(): string {
    return String(randomInt(1_000_000_000, 10_000_000_000));
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// Returns the booking, and whether it was created now (201) or by an earlier request with the
// same Idempotency-Key (200). A client that timed out and retries gets its booking back instead
// of a second one.
export async function createBooking(userId: string, input: CreateBookingInput, idempotencyKey: string) {
    // Keys are scoped per user, so two users can't collide on (or probe) each other's keys.
    const key = `${userId}:${idempotencyKey}`;
    const replay = await findByIdempotencyKey(key);
    if (replay) return { booking: replay, created: false };

    // ---- checks that need no lock
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedError();
    if (!user.isEmailVerified) throw new ForbiddenError("Verify your email address before booking", "EMAIL_NOT_VERIFIED");
    const contactPhone = input.contactPhone ?? user.phone;
    if (!contactPhone) throw new BadRequestError("CONTACT_PHONE_REQUIRED", "Send contactPhone: your account has no phone number");

    const schedule = await prisma.trainSchedule.findUnique({
        where: { id: input.scheduleId },
        include: {
            train: {
                select: {
                    id: true,
                    number: true,
                    departureMinutes: true,
                    routeStops: { orderBy: { sequence: "asc" }, include: { station: { select: { code: true, name: true, city: true } } } },
                },
            },
        },
    });
    if (!schedule) throw new NotFoundError("Schedule");
    const { train } = schedule;
    const { boarding, alighting, distanceKm } = resolveJourney(train.number, train.routeStops, input.from, input.to);

    const boardingDate = moment(schedule.journeyDate, train.departureMinutes, boarding.departureMinutes).date;
    if (!isBookable(schedule.status, new Date(`${boardingDate}T00:00:00Z`), todayUtc())) {
        throw new AppError(409, "BOOKING_CLOSED", "Booking is closed for this train on this date");
    }
    // Inventory rows are created with the schedule and never deleted, so this check is safe outside the lock.
    const hasQuota = await prisma.seatInventory.count({
        where: { scheduleId: schedule.id, class: input.class, quota: input.quota },
    });
    if (!hasQuota) {
        throw new BadRequestError("QUOTA_NOT_AVAILABLE", `Train ${train.number} has no ${input.quota} quota in ${input.class}`);
    }
    const fareRule = await prisma.fareRule.findUnique({ where: { class: input.class } });
    if (!fareRule) throw new AppError(409, "FARE_NOT_SET", `No fare is set for ${input.class} yet`);
    const totalFare = fareFor(fareRule, distanceKm, input.quota) * input.passengers.length;

    // ---- the locked part. Retried only on a PNR collision.
    for (let attempt = 1; ; attempt++) {
        try {
            const bookingId = await prisma.$transaction(
                async (tx) => {
                    const now = new Date();
                    await lockClassInventory(tx, schedule.id, input.class);

                    // Re-checked under the lock: chart preparation marks the schedule first and then
                    // locks each class to cancel its waitlist, so a booking that got here after the
                    // chart started must not add to a queue that has already been cleared.
                    const current = await tx.trainSchedule.findUniqueOrThrow({ where: { id: schedule.id }, select: { status: true } });
                    if (current.status !== "SCHEDULED") {
                        throw new AppError(409, "BOOKING_CLOSED", "Booking is closed for this train on this date");
                    }

                    // Expired holds in this class give their seats back first, so a hold that ran out a
                    // second ago doesn't block this booking until the background sweeper gets to it.
                    await releaseExpiredHolds(tx, schedule.id, input.class, now);

                    // Read the counters *after* locking (and after the release above). Under READ
                    // COMMITTED each statement sees everything committed before it ran, including the
                    // booking that held the lock just before us.
                    const inventory = await tx.seatInventory.findUniqueOrThrow({
                        where: { scheduleId_class_quota: { scheduleId: schedule.id, class: input.class, quota: input.quota } },
                    });
                    const allotted = allotPassengers(inventory, input.passengers.length);
                    if (!allotted) {
                        throw new AppError(409, "REGRET", "No berths, RAC or waitlist places left for this class and quota");
                    }

                    // Physical berths for the confirmed passengers only. RAC and waitlisted passengers get
                    // a number now and a berth later (Phase 9: cancellations and chart preparation).
                    const confirmedIndexes = allotted.allotments.flatMap((a, i) => (a.status === "CONFIRMED" ? [i] : []));
                    const seats = confirmedIndexes.length > 0
                        ? pickSeats(
                            await freeSeats(tx, schedule.id, train.id, input.class),
                            confirmedIndexes.map((i) => input.passengers[i].berthPreference),
                        )
                        : [];

                    // We hold the row lock, so writing the computed values can't overwrite anyone's update.
                    await tx.seatInventory.update({
                        where: { id: inventory.id },
                        data: {
                            availableSeats: allotted.counters.availableSeats,
                            racBooked: allotted.counters.racBooked,
                            waitlistBooked: allotted.counters.waitlistBooked,
                        },
                    });

                    const booking = await tx.booking.create({
                        data: {
                            pnr: generatePnr(),
                            userId,
                            scheduleId: schedule.id,
                            fromStopId: boarding.id,
                            toStopId: alighting.id,
                            class: input.class,
                            quota: input.quota,
                            totalFare,
                            holdExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000),
                            idempotencyKey: key,
                            contactEmail: user.email,
                            contactPhone,
                        },
                    });

                    // IDs made here (not by the database) so seat allocations can point at passengers
                    // without reading the passengers back.
                    const passengers = input.passengers.map((p, i) => {
                        const allotment = allotted.allotments[i];
                        return {
                            id: randomUUID(),
                            bookingId: booking.id,
                            position: i + 1,
                            name: p.name,
                            age: p.age,
                            gender: p.gender,
                            requestedBerth: p.berthPreference ?? null,
                            status: allotment.status,
                            racNumber: allotment.status === "RAC" ? allotment.racNumber : null,
                            waitlistNumber: allotment.status === "WAITLISTED" ? allotment.waitlistNumber : null,
                        };
                    });
                    await tx.passenger.createMany({ data: passengers });
                    // The unique (scheduleId, seatId) index is the last line of defence: even if the
                    // locking above had a bug, the database would refuse a second allocation of a seat.
                    await tx.seatAllocation.createMany({
                        data: seats.map((seat, k) => ({ scheduleId: schedule.id, seatId: seat.id, passengerId: passengers[confirmedIndexes[k]].id })),
                    });
                    return booking.id;
                },
                // READ COMMITTED is Postgres's default; stated because the code above depends on it.
                // maxWait: how long to queue for a pool connection during a rush before giving up.
                { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 },
            );
            const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: bookingInclude });
            return { booking: toBookingView(booking), created: true };
        } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            // Either a request with the same Idempotency-Key committed first (return its booking),
            // or the random PNR collided (retry). The failed transaction was rolled back either way,
            // so no seats or counters were taken.
            const winner = await findByIdempotencyKey(key);
            if (winner) return { booking: winner, created: false };
            if (attempt >= 3) throw err;
        }
    }
}

async function findByIdempotencyKey(key: string) {
    const booking = await prisma.booking.findUnique({ where: { idempotencyKey: key }, include: bookingInclude });
    return booking && toBookingView(booking);
}

// --------------------------------------------------------------------------- read

export async function listBookings(userId: string, pagination: Pagination) {
    const [bookings, total] = await prisma.$transaction([
        prisma.booking.findMany({ where: { userId }, include: bookingInclude, orderBy: { createdAt: "desc" }, ...toSkipTake(pagination) }),
        prisma.booking.count({ where: { userId } }),
    ]);
    return { items: bookings.map(toBookingView), page: pagination.page, pageSize: pagination.pageSize, total };
}

// Someone else's PNR gives the same 404 as a PNR that doesn't exist, so PNRs can't be probed.
export async function getBooking(userId: string, pnr: string) {
    const booking = await prisma.booking.findFirst({ where: { pnr, userId }, include: bookingInclude });
    if (!booking) throw new NotFoundError("Booking");
    return toBookingView(booking);
}

// --------------------------------------------------------------------------- ticket

// The PDF ticket for one of your bookings. Only a CONFIRMED (paid) booking has a ticket.
export async function getTicketPdf(userId: string, pnr: string) {
    const booking = await prisma.booking.findFirst({
        where: { pnr, userId },
        include: { ...bookingInclude, payments: { where: { status: "CAPTURED" }, select: { gatewayPaymentId: true } } },
    });
    if (!booking) throw new NotFoundError("Booking");
    return { filename: `ticket-${pnr}.pdf`, pdf: await ticketPdfFor(booking) };
}

// Shared with the confirmation email (notifications/outbox.ts).
export async function ticketPdfFor(booking: BookingWithDetails & { payments: { gatewayPaymentId: string | null }[] }) {
    if (booking.status !== "CONFIRMED") {
        const why = booking.status === "PENDING_PAYMENT" ? "it isn't paid yet" : `it is ${booking.status}`;
        throw new AppError(409, "TICKET_NOT_AVAILABLE", `No ticket for this booking: ${why}`);
    }
    return renderTicketPdf(ticketContent(toBookingView(booking), booking.payments[0]?.gatewayPaymentId ?? null));
}
