import type { RequestHandler } from "express";
import type { Role } from "../../generated/prisma/client.js";
import { verifyAccessToken } from "../../modules/auth/tokens.js";
import { ForbiddenError, UnauthorizedError } from "../error.js";

// Reads `Authorization: Bearer <jwt>`, verifies it, and puts the user on `req.user`.
// Throwing inside middleware is fine: Express passes the error to our error handler.
export const authenticate: RequestHandler = (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        throw new UnauthorizedError("Missing access token");
    }

    try {
        const payload = verifyAccessToken(header.slice("Bearer ".length));
        req.user = { id: payload.sub, role: payload.role };
    } catch {
        throw new UnauthorizedError("Invalid or expired access token");
    }
    next();
};

// Usage: router.get("/admin/x", authenticate, requireRole("ADMIN"), handler)
// A function that returns middleware, so each route can say which roles it allows.
export function requireRole(...roles: Role[]): RequestHandler {
    return (req, _res, next) => {
        if (!req.user) {
            throw new UnauthorizedError();
        }
        if (!roles.includes(req.user.role)) {
            throw new ForbiddenError();
        }
        next();
    };
}
