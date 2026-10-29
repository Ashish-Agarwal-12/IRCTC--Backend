// One shared logger for the whole app. HTTP request logs, startup logs and (later) background
// job logs all go through it, so they share the same format and redaction rules.

import { pino } from "pino";
import { env } from "../config/env.js";
import { logFields } from "./context.js";

export const logger = pino({
    level: env.NODE_ENV === "test" ? "silent" : "info",
    // Every line gets the current requestId / traceId (HTTP) or job / runId (background jobs).
    mixin: logFields,
    // Requirement: never log PII. Strip credentials and contact details even if they end up in a log call.
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            // Browsers send the previous page's full URL as the referer, which can contain a token.
            "req.headers.referer",
            "req.query.token",
            "*.password",
            "*.passwordHash",
            "*.token",
            "*.refreshToken",
            "*.email",
            "*.phone",
        ],
        censor: "[REDACTED]",
    },
    // Pretty, coloured output for humans in dev; plain JSON elsewhere so log tooling can parse it.
    transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

// `redact` works on object paths, but a URL is one string, so "?token=abc" inside it needs a regex.
// Email links put the token after "#" (which browsers never send), but old links or hand-typed URLs
// might still use "?token=", and those must not end up in the logs either.
export function redactUrl(url: string): string {
    return url.replace(/([?&]token=)[^&#]*/gi, "$1[REDACTED]");
}
