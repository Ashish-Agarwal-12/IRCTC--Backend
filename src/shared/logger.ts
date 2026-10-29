// One shared logger for the whole app. HTTP request logs, startup logs and (later) background
// job logs all go through it, so they share the same format and redaction rules.

import { pino } from "pino";
import { env } from "../config/env.js";

export const logger = pino({
    level: env.NODE_ENV === "test" ? "silent" : "info",
    // Requirement: never log PII. Strip credentials and contact details even if they end up in a log call.
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
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
