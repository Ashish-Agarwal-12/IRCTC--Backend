// Contract checking: every response any test receives is compared with the API docs.
//
// The test app is wrapped in an outer Express app whose middleware watches each response go out.
// When it finishes, we look up the documented operation for that method + path and check:
//   - the status code is one the docs list for that operation;
//   - the JSON body parses against the documented (strict) response schema.
// Problems are collected and reported by the afterEach hook in test/setup.ts, so a test fails if
// the API does something the docs don't describe, even if the test itself didn't check for it.

import express, { type Express } from "express";
import { z } from "zod";
import { operations, responsesFor, type Operation } from "../src/docs/operations.js";

export const contractViolations: string[] = [];

// "/admin/stations/{id}" → /^\/admin\/stations\/[^/]+$/
const matchers = operations.map((op) => ({
    op,
    regex: new RegExp("^" + op.path.replace(/\{[^}]+\}/g, "[^/]+") + "$"),
}));

function findOperation(method: string, path: string): Operation | undefined {
    return matchers.find((m) => m.op.method === method && m.regex.test(path))?.op;
}

export function withContractChecks(app: Express): Express {
    const outer = express();
    outer.use((req, res, next) => {
        let body: unknown;
        const originalJson = res.json.bind(res);
        res.json = (value: unknown) => {
            // Round-trip through JSON so we check what the client actually receives (Dates become strings).
            body = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
            return originalJson(value);
        };

        res.on("finish", () => {
            const method = req.method.toLowerCase();
            const path = new URL(req.originalUrl, "http://test").pathname.replace(/\/$/, "") || "/";
            const where = `${req.method} ${path} → ${res.statusCode}`;

            // The docs UI itself isn't part of the API.
            if (path === "/openapi.json" || path.startsWith("/docs")) return;

            const op = findOperation(method, path);
            if (!op) {
                // Tests may deliberately call routes that don't exist; the generic 404 is fine.
                const isGeneric404 = res.statusCode === 404 && (body as { error?: { message?: string } })?.error?.message?.startsWith("Route ");
                if (!isGeneric404) contractViolations.push(`${where}: no documented operation for this route`);
                return;
            }

            const documented = responsesFor(op)[res.statusCode];
            if (!documented) {
                contractViolations.push(`${where}: status ${res.statusCode} is not documented for ${op.method.toUpperCase()} ${op.path}`);
                return;
            }
            if (documented.html) return;
            if (!documented.schema) {
                if (body !== undefined) contractViolations.push(`${where}: documented as having no body, but sent one`);
                return;
            }
            const result = documented.schema.safeParse(body);
            if (!result.success) {
                contractViolations.push(`${where}: body doesn't match the documented schema\n${z.prettifyError(result.error)}`);
            }
        });
        next();
    });
    outer.use(app);
    return outer;
}
