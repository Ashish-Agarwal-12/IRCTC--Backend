// Creates (or updates) the admin account from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
// Run with: npx prisma db seed
// There's deliberately no API to become an admin: the first one has to come from outside the app.

import argon2 from "argon2";
import { prisma } from "../src/shared/prisma.js";

async function main() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password || password.length < 8) {
        throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 chars) in .env before seeding");
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // upsert = update if it exists, create if it doesn't. Makes the seed safe to run repeatedly.
    const admin = await prisma.user.upsert({
        where: { email },
        update: { role: "ADMIN", passwordHash, isEmailVerified: true },
        create: {
            email,
            passwordHash,
            firstName: "System",
            lastName: "Admin",
            role: "ADMIN",
            isEmailVerified: true,
        },
    });
    console.log(`Admin ready: ${admin.id}`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
