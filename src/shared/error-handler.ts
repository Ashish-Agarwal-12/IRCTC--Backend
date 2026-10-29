import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "./error.js";
import { httpErrors } from "./metrics.js";

export const notFoundHandler: RequestHandler = (req, res) => {
    httpErrors.inc({ code: "NOT_FOUND" });
    res.status(404).json({
        error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` }
    });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
        httpErrors.inc({ code: "VALIDATION_ERROR" });
        res.status(400).json({
            error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.issues }
        });
        return;
    }
    if (err instanceof AppError) {
        httpErrors.inc({ code: err.code });
        // 503 TRAIN_BUSY: tell well-behaved clients when to try again.
        if ("retryAfterSeconds" in err) res.setHeader("Retry-After", String(err.retryAfterSeconds));
        res.status(err.statusCode).json({
            error: { code: err.code, message: err.message, details: err.details }
        });
        return;
    }
    // express.json() throws this when the body isn't valid JSON — the client's fault, not ours.
    if (err?.type === "entity.parse.failed") {
        httpErrors.inc({ code: "INVALID_JSON" });
        res.status(400).json({
            error: { code: "INVALID_JSON", message: "Request body is not valid JSON" }
        });
        return;
    }

    // Anything else is a bug or an infrastructure failure. Log the full error (with the
    // request ID pino-http attached) but never leak internals like stack traces to the client.
    req.log.error({ err }, "Unhandled error");
    httpErrors.inc({ code: "INTERNAL_ERROR" });
    res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId: req.id }
    });
};
