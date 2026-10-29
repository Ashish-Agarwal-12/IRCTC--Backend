import { z } from "zod";
import { stationCode } from "../../shared/validation.js";

export const searchStationsSchema = z.object({
    q: z.string().trim().min(1, "Type at least one character").max(50),
});

export const createStationSchema = z.object({
    code: stationCode,
    name: z.string().trim().min(2).max(100),
    city: z.string().trim().min(2).max(100),
});

// PATCH = partial update: every field optional, but an empty body is pointless, so reject it.
// The code is left out on purpose: people learn and type station codes, so they shouldn't change.
export const updateStationSchema = createStationSchema
    .omit({ code: true })
    .partial()
    .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update");

export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
