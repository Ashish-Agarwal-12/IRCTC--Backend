import argon2 from "argon2";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/shared/prisma.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";
import type { Role } from "../src/generated/prisma/client.js";

// One app instance for all tests. Supertest calls it directly, with no real port or running server.
export const app = buildApp();
export const api = () => request(app);

// Empty every table (except Prisma's migration history) so each test starts from a clean slate.
// TRUNCATE ... CASCADE is much faster than deleting row by row and ignores foreign-key order.
export async function resetDb(): Promise<void> {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

let userCounter = 0;

// Inserts a user straight into the database, skipping the register/verify flow,
// for tests that only need "some logged-in user".
export async function createUser(opts: { role?: Role; verified?: boolean; password?: string } = {}) {
    userCounter += 1;
    const password = opts.password ?? "password123";
    const user = await prisma.user.create({
        data: {
            email: `user${userCounter}-${Date.now()}@example.test`,
            passwordHash: await argon2.hash(password),
            firstName: "Test",
            lastName: "User",
            role: opts.role ?? "USER",
            isEmailVerified: opts.verified ?? true,
        },
    });
    return { user, password, token: signAccessToken(user) };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
