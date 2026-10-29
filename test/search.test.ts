import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/shared/prisma.js";
import { WAITLIST_LIMIT, availabilityOf, fareFor } from "../src/modules/trains/availability.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";

// Dates relative to today (UTC), so the tests never go stale.
function isoDate(daysFromToday: number): string {
    return new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const weekdayOf = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

// 16:55 departure. KOTA at 21:30 on day 1; RTM departs at 01:33, which is day 2 of the run.
const route = {
    stops: [
        { stationCode: "NDLS", arrivalMinutes: null, departureMinutes: 0, distanceKm: 0 },
        { stationCode: "KOTA", arrivalMinutes: 270, departureMinutes: 275, distanceKm: 465 },
        { stationCode: "RTM", arrivalMinutes: 515, departureMinutes: 518, distanceKm: 733 },
        { stationCode: "MMCT", arrivalMinutes: 955, departureMinutes: null, distanceKm: 1386 },
    ],
};

let adminToken: string;
const admin = (method: "post" | "put", url: string, body: object) =>
    api()[method](`/admin${url}`).set(bearer(adminToken)).send(body);

// One train with 1 AC2 + 2 AC3 coaches, scheduled for the next two weeks on `runningDays`.
async function createScheduledTrain(runningDays = WEEKDAYS) {
    for (const [code, name, city] of [["NDLS", "New Delhi", "Delhi"], ["KOTA", "Kota Junction", "Kota"],
        ["RTM", "Ratlam Junction", "Ratlam"], ["MMCT", "Mumbai Central", "Mumbai"]]) {
        await admin("post", "/stations", { code, name, city }).expect(201);
    }
    const created = await admin("post", "/trains", {
        number: "12952", name: "Mumbai Rajdhani", runningDays, departureTime: "16:55",
    }).expect(201);
    const id: string = created.body.train.id;
    await admin("put", `/trains/${id}/route`, route).expect(200);
    await admin("put", `/trains/${id}/coaches`, {
        coaches: [{ code: "A1", class: "AC2" }, { code: "B1", class: "AC3" }, { code: "B2", class: "AC3" }],
    }).expect(200);
    await admin("post", `/trains/${id}/schedules`, { from: isoDate(0), to: isoDate(14) }).expect(201);
    return id;
}

const search = (from: string, to: string, date: string, extra = "") =>
    api().get(`/trains/search?from=${from}&to=${to}&date=${date}${extra}`);

beforeEach(async () => {
    await resetDb();
    adminToken = (await createUser({ role: "ADMIN" })).token;
    await prisma.fareRule.createMany({
        data: [
            { class: "AC3", baseFare: 4_000, perKm: 120 },
            { class: "AC2", baseFare: 5_000, perKm: 175 },
        ],
    });
});

describe("availability rules", () => {
    const counters = { availableSeats: 0, racCapacity: 8, racBooked: 0, waitlistIssued: 0 };

    it("fills berths, then RAC, then the waitlist, then refuses", () => {
        expect(availabilityOf({ ...counters, availableSeats: 42 }, true)).toEqual({ status: "AVAILABLE", count: 42, label: "AVL 42" });
        expect(availabilityOf({ ...counters, racBooked: 2 }, true)).toEqual({ status: "RAC", count: 3, label: "RAC 3" });
        expect(availabilityOf({ ...counters, racBooked: 8, waitlistIssued: 23 }, true)).toMatchObject({ status: "WAITLIST", label: "WL 24" });
        expect(availabilityOf({ ...counters, racBooked: 8, waitlistIssued: WAITLIST_LIMIT }, true).status).toBe("REGRET");
        expect(availabilityOf({ ...counters, availableSeats: 42 }, false).status).toBe("BOOKING_CLOSED");
    });

    it("calculates fares in whole rupees, with the Tatkal surcharge", () => {
        const rule = { baseFare: 4_000, perKm: 120 };
        expect(fareFor(rule, 921, "GENERAL")).toBe(114_600); // 114,520 paise rounded up to ₹1,146
        expect(fareFor(rule, 921, "TATKAL")).toBe(148_900); // 114,520 + 30% = 148,876 → ₹1,489
        expect(fareFor({ baseFare: 10_000, perKm: 0 }, 0, "TATKAL")).toBe(13_000); // exact, no float drift
    });
});

describe("GET /trains/search", () => {
    it("finds a train between intermediate stops, with times, distance, fares and availability", async () => {
        await createScheduledTrain();
        const date = isoDate(3);
        const res = await search("kota", "MMCT", date).expect(200);

        expect(res.body).toMatchObject({ from: { code: "KOTA" }, to: { code: "MMCT" }, date, quota: "GENERAL" });
        expect(res.body.trains).toHaveLength(1);
        const [train] = res.body.trains;
        expect(train).toMatchObject({
            number: "12952",
            departure: { date, time: "21:30" },
            arrival: { date: isoDate(4), time: "08:50" },
            durationMinutes: 955 - 275,
            distanceKm: 1386 - 465,
            bookable: true,
        });
        // Most expensive class first. 2 AC3 coaches = 144 berths → 95 GENERAL, 4 berths held for RAC.
        expect(train.classes).toEqual([
            { class: "AC2", fare: 166_200, availability: { status: "AVAILABLE", count: 32, label: "AVL 32" } },
            { class: "AC3", fare: 114_600, availability: { status: "AVAILABLE", count: 91, label: "AVL 91" } },
        ]);
    });

    it("finds nothing in the opposite direction", async () => {
        await createScheduledTrain();
        const res = await search("MMCT", "NDLS", isoDate(3)).expect(200);
        expect(res.body.trains).toEqual([]);
    });

    it("treats `date` as the boarding date, even when that's a day after the train left its origin", async () => {
        const runsOn = isoDate(7);
        await createScheduledTrain([weekdayOf(runsOn)]); // runs one day a week

        // Leaves NDLS on `runsOn`, reaches RTM at 01:33 the next day.
        const nextDay = await search("RTM", "MMCT", isoDate(8)).expect(200);
        expect(nextDay.body.trains).toHaveLength(1);
        expect(nextDay.body.trains[0].departure).toEqual({ date: isoDate(8), time: "01:33" });

        // On `runsOn` itself nothing boards at RTM: the train that day only gets there after midnight.
        const sameDay = await search("RTM", "MMCT", runsOn).expect(200);
        expect(sameDay.body.trains).toEqual([]);

        // But boarding at the origin works on `runsOn`, and not the day after.
        expect((await search("NDLS", "RTM", runsOn).expect(200)).body.trains).toHaveLength(1);
        expect((await search("NDLS", "RTM", isoDate(8)).expect(200)).body.trains).toEqual([]);
    });

    it("shows the chosen quota, with its own counts and fare", async () => {
        await createScheduledTrain();
        const res = await search("KOTA", "MMCT", isoDate(3), "&quota=TATKAL").expect(200);
        const ac3 = res.body.trains[0].classes.find((c: { class: string }) => c.class === "AC3");
        expect(ac3).toEqual({ class: "AC3", fare: 148_900, availability: { status: "AVAILABLE", count: 36, label: "AVL 36" } });
    });

    it("leaves out cancelled schedules", async () => {
        const trainId = await createScheduledTrain();
        const date = isoDate(3);
        await prisma.trainSchedule.update({
            where: { trainId_journeyDate: { trainId, journeyDate: new Date(`${date}T00:00:00Z`) } },
            data: { status: "CANCELLED" },
        });
        expect((await search("NDLS", "MMCT", date).expect(200)).body.trains).toEqual([]);
    });

    it("validates the query", async () => {
        await createScheduledTrain();
        await search("NDLS", "NDLS", isoDate(3)).expect(400); // same station
        await search("NDLS", "MMCT", isoDate(-1)).expect(400); // in the past
        await search("NDLS", "MMCT", "01-11-2026").expect(400); // wrong date format
        await search("NDLS", "MMCT", isoDate(3), "&quota=VIP").expect(400);
        await api().get("/trains/search?from=NDLS").expect(400); // missing to & date
        const unknown = await search("NDLS", "XYZ", isoDate(3)).expect(404);
        expect(unknown.body.error.message).toBe("Station XYZ not found");
    });
});

describe("GET /trains/:scheduleId/availability", () => {
    async function scheduleId(daysFromToday = 3) {
        const res = await search("NDLS", "MMCT", isoDate(daysFromToday)).expect(200);
        return res.body.trains[0].scheduleId as string;
    }

    it("lists every class and quota for the whole route by default", async () => {
        await createScheduledTrain();
        const id = await scheduleId();
        const res = await api().get(`/trains/${id}/availability`).expect(200);

        expect(res.body).toMatchObject({
            scheduleId: id,
            train: { number: "12952" },
            journeyDate: isoDate(3),
            status: "SCHEDULED",
            bookable: true,
            from: { station: { code: "NDLS" }, departure: { date: isoDate(3), time: "16:55" } },
            to: { station: { code: "MMCT" }, arrival: { date: isoDate(4), time: "08:50" } },
            distanceKm: 1386,
        });
        expect(res.body.classes.map((c: { class: string }) => c.class)).toEqual(["AC2", "AC3"]);
        const ac3 = res.body.classes[1];
        expect(ac3.quotas.map((q: { quota: string }) => q.quota)).toEqual(["GENERAL", "TATKAL", "LADIES", "SENIOR_CITIZEN"]);
        expect(ac3.quotas[0]).toEqual({ quota: "GENERAL", fare: 170_400, availability: { status: "AVAILABLE", count: 91, label: "AVL 91" } });
    });

    it("prices just the part of the route travelled", async () => {
        await createScheduledTrain();
        const id = await scheduleId();
        const res = await api().get(`/trains/${id}/availability?from=KOTA&to=RTM`).expect(200);
        expect(res.body).toMatchObject({ distanceKm: 268, durationMinutes: 515 - 275 });
        expect(res.body.classes[1].quotas[0].fare).toBe(36_200); // 4,000 + 120 × 268 = 36,160 → ₹362
    });

    it("moves from AVL to RAC to WL as inventory runs out", async () => {
        await createScheduledTrain();
        const id = await scheduleId();
        const where = { scheduleId_class_quota: { scheduleId: id, class: "AC3" as const, quota: "GENERAL" as const } };
        const ac3General = async () =>
            (await api().get(`/trains/${id}/availability`).expect(200)).body.classes[1].quotas[0].availability.label;

        await prisma.seatInventory.update({ where, data: { availableSeats: 0, racBooked: 5 } });
        expect(await ac3General()).toBe("RAC 6");
        await prisma.seatInventory.update({ where, data: { racBooked: 8, waitlistIssued: 23 } });
        expect(await ac3General()).toBe("WL 24");
    });

    it("closes booking once the chart is prepared", async () => {
        await createScheduledTrain();
        const id = await scheduleId();
        await prisma.trainSchedule.update({ where: { id }, data: { status: "CHART_PREPARED" } });
        const res = await api().get(`/trains/${id}/availability`).expect(200);
        expect(res.body.bookable).toBe(false);
        expect(res.body.classes[0].quotas[0].availability).toEqual({ status: "BOOKING_CLOSED", count: null, label: "BOOKING CLOSED" });
    });

    it("rejects bad schedules and journeys", async () => {
        await createScheduledTrain();
        const id = await scheduleId();
        await api().get("/trains/not-a-uuid/availability").expect(400);
        await api().get("/trains/00000000-0000-4000-8000-000000000000/availability").expect(404);

        const offRoute = await api().get(`/trains/${id}/availability?from=BCT`).expect(400);
        expect(offRoute.body.error.code).toBe("STATION_NOT_ON_ROUTE");
        const backwards = await api().get(`/trains/${id}/availability?from=MMCT&to=KOTA`).expect(400);
        expect(backwards.body.error.code).toBe("INVALID_JOURNEY");
    });
});
