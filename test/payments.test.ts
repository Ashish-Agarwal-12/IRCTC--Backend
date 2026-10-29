import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { envSchema } from "../src/config/env.js";
import { prisma } from "../src/shared/prisma.js";
import { expireHolds } from "../src/modules/bookings/hold-expiry.js";
import { setPaymentGateway, type GatewayPayment } from "../src/modules/payments/gateway.js";
import { reconcilePayments } from "../src/modules/payments/reconciliation.js";
import { settlePayment } from "../src/modules/payments/payments.service.js";
import { checkoutSignature, webhookSignature } from "../src/modules/payments/signatures.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";
import { createScheduledTrain, isoDate, search } from "./fixtures.js";
import { testEnv } from "./test-env.js";
import { FakeRazorpay } from "./fake-razorpay.js";

let razorpay: FakeRazorpay;
let token: string;
let scheduleId: string;

const holdBooking = async (as = token) => {
    const res = await api().post("/bookings").set(bearer(as)).set("Idempotency-Key", randomUUID()).send({
        scheduleId, from: "NDLS", to: "MMCT", class: "AC3",
        passengers: [{ name: "Asha Kumar", age: 35, gender: "FEMALE" }], contactPhone: "9876543210",
    }).expect(201);
    return res.body.booking.pnr as string;
};
const createOrder = (pnr: string, as = token) => api().post("/payments/orders").set(bearer(as)).send({ pnr });
const verify = (body: object) => api().post("/payments/verify").send(body);
const bookingOf = (pnr: string) => prisma.booking.findUniqueOrThrow({ where: { pnr }, include: { payments: true, passengers: { include: { allocation: true } } } });

const webhook = (event: string, payment: GatewayPayment, eventId = randomUUID(), secret = testEnv.RAZORPAY_WEBHOOK_SECRET) => {
    const body = JSON.stringify({
        event,
        payload: {
            payment: {
                entity: {
                    id: payment.id, order_id: payment.orderId, amount: payment.amount, currency: payment.currency,
                    status: payment.status, amount_refunded: payment.amountRefunded, error_description: payment.errorDescription,
                },
            },
        },
    });
    return api().post("/payments/webhook")
        .set("content-type", "application/json")
        .set("x-razorpay-signature", webhookSignature(secret, body))
        .set("x-razorpay-event-id", eventId)
        .send(body);
};

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

beforeEach(async () => {
    razorpay = new FakeRazorpay();
    setPaymentGateway(razorpay);
    await resetDb();
    await createScheduledTrain();
    token = (await createUser()).token;
    scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
});

afterAll(() => setPaymentGateway(null));

// --------------------------------------------------------------------------- happy path

describe("paying for a booking", () => {
    it("creates one order per hold, and confirms the booking after checkout", async () => {
        const pnr = await holdBooking();

        const order = await createOrder(pnr).expect(201);
        expect(order.body.payment).toMatchObject({ currency: "INR", pnr, keyId: "rzp_test_fakekeyfortests" });
        const { orderId, amount } = order.body.payment;
        expect(amount).toBe((await bookingOf(pnr)).totalFare);
        expect(order.body.payment.checkoutUrl).toContain(`/payments/checkout#orderId=${orderId}`);
        // Checkout is prefilled with the booking's contact details, so Razorpay doesn't ask again.
        const booked = await bookingOf(pnr);
        expect(order.body.payment.prefill).toEqual({ contact: "9876543210", email: booked.contactEmail });
        expect(new URL(order.body.payment.checkoutUrl).hash).toContain("contact=9876543210");

        // Opening checkout again reuses the open order.
        expect((await createOrder(pnr).expect(200)).body.payment.orderId).toBe(orderId);
        expect(razorpay.orders.size).toBe(1);

        const checkout = razorpay.pay(orderId);
        const res = await verify(checkout).expect(200);
        expect(res.body.result).toBe("CONFIRMED");
        expect(res.body.booking).toMatchObject({ pnr, status: "CONFIRMED", holdExpiresAt: null });

        // Verifying again (a double-click, a retry) changes nothing.
        expect((await verify(checkout).expect(200)).body.result).toBe("CONFIRMED");
        const booking = await bookingOf(pnr);
        expect(booking.payments).toMatchObject([{ status: "CAPTURED", gatewayPaymentId: checkout.razorpay_payment_id }]);
        await createOrder(pnr).expect(409).expect((r) => expect(r.body.error.code).toBe("ALREADY_PAID"));

        // A paid booking keeps its seats when its hold time passes.
        expect(await expireHolds(minutesFromNow(60))).toBe(0);
        expect((await bookingOf(pnr)).passengers[0].allocation).not.toBeNull();
    });

    it("rejects forged or mismatched signatures", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        const checkout = razorpay.pay(orderId);

        const forged = { ...checkout, razorpay_signature: checkoutSignature("not-our-secret", orderId, checkout.razorpay_payment_id) };
        await verify(forged).expect(400).expect((r) => expect(r.body.error.code).toBe("INVALID_SIGNATURE"));
        // A valid signature for a different payment can't be reused for this one.
        const other = razorpay.pay(orderId);
        await verify({ ...checkout, razorpay_signature: other.razorpay_signature }).expect(400);
        await verify({ razorpay_order_id: "nope" }).expect(400);

        expect((await bookingOf(pnr)).status).toBe("PENDING_PAYMENT");
    });

    it("keeps the hold after a failed attempt, so the user can pay again", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;

        const failed = await verify(razorpay.pay(orderId, "failed")).expect(402);
        expect(failed.body.error).toMatchObject({ code: "PAYMENT_NOT_COMPLETED", message: "Card declined by bank" });
        expect((await bookingOf(pnr)).payments[0]).toMatchObject({ status: "CREATED", lastError: "Card declined by bank" });

        expect((await verify(razorpay.pay(orderId)).expect(200)).body.result).toBe("CONFIRMED");
    });

    it("captures a payment that was only authorized before confirming", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        const checkout = razorpay.pay(orderId, "authorized");

        expect((await verify(checkout).expect(200)).body.result).toBe("CONFIRMED");
        expect(razorpay.payments.get(checkout.razorpay_payment_id)!.status).toBe("captured");
    });

    it("only lets you pay for your own, still-held bookings", async () => {
        const pnr = await holdBooking();
        const stranger = (await createUser()).token;
        await createOrder(pnr, stranger).expect(404);
        await api().post("/payments/orders").send({ pnr }).expect(401);

        await expireHolds(minutesFromNow(11));
        await createOrder(pnr).expect(409).expect((r) => expect(r.body.error.code).toBe("HOLD_EXPIRED"));
    });
});

// --------------------------------------------------------------------------- late money

describe("payments that can't be used", () => {
    it("refunds a payment that arrives after the hold was released", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        expect(await expireHolds(minutesFromNow(11))).toBe(1);

        const checkout = razorpay.pay(orderId); // the user finished paying just too late
        const res = await verify(checkout).expect(200);
        expect(res.body.result).toBe("REFUNDED");
        expect(res.body.booking.status).toBe("EXPIRED");
        expect(razorpay.payments.get(checkout.razorpay_payment_id)!.amountRefunded).toBe(res.body.booking.totalFare);

        const [payment] = (await bookingOf(pnr)).payments;
        expect(payment).toMatchObject({ status: "REFUNDED", refundId: expect.stringMatching(/^rfnd_/) });
        // Repeating the verify doesn't refund twice.
        expect((await verify(checkout).expect(200)).body.result).toBe("REFUNDED");
        expect(razorpay.refunds).toBe(1);
    });

    it("refunds the second of two orders paid for the same booking", async () => {
        const pnr = await holdBooking();
        const booking = await bookingOf(pnr);
        // Two orders (e.g. created in the same instant from two tabs), both paid.
        const first = (await createOrder(pnr).expect(201)).body.payment.orderId;
        const second = (await razorpay.createOrder({ amount: booking.totalFare })).id;
        await prisma.payment.create({ data: { bookingId: booking.id, gatewayOrderId: second, amount: booking.totalFare } });

        expect((await verify(razorpay.pay(first)).expect(200)).body.result).toBe("CONFIRMED");
        expect((await verify(razorpay.pay(second)).expect(200)).body.result).toBe("REFUNDED");
        expect((await bookingOf(pnr)).status).toBe("CONFIRMED");
    });

    it("never both confirms and releases: a payment racing the hold expiry ends one way or the other", async () => {
        for (let round = 0; round < 5; round++) {
            const pnr = await holdBooking();
            const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
            const checkout = razorpay.pay(orderId);
            const payment = razorpay.payments.get(checkout.razorpay_payment_id)!;

            const [result] = await Promise.all([settlePayment(payment), expireHolds(minutesFromNow(11))]);
            const booking = await bookingOf(pnr);
            if (result === "CONFIRMED") {
                expect(booking.status).toBe("CONFIRMED");
                expect(booking.passengers[0].allocation).not.toBeNull(); // seats kept
            } else {
                expect(result).toBe("REFUNDED");
                expect(booking.status).toBe("EXPIRED");
                expect(booking.passengers[0].allocation).toBeNull(); // seats released, money returned
            }
        }
    });
});

// --------------------------------------------------------------------------- webhook

describe("POST /payments/webhook", () => {
    it("confirms a booking from a signed webhook, once, however often it's delivered", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        const payment = razorpay.payments.get(razorpay.pay(orderId).razorpay_payment_id)!;

        const eventId = randomUUID();
        expect((await webhook("payment.captured", payment, eventId).expect(200)).body.handled).toBe("processed");
        expect((await bookingOf(pnr)).status).toBe("CONFIRMED");
        expect((await webhook("payment.captured", payment, eventId).expect(200)).body.handled).toBe("duplicate");
        // order.paid for the same payment is a different event, but settles nothing new.
        expect((await webhook("order.paid", payment).expect(200)).body.handled).toBe("processed");
        expect((await bookingOf(pnr)).payments).toMatchObject([{ status: "CAPTURED" }]);
    });

    it("refuses unsigned or forged deliveries and ignores events it doesn't handle", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        const payment = razorpay.payments.get(razorpay.pay(orderId).razorpay_payment_id)!;

        await webhook("payment.captured", payment, randomUUID(), "wrong-secret").expect(400);
        await api().post("/payments/webhook").send({ event: "payment.captured" }).expect(400);
        expect((await bookingOf(pnr)).status).toBe("PENDING_PAYMENT");

        expect((await webhook("refund.created", payment).expect(200)).body.handled).toBe("ignored");
        // Not our order (e.g. another app on the same Razorpay account): acknowledged, nothing changes.
        await webhook("payment.captured", { ...payment, orderId: "order_someoneelse" }).expect(200);
    });

    it("confirms exactly once when verify, the webhook and reconciliation all arrive together", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        const checkout = razorpay.pay(orderId);
        const payment = razorpay.payments.get(checkout.razorpay_payment_id)!;

        await Promise.all([
            verify(checkout).expect(200),
            webhook("payment.captured", payment).expect(200),
            webhook("order.paid", payment).expect(200),
            reconcilePayments(minutesFromNow(2)),
        ]);
        const booking = await bookingOf(pnr);
        expect(booking.status).toBe("CONFIRMED");
        expect(booking.payments).toMatchObject([{ status: "CAPTURED" }]);
        expect(razorpay.refunds).toBe(0);
    });
});

// --------------------------------------------------------------------------- reconciliation and outages

describe("reconciliation and gateway outages", () => {
    it("confirms a paid booking whose verify call and webhook were both lost", async () => {
        const pnr = await holdBooking();
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        razorpay.pay(orderId); // paid, but the browser closed and the webhook never came

        expect(await reconcilePayments(new Date())).toBe(0); // within the grace minute: left to verify/webhook
        expect(await reconcilePayments(minutesFromNow(2))).toBe(1);
        expect((await bookingOf(pnr)).status).toBe("CONFIRMED");
    });

    it("closes orders nobody paid once the hold has expired", async () => {
        const pnr = await holdBooking();
        await createOrder(pnr).expect(201);
        await expireHolds(minutesFromNow(11));

        await reconcilePayments(minutesFromNow(12));
        expect((await bookingOf(pnr)).payments).toMatchObject([{ status: "EXPIRED" }]);
    });

    it("degrades gracefully when Razorpay is down, and catches up afterwards", async () => {
        const pnr = await holdBooking();
        razorpay.down = true;
        const res = await createOrder(pnr).expect(503);
        expect(res.body.error.code).toBe("PAYMENT_GATEWAY_UNAVAILABLE");
        expect(await bookingOf(pnr)).toMatchObject({ status: "PENDING_PAYMENT", payments: [] }); // hold untouched
        razorpay.down = false;

        // A late payment whose refund fails because the gateway goes down mid-way.
        const { orderId } = (await createOrder(pnr).expect(201)).body.payment;
        await expireHolds(minutesFromNow(11));
        const payment = razorpay.payments.get(razorpay.pay(orderId).razorpay_payment_id)!;
        razorpay.down = true;
        expect(await settlePayment(payment)).toBe("REFUND_PENDING");
        expect((await bookingOf(pnr)).payments).toMatchObject([{ status: "REFUND_PENDING" }]);

        // The money is owed, and recorded as owed; the job pays it once Razorpay is back.
        expect(await reconcilePayments(minutesFromNow(12))).toBe(0);
        razorpay.down = false;
        expect(await reconcilePayments(minutesFromNow(13))).toBe(1);
        expect((await bookingOf(pnr)).payments).toMatchObject([{ status: "REFUNDED" }]);
        expect(razorpay.refunds).toBe(1);
    });

    it("answers 503 when payments aren't configured", async () => {
        const pnr = await holdBooking();
        setPaymentGateway(null);
        await createOrder(pnr).expect(503).expect((r) => expect(r.body.error.code).toBe("PAYMENTS_NOT_CONFIGURED"));
    });
});

// --------------------------------------------------------------------------- test mode only

describe("test mode only", () => {
    it("refuses a live Razorpay key at startup", () => {
        const base = { ...testEnv, RAZORPAY_KEY_SECRET: "secret" };
        expect(envSchema.safeParse({ ...base, RAZORPAY_KEY_ID: "rzp_live_abc123" }).success).toBe(false);
        expect(envSchema.safeParse({ ...base, RAZORPAY_KEY_ID: "rzp_test_abc123" }).success).toBe(true);
        // Key id without its secret (or the reverse) is a config mistake, caught at startup too.
        expect(envSchema.safeParse({ ...testEnv, RAZORPAY_KEY_SECRET: undefined }).success).toBe(false);
    });

    it("serves the checkout page with the test key", async () => {
        const page = await api().get("/payments/checkout").expect(200).expect("content-type", /html/);
        expect(page.text).toContain('"rzp_test_fakekeyfortests"');
        expect(page.text).toContain("checkout.razorpay.com/v1/checkout.js");
        expect(page.text).toContain("prefill,");
    });
});
