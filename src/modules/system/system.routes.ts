import { timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/prisma.js";
import { registry } from "../../shared/metrics.js";
import { jobHealth } from "../../shared/interval-job.js";

export const systemRouter = Router();

// Liveness: the process is up and answering. Says nothing about its dependencies, on purpose:
// a platform restarts the process when this fails, and restarting won't fix a database outage.
systemRouter.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

// Readiness: can this instance serve traffic right now? 503 takes it out of the load balancer
// until the database is back. Background jobs that stopped succeeding are reported as
// "degraded" (still 200: requests can be served, but someone should look; the JobStale alert fires too).
systemRouter.get("/health/ready", async (_req, res) => {
    const started = Date.now();
    let database: { ok: boolean; latencyMs: number; error?: string };
    try {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 2 s")), 2_000).unref()),
        ]);
        database = { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
        database = { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : "unreachable" };
    }

    // A job is stale if it hasn't succeeded for 3 intervals (giving a slow run room before alarming).
    const now = Date.now();
    const jobs = Object.fromEntries([...jobHealth].map(([name, h]) => {
        const since = (h.lastSuccessAt ?? h.startedAt).getTime();
        return [name, { ok: now - since < 3 * h.intervalMs + 5_000, lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt }];
    }));

    const status = !database.ok ? "down" : Object.values(jobs).every((j) => j.ok) ? "ok" : "degraded";
    res.status(database.ok ? 200 : 503).json({ status, checks: { database, jobs } });
});

// Prometheus scrape endpoint. With METRICS_TOKEN set, the scraper must send it as a bearer token;
// without one, metrics are open in development and test but not served at all in production
// (they reveal traffic and business volumes).
const metricsAuth: RequestHandler = (req, res, next) => {
    const token = env.METRICS_TOKEN;
    if (!token) {
        if (env.NODE_ENV === "production") {
            res.status(404).json({ error: { code: "NOT_FOUND", message: "Route GET /metrics not found" } });
            return;
        }
        return next();
    }
    const sent = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(token);
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Send the metrics token as a bearer token" } });
        return;
    }
    next();
};

systemRouter.get("/metrics", metricsAuth, async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
});

// Mounted under /admin: a cheap way to check that a token has admin rights.
export const adminSystemRouter = Router();
adminSystemRouter.get("/ping", (_req, res) => {
    res.json({ status: "ok", admin: true });
});
