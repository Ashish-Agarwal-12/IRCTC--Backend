// Prometheus metrics, served at GET /metrics (system.routes.ts). Prometheus scrapes them every 15 s
// and evaluates the alert rules in ops/prometheus/alerts.yml against them, so failures page
// someone before users report them.
//
// Never name a label "job" or "instance": Prometheus adds those itself (the scrape target) and
// would rename ours to "exported_job". Background jobs are labelled "task".
//
// Label rule: only small, fixed sets of values (route templates, status codes, outcomes). Never a
// PNR, user id or raw URL: every distinct label value is a separate time series, and unbounded
// ones would eventually exhaust Prometheus' memory.

import client from "prom-client";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

const registers = [registry];

// --------------------------------------------------------------------------- HTTP

export const httpRequestDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP requests by route template, method and status",
    labelNames: ["method", "route", "status"] as const,
    // Around the targets: 200 ms for search, 2 s for booking.
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers,
});

export const httpErrors = new client.Counter({
    name: "http_errors_total",
    help: "Error responses by error code (VALIDATION_ERROR, REGRET, INTERNAL_ERROR, ...)",
    labelNames: ["code"] as const,
    registers,
});

// --------------------------------------------------------------------------- business

export const bookingsTotal = new client.Counter({
    name: "bookings_total",
    help: "Booking requests that held seats (held) or returned an earlier booking (replayed)",
    labelNames: ["outcome"] as const,
    registers,
});

export const passengersAllotted = new client.Counter({
    name: "passengers_allotted_total",
    help: "Passengers on new bookings, by what they got",
    labelNames: ["status"] as const, // CONFIRMED, RAC, WAITLISTED
    registers,
});

export const passengersPromoted = new client.Counter({
    name: "passengers_promoted_total",
    help: "Passengers moved up by the RAC/WL cascade, by new status",
    labelNames: ["to"] as const, // CONFIRMED, RAC
    registers,
});

export const passengersCancelled = new client.Counter({
    name: "passengers_cancelled_total",
    help: "Passengers taken off a train, by why",
    labelNames: ["reason"] as const, // user, chart
    registers,
});

export const paymentsSettled = new client.Counter({
    name: "payments_settled_total",
    help: "Payment outcomes applied by settlePayment",
    labelNames: ["result"] as const, // CONFIRMED, REFUND_PENDING, REFUNDED, NOT_PAID, UNKNOWN_ORDER
    registers,
});

export const refundsTotal = new client.Counter({
    name: "refunds_total",
    help: "Refund attempts at the gateway",
    labelNames: ["kind", "outcome"] as const, // kind: cancellation, unusable_payment; outcome: processed, failed
    registers,
});

export const emailsTotal = new client.Counter({
    name: "emails_total",
    help: "Outbox email deliveries",
    labelNames: ["type", "outcome"] as const, // outcome: sent, skipped, retry, gave_up
    registers,
});

export const chartsPrepared = new client.Counter({ name: "charts_prepared_total", help: "Charts prepared", registers });

// --------------------------------------------------------------------------- dependencies

export const gatewayRequestDuration = new client.Histogram({
    name: "payment_gateway_request_duration_seconds",
    help: "Calls to Razorpay, by operation and outcome",
    labelNames: ["operation", "outcome"] as const, // outcome: ok, rejected (4xx), unavailable (5xx/timeout/network)
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers,
});

// --------------------------------------------------------------------------- background jobs

export const jobRuns = new client.Counter({
    name: "job_runs_total",
    help: "Background job runs",
    labelNames: ["task", "outcome"] as const, // success, failure
    registers,
});

export const jobDuration = new client.Histogram({
    name: "job_duration_seconds",
    help: "Background job run time",
    labelNames: ["task"] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
    registers,
});

export const jobLastSuccess = new client.Gauge({
    name: "job_last_success_timestamp_seconds",
    help: "When each background job last finished without error (Unix time)",
    labelNames: ["task"] as const,
    registers,
});

// --------------------------------------------------------------------------- backlogs (read at scrape time)

// Things that should drain on their own. If they grow or age, something is stuck: these read the
// database when Prometheus scrapes, so they're always current and survive restarts.
const ageSeconds = (date: Date | undefined) => (date ? (Date.now() - date.getTime()) / 1000 : 0);

async function safely(what: string, fn: () => Promise<void>) {
    try {
        await fn();
    } catch (err) {
        // A database hiccup must not break the whole scrape; the gauge keeps its last value.
        logger.warn({ err, metric: what }, "Couldn't read metric");
    }
}

new client.Gauge({
    name: "outbox_messages",
    help: "Emails in the outbox by status (FAILED needs a human)",
    labelNames: ["status"] as const,
    registers,
    async collect() {
        await safely("outbox_messages", async () => {
            const counts = await prisma.outboxMessage.groupBy({ by: ["status"], where: { status: { in: ["PENDING", "FAILED"] } }, _count: true });
            for (const status of ["PENDING", "FAILED"] as const) {
                this.set({ status }, counts.find((c) => c.status === status)?._count ?? 0);
            }
        });
    },
});

new client.Gauge({
    name: "outbox_oldest_pending_age_seconds",
    help: "Age of the oldest email still waiting to be sent",
    registers,
    async collect() {
        await safely("outbox_oldest_pending_age_seconds", async () => {
            const oldest = await prisma.outboxMessage.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
            this.set(ageSeconds(oldest?.createdAt));
        });
    },
});

new client.Gauge({
    name: "refunds_pending",
    help: "Money owed back to users and not yet issued: cancellation refunds and unusable payments",
    labelNames: ["kind"] as const,
    registers,
    async collect() {
        await safely("refunds_pending", async () => {
            this.set({ kind: "cancellation" }, await prisma.refund.count({ where: { status: "PENDING" } }));
            this.set({ kind: "unusable_payment" }, await prisma.payment.count({ where: { status: "REFUND_PENDING" } }));
        });
    },
});

new client.Gauge({
    name: "refunds_oldest_pending_age_seconds",
    help: "Age of the oldest refund still owed",
    registers,
    async collect() {
        await safely("refunds_oldest_pending_age_seconds", async () => {
            const [refund, payment] = await Promise.all([
                prisma.refund.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
                prisma.payment.findFirst({ where: { status: "REFUND_PENDING" }, orderBy: { updatedAt: "asc" }, select: { updatedAt: true } }),
            ]);
            this.set(Math.max(ageSeconds(refund?.createdAt), ageSeconds(payment?.updatedAt)));
        });
    },
});
