// Standard coach layouts. An admin only says "B1 is a 3A coach"; the seats are generated from here.
//
// Sleeper-style coaches are divided into "bays". In SL/3A a bay has 8 berths: two facing sets of
// Lower/Middle/Upper on one side of the aisle, plus a Side-Lower and Side-Upper on the other.
// Seat 1 = Lower, 2 = Middle, 3 = Upper, 4 = Lower, ... 7 = Side-Lower, 8 = Side-Upper, then repeat.

import type { BerthType, CoachClass } from "../../generated/prisma/client.js";

interface Layout {
    seats: number;
    pattern: BerthType[]; // berth types of one bay (or one row, for chair cars), repeated
}

// `Record<CoachClass, Layout>` makes TypeScript insist that every class has a layout: if someone
// adds a new class to the Prisma enum, this file stops compiling until they add its layout.
const LAYOUTS: Record<CoachClass, Layout> = {
    SL: { seats: 72, pattern: ["LOWER", "MIDDLE", "UPPER", "LOWER", "MIDDLE", "UPPER", "SIDE_LOWER", "SIDE_UPPER"] },
    AC3: { seats: 72, pattern: ["LOWER", "MIDDLE", "UPPER", "LOWER", "MIDDLE", "UPPER", "SIDE_LOWER", "SIDE_UPPER"] },
    // 2A has no middle berths: bays of 6.
    AC2: { seats: 48, pattern: ["LOWER", "UPPER", "LOWER", "UPPER", "SIDE_LOWER", "SIDE_UPPER"] },
    // 1A: cabins and coupés of lower/upper berths.
    AC1: { seats: 24, pattern: ["LOWER", "UPPER"] },
    // Chair car: rows of 3 + 2 seats (window, middle, aisle | aisle, window).
    CC: { seats: 78, pattern: ["WINDOW", "MIDDLE", "AISLE", "AISLE", "WINDOW"] },
};

// Classes with side-lower berths, which can be shared by two RAC passengers.
export const CLASSES_WITH_RAC: ReadonlySet<CoachClass> = new Set<CoachClass>(["SL", "AC3", "AC2"]);

export function seatsPerCoach(coachClass: CoachClass): number {
    return LAYOUTS[coachClass].seats;
}

// [{ number: 1, berthType: "LOWER" }, { number: 2, berthType: "MIDDLE" }, ...]
export function generateSeats(coachClass: CoachClass): { number: number; berthType: BerthType }[] {
    const { seats, pattern } = LAYOUTS[coachClass];
    // Array.from({ length: n }, fn) builds an n-element array by calling fn(_, index) for each slot.
    return Array.from({ length: seats }, (_, i) => ({
        number: i + 1,
        berthType: pattern[i % pattern.length], // % wraps the index back to the start of the pattern
    }));
}
