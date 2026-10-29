// Runs `job` every `intervalMs` in this process, for background work like releasing expired holds.
// Returns a function that stops it (used on shutdown).
//
// Every run gets its own log context (job name + runId, see context.ts), is timed and counted in
// the metrics, and records when it last succeeded: GET /health/ready reports a job that has
// stopped succeeding, and the JobStale alert fires on it.

import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { runInContext } from "./context.js";
import { jobDuration, jobLastSuccess, jobRuns } from "./metrics.js";

export interface JobHealth {
    intervalMs: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    startedAt: Date;
}

// Jobs started in this process, by name.
export const jobHealth = new Map<string, JobHealth>();

export async function runJobOnce(name: string, job: () => Promise<number>): Promise<void> {
    const health = jobHealth.get(name);
    const end = jobDuration.startTimer({ task: name });
    await runInContext({ job: name, runId: randomUUID() }, async () => {
        try {
            const count = await job();
            if (count > 0) logger.info({ count }, "Background job did work");
            jobRuns.inc({ task: name, outcome: "success" });
            jobLastSuccess.set({ task: name }, Date.now() / 1000);
            if (health) health.lastSuccessAt = new Date();
        } catch (err) {
            // Never let a failed run crash the server; the next one retries.
            logger.error({ err }, "Background job failed");
            jobRuns.inc({ task: name, outcome: "failure" });
            if (health) health.lastFailureAt = new Date();
        } finally {
            end();
        }
    });
}

export function startIntervalJob(name: string, intervalMs: number, job: () => Promise<number>): () => void {
    jobHealth.set(name, { intervalMs, lastSuccessAt: null, lastFailureAt: null, startedAt: new Date() });
    let running = false;
    const timer = setInterval(async () => {
        if (running) return; // a slow run is still going; don't start a second one on top of it
        running = true;
        try {
            await runJobOnce(name, job);
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref(); // don't keep the process alive just for this timer
    return () => {
        clearInterval(timer);
        jobHealth.delete(name);
    };
}
