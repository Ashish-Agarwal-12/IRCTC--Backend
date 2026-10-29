// Pure rules for what a passenger sees before booking: the availability status of a class/quota
// and its fare. No database access, so they're cheap to unit-test, and Phase 4 (booking) reuses
// the same rules when it decides whether a passenger gets a berth, RAC or a waitlist number.

import type { CoachClass, FareRule, Quota, ScheduleStatus } from "../../generated/prisma/client.js";

// Display order of classes, most expensive first (like the IRCTC results page).
export const CLASS_ORDER: CoachClass[] = ["AC1", "AC2", "AC3", "CC", "SL"];

// Once this many waitlist numbers are issued for a class/quota, booking is refused ("REGRET").
// Simplification: real limits vary per train and class.
export const WAITLIST_LIMIT = 100;

// `as const` makes this a tuple of literal strings, so z.enum() and the type below both use it.
export const AVAILABILITY_STATUSES = ["AVAILABLE", "RAC", "WAITLIST", "REGRET", "BOOKING_CLOSED"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export interface Availability {
    status: AvailabilityStatus;
    // AVAILABLE: berths left. RAC / WAITLIST: the number the next passenger would get. Otherwise null.
    count: number | null;
    label: string; // "AVL 42", "RAC 3", "WL 24", ...
}

// The counters of one SeatInventory row that matter here.
export interface InventoryCounters {
    availableSeats: number;
    racCapacity: number;
    racBooked: number;
    waitlistIssued: number;
}

// The order matters, and it's the order booking will fill things in: confirmed berths first, then
// RAC (half a berth), then the waitlist, then nothing.
export function availabilityOf(inventory: InventoryCounters, bookable: boolean): Availability {
    if (!bookable) return { status: "BOOKING_CLOSED", count: null, label: "BOOKING CLOSED" };
    if (inventory.availableSeats > 0) {
        return { status: "AVAILABLE", count: inventory.availableSeats, label: `AVL ${inventory.availableSeats}` };
    }
    if (inventory.racBooked < inventory.racCapacity) {
        const next = inventory.racBooked + 1;
        return { status: "RAC", count: next, label: `RAC ${next}` };
    }
    if (inventory.waitlistIssued < WAITLIST_LIMIT) {
        const next = inventory.waitlistIssued + 1;
        return { status: "WAITLIST", count: next, label: `WL ${next}` };
    }
    return { status: "REGRET", count: null, label: "REGRET" };
}

// A schedule can be booked until its chart is prepared (Phase 9), and never for a past date.
// `boardingDate` is the date the passenger gets on, which can be after the schedule's journeyDate.
export function isBookable(status: ScheduleStatus, boardingDate: Date, today: Date): boolean {
    return status === "SCHEDULED" && boardingDate >= today;
}

// Simplified Tatkal surcharge: a percentage on top of the normal fare. (Real Tatkal charges are a
// percentage with a minimum and maximum per class.)
const TATKAL_SURCHARGE_PERCENT = 30;

// Fare for one passenger, in paise. Only integer maths: `base * 30 / 100` on integers is exact
// enough for Math.ceil, whereas `base * 1.3` can come out as 13000.000000000002 and round up wrongly.
// The total is rounded up to a whole rupee (100 paise), as railway fares are quoted in rupees.
export function fareFor(rule: Pick<FareRule, "baseFare" | "perKm">, distanceKm: number, quota: Quota): number {
    const normal = rule.baseFare + rule.perKm * distanceKm;
    const total = quota === "TATKAL" ? normal + Math.ceil((normal * TATKAL_SURCHARGE_PERCENT) / 100) : normal;
    return Math.ceil(total / 100) * 100;
}
