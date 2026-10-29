// A small, realistic catalog shared by the search and booking tests.

import { prisma } from "../src/shared/prisma.js";
import { api, bearer, createUser } from "./helpers.js";

// Dates relative to today (UTC), so the tests never go stale.
export function isoDate(daysFromToday: number): string {
    return new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}
export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export const weekdayOf = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

// 16:55 departure. KOTA at 21:30 on day 1; RTM departs at 01:33, which is day 2 of the run.
const route = {
    stops: [
        { stationCode: "NDLS", arrivalMinutes: null, departureMinutes: 0, distanceKm: 0 },
        { stationCode: "KOTA", arrivalMinutes: 270, departureMinutes: 275, distanceKm: 465 },
        { stationCode: "RTM", arrivalMinutes: 515, departureMinutes: 518, distanceKm: 733 },
        { stationCode: "MMCT", arrivalMinutes: 955, departureMinutes: null, distanceKm: 1386 },
    ],
};

// Call after resetDb(): an admin, fare rules, and one train (1 AC2 + 2 AC3 coaches) scheduled for
// the next two weeks on `runningDays`. Returns the train id.
export async function createScheduledTrain(runningDays = WEEKDAYS) {
    const { token } = await createUser({ role: "ADMIN" });
    const admin = (method: "post" | "put", url: string, body: object) =>
        api()[method](`/admin${url}`).set(bearer(token)).send(body);

    await prisma.fareRule.createMany({
        data: [
            { class: "AC3", baseFare: 4_000, perKm: 120 },
            { class: "AC2", baseFare: 5_000, perKm: 175 },
        ],
    });
    for (const [code, name, city] of [["NDLS", "New Delhi", "Delhi"], ["KOTA", "Kota Junction", "Kota"],
        ["RTM", "Ratlam Junction", "Ratlam"], ["MMCT", "Mumbai Central", "Mumbai"], ["BCT", "Mumbai (Bandra)", "Mumbai"]]) {
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

export const search = (from: string, to: string, date: string, extra = "") =>
    api().get(`/trains/search?from=${from}&to=${to}&date=${date}${extra}`);
