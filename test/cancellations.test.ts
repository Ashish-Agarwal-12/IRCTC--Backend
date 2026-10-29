import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/mailer.js", () => ({ sendMail: vi.fn(async () => {}) }));

import { sendMail } from "../src/shared/mailer.js";
import { prisma } from "../src/shared/prisma.js";
import { expireHolds } from "../src/modules/bookings/hold-expiry.js";
import { cancelBooking } from "../src/modules/bookings/cancellation.service.js";
import { prepareDueCharts } from "../src/modules/bookings/chart.js";
import { CLERKAGE, FLAT_CHARGE, cancellationRefund } from "../src/modules/bookings/refund-rules.js";
import { departureInstant } from "../src/modules/trains/search.service.js";
import { setPaymentGateway } from "../src/modules/payments/gateway.js";
import { processRefund } from "../src/modules/payments/refunds.js";
import { reconcilePayments } from "../src/modules/payments/reconciliation.js";
import { deliverOutbox } from "../src/modules/notifications/outbox.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";
import { createScheduledTrain, isoDate, search } from "./fixtures.js";
import { FakeRazorpay } from "./fake-razorpay.js";

const mockedSendMail = vi.mocked(sendMail);
const HOUR = 60 * 60_000;

let razorpay: FakeRazorpay;
let token: string;
let adminToken: string;
let scheduleId: string;

const passenger = (name: string) => ({ name, age: 35, gender: "FEMALE" });
const book = async (names: string[], extra: object = {}) => {
    const res = await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", randomUUID()).send({
        scheduleId, from: "NDLS", to: "MMCT", class: "AC3", passengers: names.map(passenger), contactPhone: "9876543210", ...extra,
    }).expect(201);
    return res.body.booking.pnr as string;
};
const pay = async (pnr: string) => {
    const { orderId } = (await api().post("/payments/orders").set(bearer(token)).send({ pnr }).expect(201)).body.payment;
    await api().post("/payments/verify").send(razorpay.pay(orderId)).expect(200);
};
const bookAndPay = async (name: string) => { const pnr = await book([name]); await pay(pnr); return pnr; };
const cancel = (pnr: string, query = "", as = token) => api().delete(`/bookings/${pnr}${query}`).set(bearer(as));

const ac3General = () => ({ scheduleId_class_quota: { scheduleId, class: "AC3" as const, quota: "GENERAL" as const } });
const setInventory = (data: object) => prisma.seatInventory.update({ where: ac3General(), data });
const inventory = () => prisma.seatInventory.findUniqueOrThrow({ where: ac3General() });

// Everyone's current status, by name: "CONFIRMED", "RAC 1", "WL 2", "CANCELLED".
async function statuses() {
    const passengers = await prisma.passenger.findMany({ include: { allocation: true } });
    return Object.fromEntries(passengers.map((p) => [
        p.name,
        p.status === "RAC" ? `RAC ${p.racNumber}` : p.status === "WAITLISTED" ? `WL ${p.waitlistNumber}` : p.status,
    ]));
}

// The invariants every cascade must keep, checked after each scenario.
async function expectConsistentQueues() {
    const inv = await inventory();
    const active = await prisma.passenger.findMany({
        where: { booking: { scheduleId, class: "AC3", quota: "GENERAL" }, status: { in: ["RAC", "WAITLISTED"] } },
    });
    const rac = active.filter((p) => p.status === "RAC").map((p) => p.racNumber).sort((a, b) => a! - b!);
    const wl = active.filter((p) => p.status === "WAITLISTED").map((p) => p.waitlistNumber).sort((a, b) => a! - b!);
    expect(rac).toEqual(rac.map((_, i) => i + 1)); // positions 1..n, no gaps or repeats
    expect(wl).toEqual(wl.map((_, i) => i + 1));
    expect(inv.racBooked).toBe(rac.length);
    expect(inv.waitlistBooked).toBe(wl.length);
    if (wl.length > 0) expect(inv.racBooked).toBe(inv.racCapacity); // nobody waitlisted while RAC has room

    const confirmed = await prisma.passenger.count({ where: { status: "CONFIRMED", booking: { scheduleId, class: "AC3" } } });
    const allocations = await prisma.seatAllocation.findMany({ where: { scheduleId }, select: { seatId: true } });
    expect(allocations).toHaveLength(confirmed); // every confirmed passenger has exactly one berth
    expect(new Set(allocations.map((a) => a.seatId)).size).toBe(allocations.length);
}

beforeEach(async () => {
    mockedSendMail.mockReset();
    mockedSendMail.mockResolvedValue(undefined);
    razorpay = new FakeRazorpay();
    setPaymentGateway(razorpay);
    await resetDb();
    await createScheduledTrain();
    token = (await createUser()).token;
    adminToken = (await createUser({ role: "ADMIN" })).token;
    scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
});

afterAll(() => setPaymentGateway(null));

// --------------------------------------------------------------------------- rules

describe("refund rules", () => {
    const fare = 300_000; // Rs. 3,000
    const rule = (status: "CONFIRMED" | "RAC" | "WAITLISTED", hours: number, quota: "GENERAL" | "TATKAL" = "GENERAL") =>
        cancellationRefund({ status, quota, coachClass: "AC3", fare, msBeforeDeparture: hours * HOUR });

    it("charges confirmed berths more the closer it is to departure", () => {
        expect(rule("CONFIRMED", 72)).toMatchObject({ charge: FLAT_CHARGE.AC3, refund: fare - FLAT_CHARGE.AC3 });
        expect(rule("CONFIRMED", 24)).toMatchObject({ charge: 75_000, refund: 225_000 });  // 25%
        expect(rule("CONFIRMED", 6)).toMatchObject({ charge: 150_000, refund: 150_000 });  // 50%
        expect(rule("CONFIRMED", 3)).toMatchObject({ charge: fare, refund: 0 });           // chart prepared
        expect(rule("CONFIRMED", 72, "TATKAL")).toMatchObject({ refund: 0 });               // Tatkal
        // The percentage never drops below the flat charge.
        expect(cancellationRefund({ status: "CONFIRMED", quota: "GENERAL", coachClass: "AC3", fare: 40_000, msBeforeDeparture: 24 * HOUR }))
            .toMatchObject({ charge: FLAT_CHARGE.AC3, refund: 22_000 });
    });

    it("refunds RAC and waitlisted passengers minus clerkage, until 30 minutes before departure", () => {
        expect(rule("RAC", 2)).toMatchObject({ charge: CLERKAGE, refund: fare - CLERKAGE });
        expect(rule("WAITLISTED", 72, "TATKAL")).toMatchObject({ charge: CLERKAGE });
        expect(rule("WAITLISTED", 0.25)).toMatchObject({ refund: 0 });
        expect(rule("RAC", -1)).toMatchObject({ refund: 0, rule: expect.stringContaining("departed") });
    });

    it("reads timetable times as Indian Standard Time", () => {
        // 16:55 IST on 3 Nov is 11:25 UTC.
        expect(departureInstant(new Date("2026-11-03T00:00:00Z"), 1015, 0).toISOString()).toBe("2026-11-03T11:25:00.000Z");
    });
});

// --------------------------------------------------------------------------- the cascade

describe("cancellation cascade", () => {
    // One berth and two RAC places left: A gets the berth, B and C get RAC, D and E are waitlisted.
    async function queue() {
        await setInventory({ availableSeats: 1, racCapacity: 2, racBooked: 0, waitlistBooked: 0 });
        const pnrs: Record<string, string> = {};
        for (const name of ["Asha", "Bina", "Chitra", "Deepa", "Esha"]) pnrs[name] = await bookAndPay(name);
        expect(await statuses()).toEqual({ Asha: "CONFIRMED", Bina: "RAC 1", Chitra: "RAC 2", Deepa: "WL 1", Esha: "WL 2" });
        return pnrs;
    }

    it("gives a cancelled berth to RAC 1 and an RAC place to WL 1, and moves everyone up", async () => {
        const pnrs = await queue();
        const res = await cancel(pnrs.Asha).expect(200);

        expect(res.body.booking.status).toBe("CANCELLED");
        expect(res.body.cancellation.passengers).toEqual([expect.objectContaining({ name: "Asha", previousStatus: "CONFIRMED", charge: FLAT_CHARGE.AC3 })]);
        expect(res.body.cancellation.refund).toEqual({ amount: res.body.booking.totalFare - FLAT_CHARGE.AC3, status: "PROCESSED" });
        expect(res.body.booking.refunds).toMatchObject([{ status: "PROCESSED", reason: "Cancelled by you: 1 passenger" }]);

        expect(await statuses()).toEqual({ Asha: "CANCELLED", Bina: "CONFIRMED", Chitra: "RAC 1", Deepa: "RAC 2", Esha: "WL 1" });
        const bina = (await api().get(`/bookings/${pnrs.Bina}`).set(bearer(token)).expect(200)).body.booking;
        expect(bina.passengers[0].berth).toMatchObject({ coach: expect.stringMatching(/^B\d$/) });
        expect(await inventory()).toMatchObject({ availableSeats: 0, racBooked: 2, waitlistBooked: 1 });
        await expectConsistentQueues();
    });

    it("gives a cancelled RAC place to WL 1; a waitlisted passenger leaving just closes the gap", async () => {
        const pnrs = await queue();
        await cancel(pnrs.Bina).expect(200);
        expect(await statuses()).toMatchObject({ Asha: "CONFIRMED", Chitra: "RAC 1", Deepa: "RAC 2", Esha: "WL 1" });

        const res = await cancel(pnrs.Esha).expect(200);
        expect(res.body.cancellation.passengers[0]).toMatchObject({ previousStatus: "WAITLISTED", charge: CLERKAGE });
        expect(await inventory()).toMatchObject({ availableSeats: 0, racBooked: 2, waitlistBooked: 0 });
        await expectConsistentQueues();

        // Nobody left waiting: the next freed berth goes back to the pool for new bookings.
        await cancel(pnrs.Chitra).expect(200);
        await cancel(pnrs.Asha).expect(200);
        expect(await statuses()).toMatchObject({ Deepa: "CONFIRMED" });
        expect((await inventory()).availableSeats).toBe(0);
        await cancel(pnrs.Deepa).expect(200);
        expect((await inventory()).availableSeats).toBe(1);
        await expectConsistentQueues();
    });

    it("emails the cancellation and tells promoted passengers their new status, with a new ticket", async () => {
        const pnrs = await queue();
        await prisma.outboxMessage.deleteMany(); // ignore the confirmation emails
        await cancel(pnrs.Asha).expect(200);
        expect((await prisma.outboxMessage.findMany()).map((m) => m.type).sort())
            // Bina (RAC → CNF) and Deepa (WL → RAC) changed status. Chitra and Esha only moved up a place.
            .toEqual(["BOOKING_CANCELLED", "STATUS_CHANGED", "STATUS_CHANGED"]);

        await deliverOutbox();
        const subjects = mockedSendMail.mock.calls.map((c) => c[1]).sort();
        expect(subjects).toContain(`Cancellation · PNR ${pnrs.Asha}`);
        const binaMail = mockedSendMail.mock.calls.find((c) => c[1] === `Status update · PNR ${pnrs.Bina}`)!;
        expect(binaMail[2]).toMatch(/1\. Bina: CNF B\d\/\d+/);
        expect(binaMail[3]![0].contentType).toBe("application/pdf");
        const cancelMail = mockedSendMail.mock.calls.find((c) => c[1] === `Cancellation · PNR ${pnrs.Asha}`)!;
        expect(cancelMail[2]).toContain("More than 48 h before departure: flat charge");
    });

    it("cancels part of a party and keeps the rest", async () => {
        await setInventory({ availableSeats: 2, racCapacity: 2 });
        const pnr = await book(["Asha", "Bina", "Chitra"]);
        await pay(pnr);
        expect(await statuses()).toEqual({ Asha: "CONFIRMED", Bina: "CONFIRMED", Chitra: "RAC 1" });

        const res = await cancel(pnr, "?passengers=1").expect(200);
        expect(res.body.booking.status).toBe("CONFIRMED");
        // Chitra (RAC 1 on the same booking) takes Asha's berth.
        expect(res.body.booking.passengers.map((p: { status: string }) => p.status)).toEqual(["CANCELLED", "CONFIRMED", "CONFIRMED"]);
        expect(res.body.cancellation.passengers).toHaveLength(1);

        await cancel(pnr, "?passengers=1").expect(400).expect((r) => expect(r.body.error.code).toBe("INVALID_PASSENGERS"));
        await cancel(pnr, "?passengers=x").expect(400);
        await cancel(pnr).expect(200); // the rest
        expect((await prisma.booking.findUniqueOrThrow({ where: { pnr } })).status).toBe("CANCELLED");
        await cancel(pnr).expect(409).expect((r) => expect(r.body.error.code).toBe("NOT_CANCELLABLE"));
        await expectConsistentQueues();
    });

    it("lets expired holds promote waiting passengers too", async () => {
        await setInventory({ availableSeats: 1, racCapacity: 2 });
        await book(["Asha"]);              // holds the berth, never pays
        await bookAndPay("Bina");          // RAC 1
        await expireHolds(new Date(Date.now() + 11 * 60_000));
        expect(await statuses()).toEqual({ Asha: "CANCELLED", Bina: "CONFIRMED" });
        await expectConsistentQueues();
    });

    it("cancels an unpaid booking whole, with no refund", async () => {
        const pnr = await book(["Asha", "Bina"]);
        await cancel(pnr, "?passengers=1").expect(400).expect((r) => expect(r.body.error.code).toBe("PARTIAL_CANCEL_UNPAID"));
        const res = await cancel(pnr).expect(200);
        expect(res.body.cancellation.refund).toBeNull();
        expect(res.body.booking.status).toBe("CANCELLED");
        expect(await prisma.outboxMessage.count()).toBe(0); // nothing paid, nothing to tell
    });

    it("only lets you cancel your own bookings, before departure", async () => {
        const pnr = await bookAndPay("Asha");
        const stranger = (await createUser()).token;
        await cancel(pnr, "", stranger).expect(404);
        const user = await prisma.booking.findUniqueOrThrow({ where: { pnr }, select: { userId: true } });
        await expect(cancelBooking(user.userId, pnr, undefined, new Date(Date.now() + 30 * 24 * HOUR)))
            .rejects.toMatchObject({ code: "CANCELLATION_CLOSED" });
    });
});

// --------------------------------------------------------------------------- refunds

describe("cancellation refunds", () => {
    it("records the refund even if Razorpay is down, and pays it later", async () => {
        const pnr = await bookAndPay("Asha");
        razorpay.down = true;
        const res = await cancel(pnr).expect(200);
        expect(res.body.cancellation.refund.status).toBe("PENDING");
        expect(await prisma.refund.findMany()).toMatchObject([{ status: "PENDING", lastError: expect.any(String) }]);

        razorpay.down = false;
        await reconcilePayments(new Date(Date.now() + 2 * 60_000));
        expect(await prisma.refund.findMany()).toMatchObject([{ status: "PROCESSED", gatewayRefundId: expect.stringMatching(/^rfnd_/) }]);
        expect(razorpay.refunds).toBe(1);
    });

    it("never refunds twice, even if we crashed right after Razorpay refunded", async () => {
        const pnr = await bookAndPay("Asha");
        razorpay.down = true;
        await cancel(pnr).expect(200);
        razorpay.down = false;
        const [refund] = await prisma.refund.findMany({ include: { payment: true } });

        // Razorpay processed it, but we died before saving that.
        await razorpay.refundPayment(refund.payment.gatewayPaymentId!, { amount: refund.amount, notes: { refundId: refund.id } });
        expect(await processRefund(refund.id)).toBe(true);
        expect(await processRefund(refund.id)).toBe(true);
        expect(razorpay.refunds).toBe(1);
        expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("PROCESSED");
    });
});

// --------------------------------------------------------------------------- concurrency

describe("concurrent cancellations", () => {
    it("keeps the queues consistent when many passengers cancel at once", async () => {
        await setInventory({ availableSeats: 6, racCapacity: 4 });
        const names = Array.from({ length: 16 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
        const pnrs: string[] = [];
        for (const name of names) pnrs.push(await bookAndPay(name)); // 6 CNF, 4 RAC, 6 WL

        // The 6 confirmed and 2 of the waitlisted cancel simultaneously.
        const leaving = [...pnrs.slice(0, 6), pnrs[11], pnrs[13]];
        const results = await Promise.all(leaving.map((pnr) => cancel(pnr)));
        expect(results.map((r) => r.status)).toEqual(leaving.map(() => 200));

        await expectConsistentQueues();
        const s = await statuses();
        // Whatever order the 8 cancellations ran in, the 6 freed berths went to the first 6 still
        // waiting, in queue order (RAC 1-4, then the waitlist), and the last two are RAC.
        expect(["P07", "P08", "P09", "P10", "P11", "P13"].map((n) => s[n])).toEqual(Array(6).fill("CONFIRMED"));
        expect([s.P15, s.P16]).toEqual(["RAC 1", "RAC 2"]);
        expect(await inventory()).toMatchObject({ availableSeats: 0, racBooked: 2, waitlistBooked: 0 });
    });

    it("cancels a booking once when the same request arrives twice", async () => {
        const pnr = await bookAndPay("Asha");
        const results = await Promise.all([cancel(pnr), cancel(pnr)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await prisma.refund.count()).toBe(1);
        expect(razorpay.refunds).toBe(1);
    });

    it("keeps the queue straight while bookings and cancellations race", async () => {
        await setInventory({ availableSeats: 2, racCapacity: 2 });
        const early = [await bookAndPay("A1"), await bookAndPay("A2"), await bookAndPay("A3"), await bookAndPay("A4")];
        await Promise.all([
            ...early.map((pnr) => cancel(pnr)),
            ...["N1", "N2", "N3", "N4"].map((name) => book([name])),
        ]);
        await expectConsistentQueues();
    });
});

// --------------------------------------------------------------------------- chart preparation

describe("chart preparation", () => {
    it("cancels what's still waitlisted with a refund, keeps RAC, and closes booking", async () => {
        await setInventory({ availableSeats: 1, racCapacity: 1 });
        const confirmed = await bookAndPay("Asha");
        const rac = await bookAndPay("Bina");
        const waitlisted = await bookAndPay("Chitra");
        const party = await book(["Deepa", "Esha"]); // both waitlisted, unpaid
        await prisma.outboxMessage.deleteMany();

        const res = await api().post(`/admin/schedules/${scheduleId}/chart`).set(bearer(adminToken)).expect(200);
        expect(res.body.chart).toMatchObject({ scheduleId, cancelledPassengers: 3, affectedBookings: 2 });

        expect(await statuses()).toEqual({ Asha: "CONFIRMED", Bina: "RAC 1", Chitra: "CANCELLED", Deepa: "CANCELLED", Esha: "CANCELLED" });
        const wl = await prisma.booking.findUniqueOrThrow({ where: { pnr: waitlisted }, include: { refunds: true } });
        expect(wl.status).toBe("CANCELLED");
        expect(wl.refunds).toMatchObject([{ amount: wl.totalFare - CLERKAGE, status: "PROCESSED", reason: "Waitlisted at chart preparation: 1 passenger" }]);
        expect((await prisma.booking.findUniqueOrThrow({ where: { pnr: party } })).status).toBe("CANCELLED");
        expect((await prisma.outboxMessage.findMany()).map((m) => m.type)).toEqual(["BOOKING_CANCELLED"]); // paid one only

        // No more bookings, no second chart; confirmed and RAC are untouched.
        await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", randomUUID())
            .send({ scheduleId, from: "NDLS", to: "MMCT", class: "AC3", passengers: [passenger("Late")], contactPhone: "9876543210" })
            .expect(409).expect((r) => expect(r.body.error.code).toBe("BOOKING_CLOSED"));
        await api().post(`/admin/schedules/${scheduleId}/chart`).set(bearer(adminToken)).expect(409);
        expect((await prisma.booking.findUniqueOrThrow({ where: { pnr: confirmed } })).status).toBe("CONFIRMED");
        expect((await prisma.booking.findUniqueOrThrow({ where: { pnr: rac } })).status).toBe("CONFIRMED");

        // After the chart, a confirmed passenger cancelling still upgrades RAC.
        await cancel(confirmed).expect(200);
        expect((await statuses()).Bina).toBe("CONFIRMED");
        await expectConsistentQueues();
    });

    it("runs on its own 4 hours before the train leaves its origin", async () => {
        const schedule = await prisma.trainSchedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { train: true } });
        const departs = departureInstant(schedule.journeyDate, schedule.train.departureMinutes, 0);
        const next = await prisma.trainSchedule.findFirstOrThrow({ where: { trainId: schedule.trainId, journeyDate: { gt: schedule.journeyDate } }, orderBy: { journeyDate: "asc" } });

        await prepareDueCharts(new Date(departs.getTime() - 5 * HOUR));
        expect((await prisma.trainSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).status).toBe("SCHEDULED");

        await prepareDueCharts(new Date(departs.getTime() - 4 * HOUR));
        expect((await prisma.trainSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).status).toBe("CHART_PREPARED");
        expect((await prisma.trainSchedule.findUniqueOrThrow({ where: { id: next.id } })).status).toBe("SCHEDULED");
        expect(await prepareDueCharts(new Date(departs.getTime() - 4 * HOUR))).toBe(0); // idempotent
    });
});
