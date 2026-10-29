// Business logic for authentication. Nothing in this file knows about Express (no req/res), so it
// can be called from HTTP handlers, tests, scripts or background jobs alike.

import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { Prisma, type Role, type TokenPurpose } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/prisma.js";
import { logger } from "../../shared/logger.js";
import { sendMail } from "../../shared/mailer.js";
import {
    BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError,
} from "../../shared/error.js";
import { generateOpaqueToken, hashToken, signAccessToken } from "./tokens.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

// Used by login when the email doesn't exist, so that path still spends the same ~50 ms in argon2
// as a real password check. Otherwise response time would reveal which emails are registered.
const dummyHashPromise = argon2.hash("dummy-password-for-timing");

// A transaction client and the normal client have the same model API; this type accepts either.
type Db = Prisma.TransactionClient;

export interface Session {
    accessToken: string;
    refreshToken: string;
    expiresIn: number; // access token lifetime in seconds
}

// ---------------------------------------------------------------- register / verify email

export async function register(input: RegisterInput) {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    let user;
    try {
        user = await prisma.user.create({
            data: {
                email: input.email,
                phone: input.phone,
                passwordHash,
                firstName: input.firstName,
                lastName: input.lastName,
            },
        });
    } catch (err) {
        // Let the unique index decide, instead of "check if email exists, then insert":
        // two simultaneous sign-ups could both pass the check. P2002 = unique constraint violated.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new ConflictError("An account with this email or phone already exists");
        }
        throw err;
    }

    await sendVerificationEmail(user.id, user.email);
    return toPublicUser(user);
}

export async function verifyEmail(token: string): Promise<void> {
    // One transaction: marking the token used and verifying the user happen together or not at all.
    await prisma.$transaction(async (tx) => {
        const record = await consumeVerificationToken(tx, token, "EMAIL_VERIFY");
        await tx.user.update({ where: { id: record.userId }, data: { isEmailVerified: true } });
    });
}

// Always succeeds from the caller's point of view, so it can't be used to probe which emails exist.
export async function resendVerification(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.isEmailVerified) {
        await sendVerificationEmail(user.id, user.email);
    }
}

// ---------------------------------------------------------------- login / refresh / logout

export async function login(input: LoginInput): Promise<Session> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    const passwordOk = await argon2.verify(user?.passwordHash ?? await dummyHashPromise, input.password);

    // Same error for "no such email" and "wrong password": don't tell attackers which one it was.
    if (!user || !passwordOk) {
        throw new UnauthorizedError("Invalid email or password");
    }
    if (!user.isEmailVerified) {
        throw new ForbiddenError("Please verify your email before logging in", "EMAIL_NOT_VERIFIED");
    }

    // A new login starts a new token family.
    return createSession(prisma, user, randomUUID());
}

export async function refresh(refreshToken: string): Promise<Session> {
    const existing = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
        include: { user: true },
    });

    if (!existing || existing.expiresAt <= new Date()) {
        throw new UnauthorizedError("Invalid or expired refresh token");
    }

    // A revoked token being presented again means two parties hold it: the real user, who already
    // rotated it, and whoever stole it. We can't tell which one this is, so end the whole session.
    if (existing.revokedAt) {
        await prisma.refreshToken.updateMany({
            where: { familyId: existing.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        logger.warn({ userId: existing.userId, familyId: existing.familyId }, "Refresh token reuse detected");
        throw new UnauthorizedError("Invalid or expired refresh token");
    }

    return prisma.$transaction(async (tx) => {
        const newTokenId = randomUUID();

        // The "revokedAt: null" condition is what makes this safe under concurrency. If two requests
        // refresh the same token at once, Postgres row-locks it: the second waits, then re-checks the
        // condition, finds the token already revoked, and updates 0 rows. Only one request wins.
        const { count } = await tx.refreshToken.updateMany({
            where: { id: existing.id, revokedAt: null },
            data: { revokedAt: new Date(), replacedById: newTokenId },
        });
        if (count === 0) {
            throw new UnauthorizedError("Invalid or expired refresh token");
        }

        return createSession(tx, existing.user, existing.familyId, newTokenId);
    });
}

// Idempotent: logging out with an unknown or already-revoked token still "succeeds".
export async function logout(refreshToken: string): Promise<void> {
    await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
    });
}

// ---------------------------------------------------------------- password reset

export async function forgotPassword(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return; // caller still answers 202, same as for a real account

    const token = await createVerificationToken(prisma, user.id, "PASSWORD_RESET", PASSWORD_RESET_TTL_MS);
    sendInBackground(user.email, "Reset your IRCTC password",
        `Reset your password (valid for 30 minutes):\n${env.APP_URL}/reset-password#token=${token}\n\n` +
        `If you didn't ask for this, ignore this email.`);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    await prisma.$transaction(async (tx) => {
        const record = await consumeVerificationToken(tx, token, "PASSWORD_RESET");
        await tx.user.update({
            where: { id: record.userId },
            // Receiving the reset email proves they own the address, so it counts as verification.
            data: { passwordHash, isEmailVerified: true },
        });
        // If the password was reset because the account was compromised, the attacker's
        // sessions must die too: revoke every refresh token this user has.
        await tx.refreshToken.updateMany({
            where: { userId: record.userId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    });
}

// ---------------------------------------------------------------- current user

export async function getMe(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User");
    return toPublicUser(user);
}

// ---------------------------------------------------------------- helpers

async function createSession(db: Db, user: { id: string; role: Role }, familyId: string, tokenId?: string): Promise<Session> {
    const refreshToken = generateOpaqueToken();
    await db.refreshToken.create({
        data: {
            id: tokenId,
            userId: user.id,
            familyId,
            tokenHash: hashToken(refreshToken),
            expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
        },
    });

    return {
        accessToken: signAccessToken(user),
        refreshToken, // the raw token goes to the client exactly once; we only keep its hash
        expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    };
}

async function createVerificationToken(db: Db, userId: string, purpose: TokenPurpose, ttlMs: number): Promise<string> {
    const token = generateOpaqueToken();
    await db.verificationToken.create({
        data: { userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return token;
}

// Marks a single-use token as used and returns it, or throws if it's unknown, expired, already
// used, or for a different purpose. Must run inside a transaction with whatever the token unlocks.
async function consumeVerificationToken(db: Db, token: string, purpose: TokenPurpose) {
    const record = await db.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt <= new Date()) {
        throw new BadRequestError("INVALID_TOKEN", "This link is invalid or has expired");
    }

    // Same conditional-update pattern as refresh: if the link is clicked twice at the same moment,
    // only one request flips usedAt from null.
    const { count } = await db.verificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
    });
    if (count === 0) {
        throw new BadRequestError("INVALID_TOKEN", "This link is invalid or has expired");
    }
    return record;
}

async function sendVerificationEmail(userId: string, email: string): Promise<void> {
    const token = await createVerificationToken(prisma, userId, "EMAIL_VERIFY", EMAIL_VERIFY_TTL_MS);
    sendInBackground(email, "Verify your IRCTC account",
        `Welcome! Verify your email (valid for 24 hours):\n${env.APP_URL}/verify-email#token=${token}`);
}

// Don't make the HTTP response wait for SMTP, and don't fail a sign-up because email is briefly down.
// Not waiting also keeps response times identical whether or not an email was actually sent.
// TODO(Phase 3): move this to a BullMQ job so failed emails are retried and survive restarts.
function sendInBackground(to: string, subject: string, text: string): void {
    sendMail(to, subject, text).catch((err) => logger.error({ err, subject }, "Failed to send email"));
}

// Never return passwordHash or other internal fields to clients.
function toPublicUser(user: { id: string; email: string; phone: string | null; firstName: string; lastName: string; role: Role; isEmailVerified: boolean; createdAt: Date }) {
    return {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt,
    };
}
