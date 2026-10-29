import { randomUUID } from "node:crypto";
import express from "express";
import { pinoHttp } from "pino-http";
import { logger, redactUrl } from "./shared/logger.js";
import { errorHandler, notFoundHandler } from "./shared/error-handler.js";
import { authenticate, requireRole } from "./shared/middleware/authenticate.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { authPagesRouter } from "./modules/auth/auth.pages.js";

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
        serializers: {
            // pino-http hands us its already-serialized request object; scrub the URL before it's logged.
            req(req) {
                req.url = redactUrl(req.url);
                return req;
            },
        },
    }));
    app.use(express.json());

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/auth", authRouter);
    app.use(authPagesRouter); // GET /verify-email and /reset-password, opened from email links

    // Placeholder admin route to prove role checks work; real admin routes arrive with the catalog.
    app.get("/admin/ping", authenticate, requireRole("ADMIN"), (_req, res) => {
        res.json({ status: "ok", admin: true });
    });

    // Must be registered after every route: the 404 catches anything unmatched,
    // and the error handler (4 args) catches anything thrown or passed to next(err).
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
