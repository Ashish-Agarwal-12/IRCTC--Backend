// Turns a train's timetable into bookable services: one TrainSchedule per date it runs, each with
// SeatInventory counters per class and quota. Inventory is the table Phase 4 locks when booking.

import type { CoachClass, Quota } from "../../generated/prisma/client.js";
import { prisma } from "../../shared/prisma.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/error.js";
import { DAY_MS, todayUtc } from "../../shared/validation.js";
import { CLASSES_WITH_RAC } from "./seat-layout.js";

// Date.getUTCDay() numbers days from Sunday = 0. Map those numbers to our Weekday enum values.
const WEEKDAY_BY_INDEX = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

// Share of each class's berths set aside per quota (simplified from Indian Railways' real rules,
// which vary by train and class). GENERAL gets whatever is left after rounding down.
const QUOTA_SHARE: Record<Exclude<Quota, "GENERAL">, number> = {
    TATKAL: 0.25,
    LADIES: 0.04,
    SENIOR_CITIZEN: 0.06,
};
// Share of GENERAL berths (side-lowers in reality) held back for RAC. Each such berth seats two
// RAC passengers, so RAC capacity = 2 × held-back berths.
const RAC_BERTH_SHARE = 0.05;

export interface QuotaAllocation {
    quota: Quota;
    totalSeats: number;
    availableSeats: number;
    racCapacity: number;
}

// Splits `berths` berths of one class into per-quota counters. Exported so tests can check the
// maths directly: the totals must always add back up to `berths`.
export function splitQuotas(coachClass: CoachClass, berths: number): QuotaAllocation[] {
    const tatkal = Math.floor(berths * QUOTA_SHARE.TATKAL);
    const ladies = Math.floor(berths * QUOTA_SHARE.LADIES);
    const senior = Math.floor(berths * QUOTA_SHARE.SENIOR_CITIZEN);
    const general = berths - tatkal - ladies - senior;
    const racBerths = CLASSES_WITH_RAC.has(coachClass) ? Math.floor(general * RAC_BERTH_SHARE) : 0;

    const allocations: QuotaAllocation[] = [
        { quota: "GENERAL", totalSeats: general, availableSeats: general - racBerths, racCapacity: racBerths * 2 },
        { quota: "TATKAL", totalSeats: tatkal, availableSeats: tatkal, racCapacity: 0 },
        { quota: "LADIES", totalSeats: ladies, availableSeats: ladies, racCapacity: 0 },
        { quota: "SENIOR_CITIZEN", totalSeats: senior, availableSeats: senior, racCapacity: 0 },
    ];
    return allocations.filter((a) => a.totalSeats > 0);
}

// Creates schedules for every running day in [from, to]. Safe to call repeatedly or for overlapping
// ranges: dates that already have a schedule are skipped, not duplicated.
export async function generateSchedules(trainId: string, from: Date, to: Date) {
    if (from < todayUtc()) {
        throw new BadRequestError("INVALID_DATE_RANGE", "Schedules can't start in the past");
    }

    const train = await prisma.train.findUnique({
        where: { id: trainId },
        include: {
            coaches: { select: { class: true, _count: { select: { seats: true } } } },
            _count: { select: { routeStops: true } },
        },
    });
    if (!train) throw new NotFoundError("Train");
    if (train._count.routeStops < 2) throw new ConflictError("Set the train's route before generating schedules");
    if (train.coaches.length === 0) throw new ConflictError("Add coaches before generating schedules");

    // Total berths per class across all coaches, e.g. AC3 → 8 coaches × 72 = 576.
    const berthsByClass = new Map<CoachClass, number>();
    for (const coach of train.coaches) {
        berthsByClass.set(coach.class, (berthsByClass.get(coach.class) ?? 0) + coach._count.seats);
    }

    const dates: Date[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
        const date = new Date(t);
        if (train.runningDays.includes(WEEKDAY_BY_INDEX[date.getUTCDay()])) dates.push(date);
    }
    if (dates.length === 0) return { runningDates: 0, created: 0, skipped: 0 };

    return prisma.$transaction(async (tx) => {
        // skipDuplicates relies on the unique (trainId, journeyDate) index: existing dates are ignored
        // in the database itself, so two admins clicking "generate" at once can't create duplicates.
        const { count: created } = await tx.trainSchedule.createMany({
            data: dates.map((journeyDate) => ({ trainId, journeyDate })),
            skipDuplicates: true,
        });

        // Give inventory to any schedule in range that doesn't have it yet.
        const needInventory = await tx.trainSchedule.findMany({
            where: { trainId, journeyDate: { in: dates }, inventories: { none: {} } },
            select: { id: true },
        });
        const rows = needInventory.flatMap((schedule) =>
            [...berthsByClass].flatMap(([coachClass, berths]) =>
                splitQuotas(coachClass, berths).map((allocation) => ({
                    scheduleId: schedule.id,
                    class: coachClass,
                    ...allocation, // spread: copies quota, totalSeats, availableSeats, racCapacity
                })),
            ),
        );
        await tx.seatInventory.createMany({ data: rows, skipDuplicates: true });

        return { runningDates: dates.length, created, skipped: dates.length - created };
    });
}
