// Pure rules for availability and fares. Search uses them to show "AVL 42" / "RAC 3" / "WL 24", and
// booking uses the same allotPassengers() to decide what each passenger actually gets, so the two
// can't disagree. No database access, so they're cheap to unit-test.

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
    waitlistBooked: number;
}

// What the next passenger would get from this inventory, in the order seats are handed out:
// a confirmed berth first, then RAC (half a berth), then a waitlist number, then nothing (null).
export type Allotment =
    | { status: "CONFIRMED" }
    | { status: "RAC"; racNumber: number }
    | { status: "WAITLISTED"; waitlistNumber: number };

function nextAllotment(inventory: InventoryCounters): Allotment | null {
    if (inventory.availableSeats > 0) return { status: "CONFIRMED" };
    if (inventory.racBooked < inventory.racCapacity) return { status: "RAC", racNumber: inventory.racBooked + 1 };
    if (inventory.waitlistBooked < WAITLIST_LIMIT) return { status: "WAITLISTED", waitlistNumber: inventory.waitlistBooked + 1 };
    return null;
}

// Allots `count` passengers one by one, so one party can be split (e.g. 2 CONFIRMED + 1 RAC 1).
// Returns the allotments and the counters to write back, or null if even the waitlist can't take
// everyone: then the whole booking is refused rather than leaving part of the party behind.
// Booking calls this on counters it has locked (see bookings.service.ts); it never touches the DB.
export function allotPassengers(inventory: InventoryCounters, count: number) {
    const counters = { ...inventory };
    const allotments: Allotment[] = [];
    for (let i = 0; i < count; i++) {
        const next = nextAllotment(counters);
        if (!next) return null;
        allotments.push(next);
        if (next.status === "CONFIRMED") counters.availableSeats -= 1;
        else if (next.status === "RAC") counters.racBooked += 1;
        else counters.waitlistBooked += 1;
    }
    return { allotments, counters };
}

// The same rule, phrased for search results. Built on nextAllotment, so what search shows is what
// booking would do.
export function availabilityOf(inventory: InventoryCounters, bookable: boolean): Availability {
    if (!bookable) return { status: "BOOKING_CLOSED", count: null, label: "BOOKING CLOSED" };
    const next = nextAllotment(inventory);
    switch (next?.status) {
        case "CONFIRMED":
            return { status: "AVAILABLE", count: inventory.availableSeats, label: `AVL ${inventory.availableSeats}` };
        case "RAC":
            return { status: "RAC", count: next.racNumber, label: `RAC ${next.racNumber}` };
        case "WAITLISTED":
            return { status: "WAITLIST", count: next.waitlistNumber, label: `WL ${next.waitlistNumber}` };
        default:
            return { status: "REGRET", count: null, label: "REGRET" };
    }
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
