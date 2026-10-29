import { rateLimit } from "express-rate-limit";
import { env } from "../../config/env.js";

// Limits requests per client IP. Counters live in this process's memory for now, which is fine
// for one server; with several instances they must move to Redis so all instances share counts.
// Behind a load balancer, also set `app.set("trust proxy", 1)` or every user shares the proxy's IP.
//
// Disabled by default under NODE_ENV=test: every test request comes from the same IP, so the
// limits would trip mid-suite. The limiter's own test passes `{ skip: false }` to switch it on.
export function createRateLimiter(limit: number, windowMs: number, opts: { skip?: boolean } = {}) {
    const skip = opts.skip ?? env.NODE_ENV === "test";
    return rateLimit({
        windowMs,
        limit,
        skip: () => skip,
        standardHeaders: "draft-8", // tells clients their remaining quota via RateLimit-* headers
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json({
                error: { code: "RATE_LIMITED", message: "Too many requests, please try again later" }
            });
        },
    });
}
