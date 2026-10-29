import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { logger, redactUrl } from "./shared/logger.js";
import { errorHandler, notFoundHandler } from "./shared/error-handler.js";
import { authenticate, requireRole } from "./shared/middleware/authenticate.js";
import { buildOpenApiDocument } from "./docs/openapi.js";
import { adminSystemRouter, systemRouter } from "./modules/system/system.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { authPagesRouter } from "./modules/auth/auth.pages.js";
import { adminStationsRouter, stationsRouter } from "./modules/stations/stations.routes.js";
import { adminTrainsRouter, trainsRouter } from "./modules/trains/trains.routes.js";
import { bookingsRouter } from "./modules/bookings/bookings.routes.js";
import { paymentsRouter } from "./modules/payments/payments.routes.js";

// Where each router is mounted. Kept as data (rather than a list of app.use calls) so the
// route-coverage test can list every real route and compare it with the API docs: Express 5
// doesn't remember mount paths, so this table is the only place they're written down.
export const publicMounts: { path: string; router: Router }[] = [
    { path: "/", router: systemRouter },
    { path: "/auth", router: authRouter },
    { path: "/", router: authPagesRouter }, // GET /verify-email and /reset-password, opened from email links
    { path: "/stations", router: stationsRouter },
    { path: "/trains", router: trainsRouter },
    { path: "/bookings", router: bookingsRouter }, // all routes need a logged-in user (see bookings.routes.ts)
    { path: "/payments", router: paymentsRouter }, // Razorpay, test mode only
];

// Everything in here sits behind one admin guard (see buildApp), so no admin route can
// accidentally be left unprotected.
export const adminMounts: { path: string; router: Router }[] = [
    { path: "/", router: adminSystemRouter },
    { path: "/stations", router: adminStationsRouter },
    { path: "/trains", router: adminTrainsRouter },
];

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
    app.use(express.json({
        // Keep the raw bytes for the payment webhook, whose signature is over the body exactly as sent.
        verify: (req, _res, buf) => {
            if (req.url === "/payments/webhook") (req as express.Request).rawBody = buf;
        },
    }));

    // API docs: the raw OpenAPI document, and Swagger UI to read it and try requests.
    // Not exposed in production, where the API's shape is nobody else's business by default.
    if (env.NODE_ENV !== "production") {
        const openApiDocument = buildOpenApiDocument();
        app.get("/openapi.json", (_req, res) => {
            res.json(openApiDocument);
        });
        app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument, {
            customSiteTitle: "IRCTC API docs",
            swaggerOptions: { persistAuthorization: true }, // keep the pasted token across page reloads
        }));
    }

    for (const { path, router } of publicMounts) {
        app.use(path, router);
    }

    const admin = Router();
    admin.use(authenticate, requireRole("ADMIN"));
    for (const { path, router } of adminMounts) {
        admin.use(path, router);
    }
    app.use("/admin", admin);

    // Must be registered after every route: the 404 catches anything unmatched,
    // and the error handler (4 args) catches anything thrown or passed to next(err).
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
