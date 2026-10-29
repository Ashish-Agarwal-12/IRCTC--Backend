import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "./error.js";

export const notFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({
        error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` }
    });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.issues }
        });
        return;
    }
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: { code: err.code, message: err.message, details: err.details }
        });
        return;
    }
    // express.json() throws this when the body isn't valid JSON — the client's fault, not ours.
    if (err?.type === "entity.parse.failed") {
        res.status(400).json({
            error: { code: "INVALID_JSON", message: "Request body is not valid JSON" }
        });
        return;
    }

    // Anything else is a bug or an infrastructure failure. Log the full error (with the
    // request ID pino-http attached) but never leak internals like stack traces to the client.
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Something went wrong", requestId: req.id }
    });
};
