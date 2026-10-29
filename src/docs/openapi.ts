// Builds the OpenAPI 3.1 document from the operation list. zod-openapi converts each Zod schema to
// JSON Schema: request schemas use their *input* shape (e.g. departureTime is the "HH:mm" string
// clients send, not the number it's transformed into), response schemas their output shape.

import { createDocument, type ZodOpenApiPathsObject } from "zod-openapi";
import { operations, responsesFor } from "./operations.js";

export function buildOpenApiDocument() {
    const paths: ZodOpenApiPathsObject = {};

    for (const op of operations) {
        const responses = Object.fromEntries(
            Object.entries(responsesFor(op)).map(([status, r]) => [
                status,
                {
                    description: r.description,
                    ...(r.schema && { content: { "application/json": { schema: r.schema } } }),
                    ...(r.html && { content: { "text/html": { schema: { type: "string" as const } } } }),
                    ...(r.pdf && { content: { "application/pdf": { schema: { type: "string" as const, format: "binary" } } } }),
                },
            ]),
        );

        paths[op.path] ??= {};
        paths[op.path][op.method] = {
            tags: [op.tag],
            summary: op.summary,
            description: op.description,
            ...(op.auth && { security: [{ bearerAuth: [] }] }),
            // Only include the keys that exist: zod-openapi rejects `query: undefined`.
            ...((op.query || op.params || op.headers) && {
                requestParams: {
                    ...(op.query && { query: op.query }),
                    ...(op.params && { path: op.params }),
                    ...(op.headers && { header: op.headers }),
                },
            }),
            ...(op.body && { requestBody: { required: true, content: { "application/json": { schema: op.body } } } }),
            responses,
        };
    }

    return createDocument({
        openapi: "3.1.0",
        info: {
            title: "IRCTC Backend API",
            version: "0.5.0",
            description:
                "Train reservation API. To call protected endpoints: log in via **POST /auth/login**, copy " +
                "`accessToken`, click **Authorize** and paste it. Admin endpoints need the seeded admin " +
                "account (`npx prisma db seed`). Every error has the shape `{ error: { code, message, details? } }`.",
        },
        tags: [
            { name: "System" },
            { name: "Auth", description: "Accounts, sessions, email verification and password reset" },
            { name: "Email-link pages", description: "HTML pages opened from links in emails" },
            { name: "Stations" },
            { name: "Trains" },
            { name: "Bookings", description: "Seat holds (10 minutes, pending payment), your bookings and PNR status" },
            { name: "Payments", description: "Razorpay, **test mode only**: no real money moves" },
            { name: "Admin" },
            { name: "Admin: stations" },
            { name: "Admin: trains", description: "Typical order: create train → route → coaches → schedules" },
        ],
        components: {
            securitySchemes: {
                bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            },
        },
        paths,
    });
}
