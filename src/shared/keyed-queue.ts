// At most `concurrency` callers per key at once, in this process; the rest wait in line in memory.
//
// Why this exists (found by the load tests, load/): bookings for one class of one train serialise
// on a database row lock anyway (inventory.ts). Without a limit, every waiting booking holds one
// of the pool's few database connections while it sits on that lock, so a rush on one train
// took the connections the rest of the API needed: search for other trains went from ~190 ms
// to ~840 ms p95. Waiting here instead costs a promise, not a connection.
//
// Why 2 per class, not 1 (also measured): with 1, each booking only starts its transaction once
// the previous one has committed, adding round trips to every hand-over (500 requests for the
// last seat went from 7 s to 20 s). With 2, the next transaction is already waiting at the row
// lock, so the hand-over is immediate, and a hot train still holds only 2 connections.
//
// This is NOT what makes booking correct: the database lock is, and it still works across
// several server instances. This only keeps each instance from hoarding connections.

import { AppError } from "./error.js";

// Too many already waiting for one key: answer quickly instead of making everyone wait longer.
export class BusyError extends AppError {
    constructor(public readonly retryAfterSeconds: number) {
        super(503, "TRAIN_BUSY", "Too many people are booking this train and class right now. Please try again in a moment.");
    }
}

interface Slots {
    running: number;
    waiting: (() => void)[]; // FIFO: first to arrive is first to run
}

const slots = new Map<string, Slots>();

// Tests only: behave as if every request landed on a different server instance, where this
// in-memory line can't help. The race tests use it so they keep proving the *database* lock.
let separateInstances = false;
export function simulateSeparateInstances(on: boolean): void {
    separateInstances = on;
}

export async function perKey<T>(key: string, limits: { concurrency: number; maxWaiting: number }, fn: () => Promise<T>): Promise<T> {
    if (separateInstances) return fn();
    let entry = slots.get(key);
    if (!entry) slots.set(key, (entry = { running: 0, waiting: [] }));

    if (entry.running < limits.concurrency) {
        entry.running += 1;
    } else {
        if (entry.waiting.length >= limits.maxWaiting) throw new BusyError(1);
        await new Promise<void>((resolve) => entry!.waiting.push(resolve));
        // Woken by a finishing caller, which handed us its slot (running is unchanged).
    }

    try {
        return await fn();
    } finally {
        const next = entry.waiting.shift();
        if (next) {
            next();
        } else {
            entry.running -= 1;
            if (entry.running === 0) slots.delete(key); // nobody left: forget the key
        }
    }
}

// For tests and metrics: callers running or waiting for a key.
export function inFlight(key: string): number {
    const entry = slots.get(key);
    return entry ? entry.running + entry.waiting.length : 0;
}
