import { z } from "zod";
import { BerthType, CoachClass, Gender, Quota } from "../../generated/prisma/client.js";
import { stationCode } from "../../shared/validation.js";

export const MAX_PASSENGERS = 6;
const MAX_TATKAL_PASSENGERS = 4;

// Indian Railways' senior-citizen ages: 60 for men, 58 for women and transgender passengers.
const SENIOR_AGE: Record<Gender, number> = { MALE: 60, FEMALE: 58, TRANSGENDER: 58 };

const passengerSchema = z.object({
    name: z.string().trim().min(2).max(60),
    age: z.number().int().min(1).max(120),
    gender: z.enum(Gender),
    berthPreference: z.enum(BerthType).optional(),
});

export type PassengerInput = z.infer<typeof passengerSchema>;

export const createBookingSchema = z
    .object({
        scheduleId: z.uuid("Invalid schedule id"),
        from: stationCode,
        to: stationCode,
        class: z.enum(CoachClass),
        quota: z.enum(Quota).default("GENERAL"),
        passengers: z.array(passengerSchema).min(1).max(MAX_PASSENGERS, `At most ${MAX_PASSENGERS} passengers per booking`),
        // Optional when the account has a phone number; that one is used instead.
        contactPhone: z.string().regex(/^[6-9]\d{9}$/, "Phone must be a 10-digit Indian mobile number").optional(),
    })
    // Quota eligibility. Checked per passenger so the error points at the one that doesn't qualify.
    .superRefine((booking, ctx) => {
        const issue = (index: number, field: string, message: string) =>
            ctx.addIssue({ code: "custom", message, path: ["passengers", index, field] });

        booking.passengers.forEach((p, i) => {
            if (booking.quota === "LADIES" && p.gender !== "FEMALE") issue(i, "gender", "LADIES quota is for women only");
            if (booking.quota === "SENIOR_CITIZEN" && p.age < SENIOR_AGE[p.gender]) {
                issue(i, "age", `SENIOR_CITIZEN quota needs age ${SENIOR_AGE[p.gender]}+ for ${p.gender}`);
            }
        });
        if (booking.quota === "TATKAL" && booking.passengers.length > MAX_TATKAL_PASSENGERS) {
            ctx.addIssue({ code: "custom", message: `At most ${MAX_TATKAL_PASSENGERS} passengers on a TATKAL booking`, path: ["passengers"] });
        }
    });

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// Express lowercases header names, so the schema uses "idempotency-key".
export const idempotencyHeaderSchema = z.object({
    "idempotency-key": z
        .string("Send an Idempotency-Key header (e.g. a UUID) so a retried request can't book twice")
        .min(8)
        .max(100)
        .meta({ description: "Any unique string per booking attempt, e.g. a UUID. Retrying with the same key returns the same booking." }),
});

export const pnrParamSchema = z.object({ pnr: z.string().regex(/^\d{10}$/, "PNR is 10 digits") });
