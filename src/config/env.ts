// The concept is if someone deploys with a wrong environment variable, the app crashes at sartup with a clear error message, instead of running for an hour and crashing on the database call. Production systems validate their config before doing anything else.

import "dotenv/config";
import { z } from "zod";

export const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Auth. HS256 is only as strong as its secret, so refuse short ones.
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // Email. Base URL of the frontend that the links in emails point to.
    APP_URL: z.string().url().default("http://localhost:3000"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().default(1025),
    MAIL_FROM: z.string().default("IRCTC <no-reply@irctc.local>"),

    // Payments: Razorpay, TEST MODE ONLY. A live key (rzp_live_...) is refused at startup, so this
    // build can never charge a real card. All optional: without keys the payment endpoints answer
    // 503 PAYMENTS_NOT_CONFIGURED and everything else still works.
    RAZORPAY_KEY_ID: z
        .string()
        .regex(/^rzp_test_/, "RAZORPAY_KEY_ID must be a test key (rzp_test_...): live payments are not enabled")
        .optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    // Set in the Razorpay dashboard when adding the webhook. Without it, POST /payments/webhook answers 503.
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
}).refine((e) => !!e.RAZORPAY_KEY_ID === !!e.RAZORPAY_KEY_SECRET, {
    message: "Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET together",
    path: ["RAZORPAY_KEY_SECRET"],
});

// Empty values in .env (RAZORPAY_KEY_ID=) mean "not set", not "set to an empty string".
const definedEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));

export const env = envSchema.parse(definedEnv);
