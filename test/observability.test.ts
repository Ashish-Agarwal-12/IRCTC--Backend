import { randomUUID } from "node:crypto";
import express from "express";
import { pino } from "pino";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { prisma } from "../src/shared/prisma.js";
import { currentContext, logFields, requestContext, runInContext, traceIdFrom } from "../src/shared/context.js";
import { registry } from "../src/shared/metrics.js";
import { jobHealth, runJobOnce, startIntervalJob } from "../src/shared/interval-job.js";
import { GatewayRejectedError, GatewayUnavailableError, razorpayGateway } from "../src/modules/payments/gateway.js";
import { api, bearer, createUser, resetDb } from "./helpers.js";
import { createScheduledTrain, isoDate, search } from "./fixtures.js";

// One value of one metric, e.g. value("http_request_duration_seconds_count", { route: "/health" }).
async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name.replace(/_(count|sum|bucket)$/, ""));
    const wanted = (m: { labels: Record<string, string | number>; metricName?: string }) =>
        (m.metricName ?? metric!.name) === name && Object.entries(labels).every(([k, v]) => String(m.labels[k]) === v);
    return (metric?.values ?? []).filter(wanted).reduce((sum, v) => sum + v.value, 0);
}

beforeEach(async () => {
    await resetDb();
});

// --------------------------------------------------------------------------- request context

describe("request context", () => {
    it("follows a request through every await, so every log line can carry its ids", async () => {
        const seen: unknown[] = [];
        const app = express();
        app.use((req, _res, next) => { (req as { id?: string }).id = "req-123"; next(); });
        app.use(requestContext);
        app.get("/", async (_req, res) => {
            await new Promise((r) => setTimeout(r, 5));
            await Promise.resolve();
            seen.push(logFields()); // what the logger's mixin adds to a line logged here
            res.json({});
        });

        const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        const res = await request(app).get("/").set("traceparent", `00-${traceId}-00f067aa0ba902b7-01`).expect(200);
        expect(seen).toEqual([{ requestId: "req-123", traceId }]);
        // The trace continues: same trace id, a new span id for our part.
        expect(res.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
        expect(currentContext()).toBeUndefined(); // nothing leaks outside the request
    });

    it("adds the ids to real log lines without one line's fields leaking into the next", () => {
        const lines: Record<string, unknown>[] = [];
        const log = pino({ mixin: logFields }, { write: (line: string) => void lines.push(JSON.parse(line)) });
        runInContext({ requestId: "req-1" }, () => {
            log.warn({ userId: "u-1" }, "Refresh token reuse detected");
            log.info("request completed");
        });
        expect(lines[0]).toMatchObject({ requestId: "req-1", userId: "u-1" });
        expect(lines[1]).toMatchObject({ requestId: "req-1" });
        expect(lines[1]).not.toHaveProperty("userId");
    });

    it("accepts only well-formed W3C traceparent headers", () => {
        expect(traceIdFrom("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(traceIdFrom("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull(); // all-zero is invalid
        expect(traceIdFrom("garbage")).toBeNull();
        expect(traceIdFrom(undefined)).toBeNull();
    });

    it("gives every background job run its own job name and run id", async () => {
        const seen: unknown[] = [];
        await runJobOnce("test-job", async () => { seen.push(logFields()); return 0; });
        await runJobOnce("test-job", async () => { seen.push(logFields()); return 0; });
        expect(seen).toEqual([
            { job: "test-job", runId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
            { job: "test-job", runId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
        ]);
        expect((seen[0] as { runId: string }).runId).not.toBe((seen[1] as { runId: string }).runId);
        expect(runInContext({ requestId: "x" }, () => logFields())).toEqual({ requestId: "x" });
    });
});

// --------------------------------------------------------------------------- metrics

describe("GET /metrics", () => {
    it("times requests by route template, never by raw URL", async () => {
        const { token } = await createUser();
        await api().get("/health").expect(200);
        await api().get("/bookings/1234567890").set(bearer(token)).expect(404);
        await api().get("/no/such/route").expect(404);
        await api().get("/bookings/1234567890").expect(401); // refused by the router's login check

        const res = await api().get("/metrics").expect(200);
        expect(res.headers["content-type"]).toContain("text/plain");
        expect(res.text).toContain('http_request_duration_seconds_count{method="GET",route="/health",status="200"}');
        expect(res.text).toContain('route="/bookings/:pnr",status="404"');
        expect(res.text).not.toContain("1234567890"); // no PNRs in labels
        expect(res.text).toContain('route="unmatched"');
        expect(res.text).toContain('route="/bookings/*",status="401"');
        expect(res.text).toContain("process_cpu_seconds_total"); // default process metrics
    });

    it("counts business events and error codes", async () => {
        await createScheduledTrain();
        const { token } = await createUser();
        const scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
        const before = await value("bookings_total", { outcome: "held" });
        const replayedBefore = await value("bookings_total", { outcome: "replayed" });
        const regretBefore = await value("http_errors_total", { code: "VALIDATION_ERROR" });

        const key = randomUUID();
        const body = { scheduleId, from: "NDLS", to: "MMCT", class: "AC3", passengers: [{ name: "Asha Kumar", age: 35, gender: "FEMALE" }], contactPhone: "9876543210" };
        await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", key).send(body).expect(201);
        await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", key).send(body).expect(200);
        await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", randomUUID()).send({}).expect(400);

        expect(await value("bookings_total", { outcome: "held" })).toBe(before + 1);
        expect(await value("bookings_total", { outcome: "replayed" })).toBe(replayedBefore + 1);
        expect(await value("passengers_allotted_total", { status: "CONFIRMED" })).toBeGreaterThanOrEqual(1);
        expect(await value("http_errors_total", { code: "VALIDATION_ERROR" })).toBe(regretBefore + 1);
    });

    it("reports backlogs from the database at scrape time", async () => {
        await createScheduledTrain();
        const { token } = await createUser();
        const scheduleId = (await search("NDLS", "MMCT", isoDate(3)).expect(200)).body.trains[0].scheduleId;
        const res = await api().post("/bookings").set(bearer(token)).set("Idempotency-Key", randomUUID()).send({
            scheduleId, from: "NDLS", to: "MMCT", class: "AC3", passengers: [{ name: "Asha Kumar", age: 35, gender: "FEMALE" }], contactPhone: "9876543210",
        }).expect(201);
        const booking = await prisma.booking.findUniqueOrThrow({ where: { pnr: res.body.booking.pnr } });
        await prisma.outboxMessage.create({ data: { type: "BOOKING_CONFIRMED", bookingId: booking.id, createdAt: new Date(Date.now() - 15 * 60_000) } });
        await prisma.outboxMessage.create({ data: { type: "BOOKING_CONFIRMED", bookingId: booking.id, status: "FAILED" } });

        const text = (await api().get("/metrics").expect(200)).text;
        expect(text).toContain('outbox_messages{status="PENDING"} 1');
        expect(text).toContain('outbox_messages{status="FAILED"} 1');
        const age = Number(/^outbox_oldest_pending_age_seconds (\S+)$/m.exec(text)![1]);
        expect(age).toBeGreaterThan(14 * 60); // this is what the EmailBacklog alert watches
        expect(text).toContain('refunds_pending{kind="cancellation"} 0');
    });

    it("requires the metrics token when one is set", async () => {
        const mutableEnv = env as { METRICS_TOKEN?: string };
        mutableEnv.METRICS_TOKEN = "a-metrics-token-for-tests";
        try {
            await api().get("/metrics").expect(401);
            await api().get("/metrics").set("Authorization", "Bearer wrong-token-of-same-size!").expect(401);
            await api().get("/metrics").set("Authorization", "Bearer a-metrics-token-for-tests").expect(200);
        } finally {
            delete mutableEnv.METRICS_TOKEN;
        }
    });
});

// --------------------------------------------------------------------------- jobs and readiness

describe("job health and readiness", () => {
    afterEach(() => jobHealth.clear());

    it("counts job runs, failures and the last success", async () => {
        const failuresBefore = await value("job_runs_total", { task: "flaky", outcome: "failure" });
        await runJobOnce("flaky", async () => { throw new Error("boom"); });
        await runJobOnce("flaky", async () => 1);
        expect(await value("job_runs_total", { task: "flaky", outcome: "failure" })).toBe(failuresBefore + 1);
        const lastSuccess = await value("job_last_success_timestamp_seconds", { task: "flaky" });
        expect(Date.now() / 1000 - lastSuccess).toBeLessThan(5);
    });

    it("reports the database and every running job", async () => {
        const stop = startIntervalJob("quick", 20, async () => 0);
        await new Promise((r) => setTimeout(r, 80));
        const res = await api().get("/health/ready").expect(200);
        stop();
        expect(res.body).toMatchObject({ status: "ok", checks: { database: { ok: true }, jobs: { quick: { ok: true, lastSuccessAt: expect.any(String) } } } });
    });

    it("says degraded when a job has stopped succeeding", async () => {
        const stop = startIntervalJob("stuck", 10, async () => { throw new Error("always fails"); });
        jobHealth.get("stuck")!.startedAt = new Date(Date.now() - 60_000); // started a minute ago, never succeeded
        await new Promise((r) => setTimeout(r, 40));
        const res = await api().get("/health/ready").expect(200);
        stop();
        expect(res.body.status).toBe("degraded");
        expect(res.body.checks.jobs.stuck).toMatchObject({ ok: false, lastSuccessAt: null, lastFailureAt: expect.any(String) });
    });
});

// --------------------------------------------------------------------------- the real Razorpay client

describe("Razorpay client (against a stubbed fetch)", () => {
    afterEach(() => vi.unstubAllGlobals());
    const gateway = () => razorpayGateway("rzp_test_x", "secret");

    it("times every call and sorts failures into rejected and unavailable", async () => {
        const ok = await value("payment_gateway_request_duration_seconds_count", { operation: "create_order", outcome: "ok" });
        const rejected = await value("payment_gateway_request_duration_seconds_count", { operation: "refund", outcome: "rejected" });
        const down = await value("payment_gateway_request_duration_seconds_count", { operation: "fetch_payment", outcome: "unavailable" });

        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: "order_abc" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: { description: "fully refunded already" } }), { status: 400 }))
            .mockResolvedValueOnce(new Response("", { status: 502 }));
        vi.stubGlobal("fetch", fetch);

        expect(await gateway().createOrder({ amount: 100, receipt: "1", notes: {} })).toEqual({ id: "order_abc" });
        await expect(gateway().refundPayment("pay_1", { amount: 100 })).rejects.toBeInstanceOf(GatewayRejectedError);
        await expect(gateway().fetchPayment("pay_1")).rejects.toBeInstanceOf(GatewayUnavailableError);

        // Basic auth, JSON body, and ids URL-encoded into the path.
        expect(fetch.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/orders");
        expect(fetch.mock.calls[0][1].headers.authorization).toBe("Basic " + Buffer.from("rzp_test_x:secret").toString("base64"));
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ amount: 100 });

        expect(await value("payment_gateway_request_duration_seconds_count", { operation: "create_order", outcome: "ok" })).toBe(ok + 1);
        expect(await value("payment_gateway_request_duration_seconds_count", { operation: "refund", outcome: "rejected" })).toBe(rejected + 1);
        expect(await value("payment_gateway_request_duration_seconds_count", { operation: "fetch_payment", outcome: "unavailable" })).toBe(down + 1);
    });
});
