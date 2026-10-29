import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/shared/middleware/rate-limit.js";

describe("createRateLimiter", () => {
    it("allows `limit` requests per window, then answers 429", async () => {
        // A tiny throwaway app, so this test doesn't depend on any real route.
        const app = express();
        app.get("/", createRateLimiter(2, 60_000, { skip: false }), (_req, res) => { res.send("ok"); });

        await request(app).get("/").expect(200);
        await request(app).get("/").expect(200);
        const blocked = await request(app).get("/").expect(429);
        expect(blocked.body.error.code).toBe("RATE_LIMITED");
        expect(blocked.headers["retry-after"]).toBeDefined();
    });
});
