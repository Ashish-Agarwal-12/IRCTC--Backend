// Runs `job` every `intervalMs` in this process, for background work like releasing expired holds.
// Returns a function that stops it (used on shutdown).

import { logger } from "./logger.js";

export function startIntervalJob(name: string, intervalMs: number, job: () => Promise<number>): () => void {
    let running = false;
    const timer = setInterval(async () => {
        if (running) return; // a slow run is still going; don't start a second one on top of it
        running = true;
        try {
            const count = await job();
            if (count > 0) logger.info({ job: name, count }, "Background job did work");
        } catch (err) {
            // Never let a failed run crash the server; the next one retries.
            logger.error({ err, job: name }, "Background job failed");
        } finally {
            running = false;
        }
    }, intervalMs);
    timer.unref(); // don't keep the process alive just for this timer
    return () => clearInterval(timer);
}
