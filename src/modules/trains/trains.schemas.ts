import { z } from "zod";
import { CoachClass, Weekday } from "../../generated/prisma/client.js";
import { calendarDate, clockTime, stationCode } from "../../shared/validation.js";

const WEEK_ORDER = Object.values(Weekday); // ["MON", ..., "SUN"]
const MAX_SCHEDULE_RANGE_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export const trainNumberSchema = z.string().regex(/^\d{5}$/, "Train number must be 5 digits");

export const trainNumberParamSchema = z.object({ number: trainNumberSchema });

export const createTrainSchema = z.object({
    number: trainNumberSchema,
    name: z.string().trim().min(2).max(100),
    // z.enum(Weekday) accepts only the enum's values. The transform removes duplicates and sorts into
    // week order, so ["FRI", "MON", "MON"] is stored as ["MON", "FRI"].
    runningDays: z
        .array(z.enum(Weekday))
        .min(1, "A train must run on at least one day")
        .transform((days) => WEEK_ORDER.filter((day) => days.includes(day))),
    departureTime: clockTime, // "16:55" in, 1015 out
});

// --------------------------------------------------------------------------- route

// Times are minutes after the train leaves its origin, so a stop 26 hours in is just 1560:
// no dates or midnight wrap-around in the data itself.
const routeStopSchema = z.object({
    stationCode,
    arrivalMinutes: z.number().int().min(0).nullish().transform((v) => v ?? null),
    departureMinutes: z.number().int().min(0).nullish().transform((v) => v ?? null),
    distanceKm: z.number().int().min(0).max(10_000),
});

// The whole route is sent at once, in order: the array position is the stop's sequence number, so
// gaps and duplicate sequence numbers can't happen. superRefine checks rules that span several
// stops, which a per-field schema can't express.
export const replaceRouteSchema = z
    .object({ stops: z.array(routeStopSchema).min(2, "A route needs at least an origin and a destination").max(200) })
    .superRefine(({ stops }, ctx) => {
        const issue = (index: number, field: string, message: string) =>
            ctx.addIssue({ code: "custom", message, path: ["stops", index, field] });

        const seen = new Set<string>();
        stops.forEach((stop, i) => {
            const isOrigin = i === 0;
            const isTerminus = i === stops.length - 1;
            const prev = stops[i - 1];

            if (seen.has(stop.stationCode)) issue(i, "stationCode", "Station appears more than once on the route");
            seen.add(stop.stationCode);

            if (isOrigin) {
                if (stop.arrivalMinutes !== null) issue(i, "arrivalMinutes", "The origin has no arrival time");
                if (stop.departureMinutes !== 0) issue(i, "departureMinutes", "The origin departs at minute 0");
                if (stop.distanceKm !== 0) issue(i, "distanceKm", "The origin is at distance 0");
                return;
            }

            if (stop.arrivalMinutes === null) issue(i, "arrivalMinutes", "Required for every stop after the origin");
            if (isTerminus && stop.departureMinutes !== null) issue(i, "departureMinutes", "The terminus has no departure time");
            if (!isTerminus && stop.departureMinutes === null) issue(i, "departureMinutes", "Required for every stop before the terminus");

            if (stop.arrivalMinutes !== null && stop.departureMinutes !== null && stop.departureMinutes < stop.arrivalMinutes) {
                issue(i, "departureMinutes", "Can't depart before arriving");
            }
            if (prev.departureMinutes !== null && stop.arrivalMinutes !== null && stop.arrivalMinutes <= prev.departureMinutes) {
                issue(i, "arrivalMinutes", "Must be after the previous stop's departure");
            }
            if (stop.distanceKm <= prev.distanceKm) {
                issue(i, "distanceKm", "Must be greater than the previous stop's distance");
            }
        });
    });

export type RouteStopInput = z.infer<typeof routeStopSchema>;

// --------------------------------------------------------------------------- coaches

const coachSchema = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}\d{1,2}$/, 'Coach code looks like "B1" or "S12"'),
    class: z.enum(CoachClass),
});

export const replaceCoachesSchema = z.object({
    coaches: z
        .array(coachSchema)
        .min(1)
        .max(30)
        .refine((coaches) => new Set(coaches.map((c) => c.code)).size === coaches.length, "Coach codes must be unique"),
});

export type CoachInput = z.infer<typeof coachSchema>;

// --------------------------------------------------------------------------- schedules

export const generateSchedulesSchema = z
    .object({ from: calendarDate, to: calendarDate })
    .refine(({ from, to }) => to >= from, { message: "`to` must not be before `from`", path: ["to"] })
    .refine(({ from, to }) => (to.getTime() - from.getTime()) / DAY_MS < MAX_SCHEDULE_RANGE_DAYS, {
        message: `Generate at most ${MAX_SCHEDULE_RANGE_DAYS} days at a time`,
        path: ["to"],
    });

export type CreateTrainInput = z.infer<typeof createTrainSchema>;
