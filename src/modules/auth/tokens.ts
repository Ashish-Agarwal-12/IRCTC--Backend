import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { Role } from "../../generated/prisma/client.js";

export interface AccessTokenPayload {
    sub: string; // "subject": the user ID (standard JWT claim name)
    role: Role;
}

// Access token: a signed JWT. The server can check it without a database lookup, which is why
// it must be short-lived: it can't be revoked before it expires.
export function signAccessToken(user: { id: string; role: Role }): string {
    return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
        subject: user.id,
        expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60, // seconds
        algorithm: "HS256",
    });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
    // Pin the algorithm: never let the token's own header choose how it gets verified.
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || !Object.values(Role).includes(payload.role)) {
        throw new Error("Malformed access token");
    }
    return { sub: payload.sub, role: payload.role };
}

// Refresh, email-verification and password-reset tokens are opaque random strings, not JWTs:
// they're always checked against the database anyway, so a signature would add nothing.
// 32 random bytes = 256 bits, impossible to guess.
export function generateOpaqueToken(): string {
    return randomBytes(32).toString("base64url");
}

// We store only a hash, so a leaked database doesn't hand out working tokens. A fast SHA-256 is
// enough here (unlike passwords) because the input is already 256 random bits: there's nothing
// to brute-force. And being deterministic, it lets us look a token up by its hash.
export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}
