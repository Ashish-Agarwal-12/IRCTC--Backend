import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { simulateSeparateInstances } from "../src/shared/keyed-queue.js";
import { prisma } from "../src/shared/prisma.js";
import { WAITLIST_LIMIT, allotPassengers } from "../src/modules/trains/availability.js";
import { pickSeats, type FreeSeat } from "../src/modules/bookings/seat-picking.js";
import { expireHolds } from "../src/modules/bookings/hold-expiry.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";
import { createScheduledTrain, isoDate, search } from "./fixtures.js";

let token: string;
let scheduleId: string;

const passenger = (name: string, extra: object = {}) => ({ name, age: 35, gender: "FEMALE", ...extra });

const bookingBody = (overrides: object = {}) => ({
    scheduleId, from: "NDLS", to: "MMCT", class: "AC3",
    passengers: [passenger("Asha Kumar")], contactPhone: "9876543210",
    ...overrides,
});

const book = (body: object, key: string = randomUUID(), as: string = token) =>
    api().post("/bookings").set(bearer(as)).set("Idempotency-Key", key).send(body);

const ac3General = () => ({ scheduleId_class_quota: { scheduleId, class: "AC3" as const, quota: "GENERAL" as const } });
const setInventory = (data: object) => prisma.seatInventory.update({ where: ac3General(), data });
const inventory = () => prisma.seatInventory.findUniqueOrThrow({ where: ac3General() });

beforeEach(async () => {
    await resetDb();
    await createScheduledTrain();
    token = (await createUser()).token;
    scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
});

// --------------------------------------------------------------------------- pure rules

describe("allotment and seat-picking rules", () => {
    it("allots berths, then RAC, then waitlist, and refuses a party that doesn't fit", () => {
        const result = allotPassengers({ availableSeats: 1, racCapacity: 2, racBooked: 1, waitlistBooked: 4 }, 3);
        expect(result?.allotments).toEqual([
            { status: "CONFIRMED" }, { status: "RAC", racNumber: 2 }, { status: "WAITLISTED", waitlistNumber: 5 },
        ]);
        expect(result?.counters).toEqual({ availableSeats: 0, racCapacity: 2, racBooked: 2, waitlistBooked: 5 });

        expect(allotPassengers({ availableSeats: 0, racCapacity: 0, racBooked: 0, waitlistBooked: WAITLIST_LIMIT - 1 }, 2)).toBeNull();
    });

    it("honours berth preferences and keeps the party in one coach", () => {
        const seat = (coachCode: string, number: number, berthType: FreeSeat["berthType"]): FreeSeat =>
            ({ id: `${coachCode}-${number}`, coachCode, number, berthType });
        const free = [seat("B10", 1, "LOWER"), seat("B2", 2, "MIDDLE"), seat("B2", 3, "UPPER"), seat("B3", 1, "LOWER")];

        // Sorted B2-2, B2-3, B3-1, B10-1 ("B2" before "B10": numeric order). The LOWER preference takes
        // B3-1; the others fill B2 together, rather than one of them landing in B10.
        expect(pickSeats(free, [undefined, "LOWER", undefined]).map((s) => s.id)).toEqual(["B2-2", "B3-1", "B2-3"]);
        expect(() => pickSeats(free.slice(0, 1), [undefined, undefined])).toThrow();
    });
});

// --------------------------------------------------------------------------- happy path

describe("POST /bookings", () => {
    it("holds confirmed berths for 10 minutes and updates availability", async () => {
        const res = await book(bookingBody({
            passengers: [passenger("Asha Kumar", { berthPreference: "UPPER" }), passenger("Ravi Kumar", { gender: "MALE" })],
        })).expect(201);

        const { booking } = res.body;
        expect(booking).toMatchObject({
            status: "PENDING_PAYMENT",
            train: { number: "12952" },
            from: { station: { code: "NDLS" }, departure: { date: isoDate(3), time: "16:55" } },
            class: "AC3",
            quota: "GENERAL",
            totalFare: 2 * 170_400,
        });
        expect(booking.pnr).toMatch(/^\d{10}$/);
        const holdMinutes = (Date.parse(booking.holdExpiresAt) - Date.now()) / 60_000;
        expect(holdMinutes).toBeGreaterThan(9.5);
        expect(holdMinutes).toBeLessThanOrEqual(10);

        expect(booking.passengers).toMatchObject([
            { position: 1, name: "Asha Kumar", status: "CONFIRMED", berth: { coach: "B1", type: "UPPER" } },
            { position: 2, name: "Ravi Kumar", status: "CONFIRMED", berth: { coach: "B1" } },
        ]);

        expect((await inventory()).availableSeats).toBe(91 - 2);
        const avl = await api().get(`/trains/${scheduleId}/availability`).expect(200);
        expect(avl.body.classes[1].quotas[0].availability.label).toBe("AVL 89");

        // PNR status and the list of my bookings.
        const byPnr = await api().get(`/bookings/${booking.pnr}`).set(bearer(token)).expect(200);
        expect(byPnr.body.booking).toEqual(booking);
        const mine = await api().get("/bookings").set(bearer(token)).expect(200);
        expect(mine.body).toMatchObject({ total: 1, items: [{ pnr: booking.pnr }] });
    });

    it("splits a party across berths, RAC and waitlist, giving a berth only to the confirmed", async () => {
        await setInventory({ availableSeats: 1, racBooked: 7 }); // racCapacity is 8
        const res = await book(bookingBody({ passengers: [passenger("Asha"), passenger("Meera"), passenger("Lata")] })).expect(201);
        expect(res.body.booking.passengers).toMatchObject([
            { status: "CONFIRMED", racNumber: null, waitlistNumber: null },
            { status: "RAC", racNumber: 8, berth: null },
            { status: "WAITLISTED", waitlistNumber: 1, berth: null },
        ]);
        expect(res.body.booking.passengers[0].berth).not.toBeNull();
        expect(await inventory()).toMatchObject({ availableSeats: 0, racBooked: 8, waitlistBooked: 1 });
    });

    it("refuses with REGRET when even the waitlist is full, and changes nothing", async () => {
        await setInventory({ availableSeats: 0, racBooked: 8, waitlistBooked: WAITLIST_LIMIT });
        const res = await book(bookingBody()).expect(409);
        expect(res.body.error.code).toBe("REGRET");
        expect(await prisma.booking.count()).toBe(0);
        expect((await inventory()).waitlistBooked).toBe(WAITLIST_LIMIT);
    });
});

// --------------------------------------------------------------------------- idempotency

describe("Idempotency-Key", () => {
    it("returns the original booking on a retry instead of booking twice", async () => {
        const key = randomUUID();
        const first = await book(bookingBody(), key).expect(201);
        const retry = await book(bookingBody(), key).expect(200);
        expect(retry.body.booking.pnr).toBe(first.body.booking.pnr);
        expect((await inventory()).availableSeats).toBe(90);
    });

    it("creates one booking when the same key arrives several times at once", async () => {
        const key = randomUUID();
        const results = await Promise.all(Array.from({ length: 5 }, () => book(bookingBody(), key)));
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
        expect(new Set(results.map((r) => r.body.booking.pnr)).size).toBe(1);
        expect(await prisma.booking.count()).toBe(1);
        expect((await inventory()).availableSeats).toBe(90);
    });

    it("scopes keys per user", async () => {
        const other = await createUser();
        const key = randomUUID();
        const mine = await book(bookingBody(), key).expect(201);
        const theirs = await book(bookingBody(), key, other.token).expect(201);
        expect(theirs.body.booking.pnr).not.toBe(mine.body.booking.pnr);
    });
});

// --------------------------------------------------------------------------- concurrency

describe("concurrent bookings", () => {
    // As if each request hit a different server instance: the in-memory per-class line
    // (keyed-queue.ts) can't serialise them, so only the database lock stands between them.
    beforeAll(() => simulateSeparateInstances(true));
    afterAll(() => simulateSeparateInstances(false));
    it("gives the last berth to exactly one of 30 simultaneous requests; the rest are waitlisted in order", async () => {
        await setInventory({ availableSeats: 1, racCapacity: 0, racBooked: 0 });

        const results = await Promise.all(Array.from({ length: 30 }, () => book(bookingBody())));
        expect(results.every((r) => r.status === 201)).toBe(true);

        const passengers = results.map((r) => r.body.booking.passengers[0]);
        expect(passengers.filter((p) => p.status === "CONFIRMED")).toHaveLength(1);
        // Waitlist numbers 1..29, each issued once: no two requests read the same counter.
        const wl = passengers.filter((p) => p.status === "WAITLISTED").map((p) => p.waitlistNumber).sort((a, b) => a - b);
        expect(wl).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));

        expect(await prisma.seatAllocation.count()).toBe(1);
        expect(await inventory()).toMatchObject({ availableSeats: 0, waitlistBooked: 29 });
    });

    it("never gives the same seat to two quotas booking the same class at once", async () => {
        // GENERAL and TATKAL have separate counters but share the physical AC3 seats.
        const party = ["Asha", "Meera", "Lata", "Uma"].map((name) => passenger(name));
        const requests = Array.from({ length: 8 }, (_, i) => book(bookingBody({ quota: i % 2 ? "TATKAL" : "GENERAL", passengers: party })));
        const results = await Promise.all(requests);
        expect(results.every((r) => r.status === 201)).toBe(true);

        const allocations = await prisma.seatAllocation.findMany({ select: { seatId: true } });
        expect(allocations).toHaveLength(32);
        expect(new Set(allocations.map((a) => a.seatId)).size).toBe(32);
    });
});

// --------------------------------------------------------------------------- holds

describe("hold expiry", () => {
    const expireAllHolds = () =>
        prisma.booking.updateMany({ where: { status: "PENDING_PAYMENT" }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });

    it("releases the seats of an unpaid hold once its time is up, exactly once", async () => {
        const res = await book(bookingBody({ passengers: [passenger("Asha"), passenger("Meera")] })).expect(201);
        expect(await expireHolds()).toBe(0); // not due yet

        await expireAllHolds();
        expect(await expireHolds()).toBe(1);
        expect(await expireHolds()).toBe(0);

        const after = await api().get(`/bookings/${res.body.booking.pnr}`).set(bearer(token)).expect(200);
        expect(after.body.booking).toMatchObject({ status: "EXPIRED", holdExpiresAt: null });
        expect(after.body.booking.passengers.every((p: { status: string; berth: unknown }) => p.status === "CANCELLED" && p.berth === null)).toBe(true);
        expect((await inventory()).availableSeats).toBe(91);
        expect(await prisma.seatAllocation.count()).toBe(0);
    });

    it("frees an expired hold's seats for the next booking straight away, without waiting for the sweeper", async () => {
        await setInventory({ availableSeats: 2 });
        const first = await book(bookingBody({ passengers: [passenger("Asha"), passenger("Meera")] })).expect(201);
        await expireAllHolds();

        const second = await book(bookingBody({ passengers: [passenger("Lata"), passenger("Uma")] })).expect(201);
        expect(second.body.booking.passengers.map((p: { status: string }) => p.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
        const old = await api().get(`/bookings/${first.body.booking.pnr}`).set(bearer(token)).expect(200);
        expect(old.body.booking.status).toBe("EXPIRED");
    });
});

// --------------------------------------------------------------------------- rules and guards

describe("booking rules", () => {
    it("requires a logged-in, verified user and an Idempotency-Key", async () => {
        await api().post("/bookings").send(bookingBody()).expect(401);
        await api().get("/bookings").expect(401);

        const unverified = await createUser({ verified: false });
        const res = await book(bookingBody(), randomUUID(), unverified.token).expect(403);
        expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");

        await api().post("/bookings").set(bearer(token)).send(bookingBody()).expect(400);
    });

    it("validates passengers and quota eligibility", async () => {
        const seven = Array.from({ length: 7 }, (_, i) => passenger(`Passenger ${i + 1}`));
        await book(bookingBody({ passengers: seven })).expect(400);
        await book(bookingBody({ passengers: [] })).expect(400);

        const ladies = await book(bookingBody({ quota: "LADIES", passengers: [passenger("Ravi", { gender: "MALE" })] })).expect(400);
        expect(ladies.body.error.details[0].path).toEqual(["passengers", 0, "gender"]);
        await book(bookingBody({ quota: "LADIES" })).expect(201);

        await book(bookingBody({ quota: "SENIOR_CITIZEN", passengers: [passenger("Ravi", { gender: "MALE", age: 59 })] })).expect(400);
        await book(bookingBody({ quota: "SENIOR_CITIZEN", passengers: [passenger("Asha", { age: 58 })] })).expect(201);

        const five = Array.from({ length: 5 }, (_, i) => passenger(`Passenger ${i + 1}`));
        await book(bookingBody({ quota: "TATKAL", passengers: five })).expect(400);
    });

    it("rejects journeys and schedules that can't be booked", async () => {
        await book(bookingBody({ scheduleId: "00000000-0000-4000-8000-000000000000" })).expect(404);
        expect((await book(bookingBody({ from: "BCT" })).expect(400)).body.error.code).toBe("STATION_NOT_ON_ROUTE");
        expect((await book(bookingBody({ from: "MMCT", to: "NDLS" })).expect(400)).body.error.code).toBe("INVALID_JOURNEY");
        expect((await book(bookingBody({ class: "SL" })).expect(400)).body.error.code).toBe("QUOTA_NOT_AVAILABLE");

        const noPhone = { ...bookingBody() } as Record<string, unknown>;
        delete noPhone.contactPhone;
        expect((await book(noPhone).expect(400)).body.error.code).toBe("CONTACT_PHONE_REQUIRED");

        await prisma.trainSchedule.update({ where: { id: scheduleId }, data: { status: "CHART_PREPARED" } });
        expect((await book(bookingBody()).expect(409)).body.error.code).toBe("BOOKING_CLOSED");
    });

    it("only shows you your own bookings", async () => {
        const { body } = await book(bookingBody()).expect(201);
        const other = await createUser();
        await api().get(`/bookings/${body.booking.pnr}`).set(bearer(other.token)).expect(404);
        expect((await api().get("/bookings").set(bearer(other.token)).expect(200)).body.total).toBe(0);
        await api().get("/bookings/12345").set(bearer(token)).expect(400);
    });
});
