// The concept is if someone deploys with a wrong environment variable, the app crashes at sartup with a clear error message, instead of running for an hour and crashing on the database call. Production systems validate their config before doing anything else.

import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);

