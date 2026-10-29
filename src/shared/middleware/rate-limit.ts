import { rateLimit } from "express-rate-limit";

// Limits requests per client IP. Counters live in this process's memory for now, which is fine
// for one server; with several instances they must move to Redis so all instances share counts.
// Behind a load balancer, also set `app.set("trust proxy", 1)` or every user shares the proxy's IP.
export function createRateLimiter(limit: number, windowMs: number) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-8", // tells clients their remaining quota via RateLimit-* headers
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json({
                error: { code: "RATE_LIMITED", message: "Too many requests, please try again later" }
            });
        },
    });
}
