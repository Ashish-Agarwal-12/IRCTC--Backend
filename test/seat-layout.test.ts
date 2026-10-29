// Unit tests: plain functions, no database or HTTP. These run in milliseconds.

import { describe, expect, it } from "vitest";
import { generateSeats } from "../src/modules/trains/seat-layout.js";
import { splitQuotas } from "../src/modules/trains/schedules.service.js";
import type { CoachClass } from "../src/generated/prisma/client.js";

describe("generateSeats", () => {
    it("builds a 72-berth 3A coach in bays of 8", () => {
        const seats = generateSeats("AC3");
        expect(seats).toHaveLength(72);
        expect(seats.slice(0, 8).map((s) => s.berthType)).toEqual(
            ["LOWER", "MIDDLE", "UPPER", "LOWER", "MIDDLE", "UPPER", "SIDE_LOWER", "SIDE_UPPER"],
        );
        expect(seats[8]).toEqual({ number: 9, berthType: "LOWER" }); // second bay starts again
        expect(seats.filter((s) => s.berthType === "SIDE_LOWER")).toHaveLength(9);
    });

    it("gives 2A no middle berths", () => {
        const seats = generateSeats("AC2");
        expect(seats).toHaveLength(48);
        expect(seats.some((s) => s.berthType === "MIDDLE")).toBe(false);
    });

    it("numbers seats 1..n with no gaps", () => {
        const seats = generateSeats("CC");
        expect(seats.map((s) => s.number)).toEqual(Array.from({ length: 78 }, (_, i) => i + 1));
    });
});

describe("splitQuotas", () => {
    // it.each runs the same test once per row of input.
    it.each([
        ["AC3", 576], ["AC2", 192], ["SL", 432], ["CC", 312], ["AC1", 24], ["SL", 72], ["AC1", 1],
    ] as [CoachClass, number][])("never loses or invents berths (%s, %i)", (coachClass, berths) => {
        const quotas = splitQuotas(coachClass, berths);
        const total = quotas.reduce((sum, q) => sum + q.totalSeats, 0);
        expect(total).toBe(berths);
        for (const q of quotas) {
            expect(q.availableSeats).toBeLessThanOrEqual(q.totalSeats);
            expect(q.availableSeats).toBeGreaterThanOrEqual(0);
        }
    });

    it("holds back GENERAL berths for RAC only in classes with side berths", () => {
        const sl = splitQuotas("SL", 432).find((q) => q.quota === "GENERAL")!;
        expect(sl.racCapacity).toBeGreaterThan(0);
        expect(sl.racCapacity).toBe((sl.totalSeats - sl.availableSeats) * 2); // 2 people per RAC berth

        const cc = splitQuotas("CC", 312).find((q) => q.quota === "GENERAL")!;
        expect(cc.racCapacity).toBe(0);
        expect(cc.availableSeats).toBe(cc.totalSeats);
    });
});
