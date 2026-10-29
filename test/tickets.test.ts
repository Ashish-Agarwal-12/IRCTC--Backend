import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture emails instead of sending them. vi.mock is hoisted above the imports.
vi.mock("../src/shared/mailer.js", () => ({ sendMail: vi.fn(async () => {}) }));

import { sendMail } from "../src/shared/mailer.js";
import { prisma } from "../src/shared/prisma.js";
import { expireHolds } from "../src/modules/bookings/hold-expiry.js";
import { passengerStatus, rupees, ticketContent, type BookingView } from "../src/modules/bookings/ticket.js";
import { setPaymentGateway } from "../src/modules/payments/gateway.js";
import { MAX_ATTEMPTS, deliverOutbox } from "../src/modules/notifications/outbox.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";
import { createScheduledTrain, isoDate, search } from "./fixtures.js";
import { FakeRazorpay } from "./fake-razorpay.js";

const mockedSendMail = vi.mocked(sendMail);

let razorpay: FakeRazorpay;
let token: string;
let scheduleId: string;

// Supertest doesn't buffer binary bodies by default; collect the PDF bytes.
const binary = (res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
};
const downloadTicket = (pnr: string, as = token) =>
    api().get(`/bookings/${pnr}/ticket.pdf`).set(bearer(as)).buffer(true).parse(binary);

const holdBooking = async (passengers: object[] = [{ name: "Asha Kumar", age: 35, gender: "FEMALE", berthPreference: "LOWER" }]) => {
    const res = await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", randomUUID()).send({
        scheduleId, from: "NDLS", to: "MMCT", class: "AC3", passengers, contactPhone: "9876543210",
    }).expect(201);
    return res.body.booking.pnr as string;
};
const pay = async (pnr: string) => {
    const { orderId } = (await api().post("/payments/orders").set(bearer(token)).send({ pnr }).expect(201)).body.payment;
    return api().post("/payments/verify").send(razorpay.pay(orderId)).expect(200);
};
const outbox = () => prisma.outboxMessage.findMany({ orderBy: { createdAt: "asc" } });
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

beforeEach(async () => {
    mockedSendMail.mockReset();
    mockedSendMail.mockResolvedValue(undefined);
    razorpay = new FakeRazorpay();
    setPaymentGateway(razorpay);
    await resetDb();
    await createScheduledTrain();
    token = (await createUser()).token;
    scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
});

afterAll(() => setPaymentGateway(null));

// --------------------------------------------------------------------------- content

describe("ticket content", () => {
    it("writes statuses and money the Indian Railways way", () => {
        const p = (extra: object) => ({ position: 1, name: "A", age: 30, gender: "FEMALE", berthPreference: null, racNumber: null, waitlistNumber: null, berth: null, ...extra }) as BookingView["passengers"][number];
        expect(passengerStatus(p({ status: "CONFIRMED", berth: { coach: "B1", number: 23, type: "SIDE_LOWER" } }))).toBe("CNF B1/23 SIDE LOWER");
        expect(passengerStatus(p({ status: "RAC", racNumber: 3 }))).toBe("RAC 3");
        expect(passengerStatus(p({ status: "WAITLISTED", waitlistNumber: 12 }))).toBe("WL 12");
        expect(rupees(114600)).toBe("Rs. 1,146.00");
        expect(rupees(12345678)).toBe("Rs. 1,23,456.78"); // lakh grouping
    });

    it("lists the journey, every passenger and the payment", async () => {
        const pnr = await holdBooking([
            { name: "Asha Kumar", age: 35, gender: "FEMALE", berthPreference: "LOWER" },
            { name: "Ravi Kumar", age: 36, gender: "MALE" },
        ]);
        const view = (await api().get(`/bookings/${pnr}`).set(bearer(token)).expect(200)).body.booking;
        const content = ticketContent({ ...view, createdAt: new Date(view.createdAt) }, "pay_test123");

        expect(content.title).toBe(`E-ticket · PNR ${pnr}`);
        expect(Object.fromEntries(content.journey)).toMatchObject({
            PNR: pnr, Train: "12952 Mumbai Rajdhani", Class: "AC 3 Tier (3A)", Quota: "GENERAL",
            From: "New Delhi (NDLS)", Departure: `${isoDate(3)} 16:55`, To: "Mumbai Central (MMCT)",
        });
        expect(content.passengers).toEqual([
            { no: 1, name: "Asha Kumar", age: 35, gender: "FEMALE", status: expect.stringMatching(/^CNF B\d\/\d+ LOWER$/) },
            { no: 2, name: "Ravi Kumar", age: 36, gender: "MALE", status: expect.stringMatching(/^CNF B\d\/\d+ /) },
        ]);
        expect(Object.fromEntries(content.totals)).toMatchObject({ "Total fare": rupees(view.totalFare), Payment: "pay_test123" });
    });
});

// --------------------------------------------------------------------------- download

describe("GET /bookings/:pnr/ticket.pdf", () => {
    it("downloads a PDF ticket once the booking is paid", async () => {
        const pnr = await holdBooking();
        const unpaid = await api().get(`/bookings/${pnr}/ticket.pdf`).set(bearer(token)).expect(409);
        expect(unpaid.body.error).toMatchObject({ code: "TICKET_NOT_AVAILABLE", message: expect.stringContaining("isn't paid yet") });

        await pay(pnr);
        const res = await downloadTicket(pnr).expect(200);
        expect(res.headers["content-type"]).toBe("application/pdf");
        expect(res.headers["content-disposition"]).toBe(`attachment; filename="ticket-${pnr}.pdf"`);
        expect(res.headers["cache-control"]).toBe("private, no-store");
        const pdf = res.body as Buffer;
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        expect(pdf.length).toBeGreaterThan(1000);
    });

    it("is only for your own bookings", async () => {
        const pnr = await holdBooking();
        await pay(pnr);
        const stranger = (await createUser()).token;
        await api().get(`/bookings/${pnr}/ticket.pdf`).set(bearer(stranger)).expect(404);
        await api().get(`/bookings/${pnr}/ticket.pdf`).expect(401);
    });

    it("has no ticket for an expired hold", async () => {
        const pnr = await holdBooking();
        await expireHolds(minutesFromNow(11));
        const res = await api().get(`/bookings/${pnr}/ticket.pdf`).set(bearer(token)).expect(409);
        expect(res.body.error.message).toContain("EXPIRED");
    });
});

// --------------------------------------------------------------------------- emails (outbox)

describe("confirmation and refund emails", () => {
    it("emails the ticket after payment, exactly once", async () => {
        const pnr = await holdBooking();
        await pay(pnr);

        // Written in the same transaction as the confirmation, not sent yet.
        expect(await outbox()).toMatchObject([{ type: "BOOKING_CONFIRMED", status: "PENDING", attempts: 0 }]);
        expect(mockedSendMail).not.toHaveBeenCalled();

        expect(await deliverOutbox()).toBe(1);
        const [to, subject, text, attachments] = mockedSendMail.mock.calls[0];
        expect(to).toMatch(/@example\.test$/);
        expect(subject).toBe(`Booking confirmed · PNR ${pnr}`);
        expect(text).toContain("Paid: Rs. ");
        expect(attachments).toHaveLength(1);
        expect(attachments![0]).toMatchObject({ filename: `ticket-${pnr}.pdf`, contentType: "application/pdf" });
        expect(attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");

        expect(await outbox()).toMatchObject([{ status: "SENT", attempts: 1, lastError: null }]);
        // Verifying the payment again, or another worker run, doesn't send it again.
        expect(await deliverOutbox()).toBe(0);
        expect(mockedSendMail).toHaveBeenCalledTimes(1);
    });

    it("sends each email once even when two workers run at the same moment", async () => {
        for (let i = 0; i < 3; i++) await pay(await holdBooking());
        const sent = await Promise.all([deliverOutbox(), deliverOutbox(), deliverOutbox()]);
        expect(sent.reduce((a, b) => a + b, 0)).toBe(3);
        expect(mockedSendMail).toHaveBeenCalledTimes(3);
    });

    it("retries with backoff when the mail server fails, then gives up after the maximum", async () => {
        await pay(await holdBooking());
        mockedSendMail.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1025"));

        const now = new Date();
        expect(await deliverOutbox(now)).toBe(0);
        const [failed] = await outbox();
        expect(failed).toMatchObject({ status: "PENDING", attempts: 1, lastError: expect.stringContaining("ECONNREFUSED") });
        expect(failed.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);

        // Not due yet: nothing is tried.
        await deliverOutbox(new Date(now.getTime() + 10_000));
        expect(mockedSendMail).toHaveBeenCalledTimes(1);

        // Keep failing until the limit; then it's FAILED and left alone.
        let at = now.getTime();
        for (let attempt = 2; attempt <= MAX_ATTEMPTS + 1; attempt++) {
            at += 2 * 60 * 60_000; // well past any backoff
            await deliverOutbox(new Date(at));
        }
        expect(mockedSendMail).toHaveBeenCalledTimes(MAX_ATTEMPTS);
        expect(await outbox()).toMatchObject([{ status: "FAILED", attempts: MAX_ATTEMPTS }]);
    });

    it("delivers once the mail server is back", async () => {
        const pnr = await holdBooking();
        await pay(pnr);
        mockedSendMail.mockRejectedValueOnce(new Error("SMTP down"));
        const now = new Date();
        await deliverOutbox(now);
        expect(await deliverOutbox(new Date(now.getTime() + 60_000))).toBe(1);
        expect(mockedSendMail.mock.calls[1][1]).toBe(`Booking confirmed · PNR ${pnr}`);
    });

    it("explains the refund when the payment arrived after the hold ended", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await api().post("/payments/orders").set(bearer(token)).send({ pnr }).expect(201)).body.payment;
        await expireHolds(minutesFromNow(11));
        expect((await api().post("/payments/verify").send(razorpay.pay(orderId)).expect(200)).body.result).toBe("REFUNDED");

        expect(await outbox()).toMatchObject([{ type: "REFUND_INITIATED" }]);
        await deliverOutbox();
        const [, subject, text, attachments] = mockedSendMail.mock.calls[0];
        expect(subject).toBe(`Refund initiated · PNR ${pnr}`);
        expect(text).toContain("after your 10-minute seat hold had ended");
        expect(attachments).toEqual([]);
    });
});
