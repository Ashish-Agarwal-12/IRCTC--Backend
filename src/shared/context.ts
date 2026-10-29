// "Which request (or which background job run) is this code running for?"
//
// AsyncLocalStorage keeps a value that follows the code through every await, callback and timer
// started from inside `run()`, without passing it down as an argument. The logger reads it on
// every line (see logger.ts), so a warning logged deep inside the payment service carries the
// requestId of the HTTP request that caused it, and a refund retried by the reconciliation job
// carries that job run's runId. One id, grep the logs, see everything that happened.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";

export interface Context {
    requestId?: string;
    // W3C Trace Context (the `traceparent` header): lets logs here be joined with the caller's,
    // e.g. a load balancer or frontend that already started a trace.
    traceId?: string;
    job?: string;
    runId?: string;
}

const storage = new AsyncLocalStorage<Context>();

export const currentContext = (): Context | undefined => storage.getStore();

export function runInContext<T>(context: Context, fn: () => T): T {
    return storage.run(context, fn);
}

// traceparent: version-traceid-parentid-flags, e.g. 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE = "0".repeat(32);

export function traceIdFrom(header: unknown): string | null {
    if (typeof header !== "string") return null;
    const match = TRACEPARENT.exec(header.trim());
    return match && match[1] !== ALL_ZERO_TRACE ? match[1] : null;
}

// Registered right after pino-http (which assigns req.id). Everything after it in the chain,
// including the route handler and all the services it awaits, runs inside this context.
export const requestContext: RequestHandler = (req, res, next) => {
    const traceId = traceIdFrom(req.headers.traceparent) ?? randomBytes(16).toString("hex");
    // Continue the trace: same trace id, a new span id for our part of it.
    res.setHeader("traceparent", `00-${traceId}-${randomBytes(8).toString("hex")}-01`);
    runInContext({ requestId: String(req.id), traceId }, next);
};

// Fields the logger adds to every line. Always a fresh copy: pino merges each log call's own
// fields into the object returned here, so returning the stored context itself would leak, say,
// one warning's userId into every later log line of that request.
export function logFields(): Context {
    return { ...currentContext() };
}
