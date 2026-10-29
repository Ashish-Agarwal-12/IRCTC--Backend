import { randomUUID } from "node:crypto";
import express from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./shared/logger.js";
import { errorHandler, notFoundHandler } from "./shared/error-handler.js";

export function buildApp() {
    const app = express();

    app.use(pinoHttp({
        logger,
        // Reuse the caller's request ID (e.g. from a load balancer) or mint one, and echo it back
        // so a user-reported failure can be matched to its exact log lines.
        genReqId: (req, res) => {
            const incoming = req.headers["x-request-id"];
            const id = typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128
                ? incoming
                : randomUUID();
            res.setHeader("x-request-id", id);
            return id;
        },
    }));
    app.use(express.json());

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    // Must be registered after every route: the 404 catches anything unmatched,
    // and the error handler (4 args) catches anything thrown or passed to next(err).
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
