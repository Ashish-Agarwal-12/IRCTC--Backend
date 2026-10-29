// Small Zod building blocks reused across modules.

import { z } from "zod";

// Query strings are always strings ("?page=2"), so coerce them to numbers before checking.
// The max pageSize stops a client asking for a million rows in one request.
export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

// Turns { page, pageSize } into Prisma's { skip, take }.
export function toSkipTake({ page, pageSize }: Pagination) {
    return { skip: (page - 1) * pageSize, take: pageSize };
}

export const idParamSchema = z.object({ id: z.uuid("Invalid id") });

// Station codes: 2-5 uppercase letters ("NDLS", "BCT"). Accept lowercase input and normalise.
export const stationCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, "Station code must be 2-5 letters");

// "16:55" → 1015 (minutes after midnight). Storing minutes makes time arithmetic plain addition.
export const clockTime = z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm (24-hour)")
    .transform((value) => {
        const [hours, minutes] = value.split(":").map(Number);
        return hours * 60 + minutes;
    });

// The reverse of clockTime, for responses: 1015 → "16:55". Minutes past 24h wrap to the next day.
export function formatClock(totalMinutes: number): string {
    const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
    const hh = String(Math.floor(minutesInDay / 60)).padStart(2, "0");
    const mm = String(minutesInDay % 60).padStart(2, "0");
    return `${hh}:${mm}`;
}

// "2026-11-01" → a Date at UTC midnight. Journey dates are calendar days with no time zone, so all
// date maths is done in UTC to avoid a local time zone shifting a date by one day.
export const calendarDate = z.iso.date("Date must be YYYY-MM-DD").transform((value) => new Date(`${value}T00:00:00Z`));
