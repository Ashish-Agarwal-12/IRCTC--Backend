// Seeds the development database. Run with: npx prisma db seed
// Safe to run repeatedly: everything is "create if missing", nothing is duplicated or overwritten
// except the admin's password and the fare table, which are reset to the values below.
//
// It reuses the real service functions (createTrain, replaceRoute, ...) rather than writing rows
// directly. That's the payoff of keeping services free of req/res: the seed goes through the same
// validation-adjacent logic as the API, so seeded data is shaped exactly like API-created data.

import argon2 from "argon2";
import { prisma } from "../src/shared/prisma.js";
import { createTrainSchema, replaceCoachesSchema, replaceRouteSchema } from "../src/modules/trains/trains.schemas.js";
import { createTrain, replaceCoaches, replaceRoute } from "../src/modules/trains/trains.service.js";
import { generateSchedules } from "../src/modules/trains/schedules.service.js";
import { SCHEDULE_DAYS_AHEAD, fareRules, stations, trains } from "./seed-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedAdmin() {
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
        create: { email, passwordHash, firstName: "System", lastName: "Admin", role: "ADMIN", isEmailVerified: true },
    });
    console.log(`Admin ready: ${admin.id}`);
}

async function seedCatalog() {
    await prisma.station.createMany({ data: stations, skipDuplicates: true });

    for (const rule of fareRules) {
        await prisma.fareRule.upsert({ where: { class: rule.class }, update: rule, create: rule });
    }

    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const lastDay = new Date(today.getTime() + (SCHEDULE_DAYS_AHEAD - 1) * DAY_MS);

    for (const t of trains) {
        let train = await prisma.train.findUnique({ where: { number: t.number }, select: { id: true } });
        if (!train) {
            // Parse through the same Zod schemas the API uses, so bad seed data fails loudly here.
            train = await createTrain(createTrainSchema.parse(t));
            const stops = t.stops.map(([stationCode, arrivalMinutes, departureMinutes, distanceKm]) =>
                ({ stationCode, arrivalMinutes, departureMinutes, distanceKm }));
            await replaceRoute(train.id, replaceRouteSchema.parse({ stops }).stops);
            await replaceCoaches(train.id, replaceCoachesSchema.parse({ coaches: t.coaches }).coaches);
        }
        const result = await generateSchedules(train.id, today, lastDay);
        console.log(`Train ${t.number}: ${result.created} new schedules (${result.skipped} already existed)`);
    }
}

async function main() {
    await seedAdmin();
    await seedCatalog();
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
