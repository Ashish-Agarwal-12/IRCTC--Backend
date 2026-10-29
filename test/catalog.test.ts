import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/shared/prisma.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";

let adminToken: string;

// Dates relative to today, so the tests never go stale. All in UTC, like the app.
function isoDate(daysFromToday: number): string {
    return new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}

const route = {
    stops: [
        { stationCode: "NDLS", arrivalMinutes: null, departureMinutes: 0, distanceKm: 0 },
        { stationCode: "KOTA", arrivalMinutes: 270, departureMinutes: 275, distanceKm: 465 },
        { stationCode: "MMCT", arrivalMinutes: 955, departureMinutes: null, distanceKm: 1386 },
    ],
};

const admin = () => ({
    post: (url: string, body: object) => api().post(`/admin${url}`).set(bearer(adminToken)).send(body),
    put: (url: string, body: object) => api().put(`/admin${url}`).set(bearer(adminToken)).send(body),
    patch: (url: string, body: object) => api().patch(`/admin${url}`).set(bearer(adminToken)).send(body),
});

async function createStations() {
    for (const [code, name, city] of [["NDLS", "New Delhi", "Delhi"], ["NZM", "Hazrat Nizamuddin", "Delhi"],
        ["KOTA", "Kota Junction", "Kota"], ["MMCT", "Mumbai Central", "Mumbai"]]) {
        await admin().post("/stations", { code, name, city }).expect(201);
    }
}

// A train with a route and coaches, ready for schedule generation.
async function createReadyTrain(runningDays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]) {
    await createStations();
    const created = await admin().post("/trains", {
        number: "12952", name: "Mumbai Rajdhani", runningDays, departureTime: "16:55",
    }).expect(201);
    const id: string = created.body.train.id;
    await admin().put(`/trains/${id}/route`, route).expect(200);
    await admin().put(`/trains/${id}/coaches`, {
        coaches: [{ code: "A1", class: "AC2" }, { code: "B1", class: "AC3" }, { code: "B2", class: "AC3" }],
    }).expect(200);
    return id;
}

beforeEach(async () => {
    await resetDb();
    adminToken = (await createUser({ role: "ADMIN" })).token;
});

describe("admin access", () => {
    it("rejects anonymous and non-admin users on every admin route", async () => {
        const user = await createUser();
        await api().post("/admin/stations").send({}).expect(401);
        await api().post("/admin/stations").set(bearer(user.token)).send({}).expect(403);
        await api().post("/admin/trains").set(bearer(user.token)).send({}).expect(403);
    });
});

describe("stations", () => {
    it("creates, rejects duplicates, and normalises the code", async () => {
        const res = await admin().post("/stations", { code: "ndls", name: "New Delhi", city: "Delhi" }).expect(201);
        expect(res.body.station.code).toBe("NDLS");
        await admin().post("/stations", { code: "NDLS", name: "Again", city: "Delhi" }).expect(409);
    });

    it("searches by code, name and city, exact code first", async () => {
        await createStations();
        const byCity = await api().get("/stations?q=delhi").expect(200);
        expect(byCity.body.stations.map((s: { code: string }) => s.code).sort()).toEqual(["NDLS", "NZM"]);

        const byCode = await api().get("/stations?q=kota").expect(200);
        expect(byCode.body.stations[0].code).toBe("KOTA");

        await api().get("/stations").expect(400); // q is required
    });

    it("updates name and city but not the code", async () => {
        const { body } = await admin().post("/stations", { code: "BCT", name: "Bombay Central", city: "Mumbai" });
        const res = await admin().patch(`/stations/${body.station.id}`, { name: "Mumbai Central", code: "XX" }).expect(200);
        expect(res.body.station).toMatchObject({ code: "BCT", name: "Mumbai Central" });
        await admin().patch(`/stations/${body.station.id}`, {}).expect(400);
        await admin().patch("/stations/00000000-0000-4000-8000-000000000000", { name: "Nowhere" }).expect(404);
    });
});

describe("trains, routes and coaches", () => {
    it("returns a train with clock times and day offsets", async () => {
        await createReadyTrain();
        const res = await api().get("/trains/12952").expect(200);
        const { train } = res.body;

        expect(train.departureTime).toBe("16:55");
        expect(train.route.map((s: { station: { code: string } }) => s.station.code)).toEqual(["NDLS", "KOTA", "MMCT"]);
        // 16:55 + 955 min = 08:50 the next day
        expect(train.route[2]).toMatchObject({ arrival: { time: "08:50", day: 2 }, departure: null });
        expect(train.coaches).toEqual([
            { code: "A1", class: "AC2", seats: 48 },
            { code: "B1", class: "AC3", seats: 72 },
            { code: "B2", class: "AC3", seats: 72 },
        ]);
    });

    it("rejects routes that break timing or distance rules, pointing at the bad field", async () => {
        await createStations();
        const { body } = await admin().post("/trains", {
            number: "12952", name: "Mumbai Rajdhani", runningDays: ["MON"], departureTime: "16:55",
        });
        const bad = structuredClone(route);
        bad.stops[1].arrivalMinutes = 0;   // arrives before the origin departs
        bad.stops[2].distanceKm = 100;     // closer than the previous stop

        const res = await admin().put(`/trains/${body.train.id}/route`, bad).expect(400);
        const paths = res.body.error.details.map((d: { path: (string | number)[] }) => d.path.join("."));
        expect(paths).toEqual(expect.arrayContaining(["stops.1.arrivalMinutes", "stops.2.distanceKm"]));
    });

    it("rejects unknown station codes", async () => {
        await createStations();
        const { body } = await admin().post("/trains", {
            number: "12952", name: "Mumbai Rajdhani", runningDays: ["MON"], departureTime: "16:55",
        });
        const withUnknown = structuredClone(route);
        withUnknown.stops[1].stationCode = "ZZZZ";
        const res = await admin().put(`/trains/${body.train.id}/route`, withUnknown).expect(400);
        expect(res.body.error.code).toBe("UNKNOWN_STATION");
    });

    it("lists trains with pagination", async () => {
        await createReadyTrain();
        const res = await api().get("/trains?page=1&pageSize=10").expect(200);
        expect(res.body).toMatchObject({ page: 1, pageSize: 10, total: 1 });
        await api().get("/trains?pageSize=1000").expect(400);
    });
});

describe("schedule generation", () => {
    it("creates schedules only on running days, with inventory that adds up", async () => {
        const id = await createReadyTrain(["MON", "WED", "FRI"]);

        const res = await admin().post(`/trains/${id}/schedules`, { from: isoDate(1), to: isoDate(14) }).expect(201);
        expect(res.body.created).toBe(res.body.runningDates);
        expect(res.body.runningDates).toBe(6); // 14 days hold exactly two of each weekday

        const schedules = await prisma.trainSchedule.findMany({ where: { trainId: id }, include: { inventories: true } });
        for (const s of schedules) {
            expect(["MON", "WED", "FRI"]).toContain(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][s.journeyDate.getUTCDay()]);
            const total = (cls: string) =>
                s.inventories.filter((i) => i.class === cls).reduce((sum, i) => sum + i.totalSeats, 0);
            expect(total("AC2")).toBe(48);
            expect(total("AC3")).toBe(144);
        }
    });

    it("is idempotent: re-running a range creates nothing new", async () => {
        const id = await createReadyTrain();
        await admin().post(`/trains/${id}/schedules`, { from: isoDate(1), to: isoDate(5) }).expect(201);
        const again = await admin().post(`/trains/${id}/schedules`, { from: isoDate(1), to: isoDate(7) }).expect(201);
        expect(again.body).toMatchObject({ runningDates: 7, created: 2, skipped: 5 });
        expect(await prisma.trainSchedule.count({ where: { trainId: id } })).toBe(7);
    });

    it("refuses past dates, oversized ranges, and trains without coaches", async () => {
        const id = await createReadyTrain();
        await admin().post(`/trains/${id}/schedules`, { from: isoDate(-1), to: isoDate(3) }).expect(400);
        await admin().post(`/trains/${id}/schedules`, { from: isoDate(1), to: isoDate(200) }).expect(400);

        const bare = await admin().post("/trains", { number: "11111", name: "Bare", runningDays: ["MON"], departureTime: "06:00" });
        await admin().post(`/trains/${bare.body.train.id}/schedules`, { from: isoDate(1), to: isoDate(7) }).expect(409);
    });

    it("locks the coach layout once schedules exist", async () => {
        const id = await createReadyTrain();
        await admin().post(`/trains/${id}/schedules`, { from: isoDate(1), to: isoDate(2) }).expect(201);
        const res = await admin().put(`/trains/${id}/coaches`, { coaches: [{ code: "S1", class: "SL" }] }).expect(409);
        expect(res.body.error.message).toMatch(/schedules/);
    });
});
