// Request body shapes. Each schema both validates input at runtime and gives us a TypeScript
// type for free via z.infer, so the validation rules and the types can never drift apart.

import { z } from "zod";

// Normalise before validating: " Asha@Mail.com " and "asha@mail.com" are the same account.
const email = z.string().trim().toLowerCase().pipe(z.email("Invalid email address"));

// The max length matters: hashing a 10 MB "password" with argon2 would tie up the CPU (a cheap DoS).
const password = z.string().min(8, "Password must be at least 8 characters").max(128);

// Opaque tokens from emails / login are 43 base64url characters; anything wildly different is junk.
const token = z.string().min(20).max(200);

export const registerSchema = z.object({
    email,
    password,
    firstName: z.string().trim().min(1).max(50),
    lastName: z.string().trim().min(1).max(50),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Phone must be a 10-digit Indian mobile number").optional(),
});

export const loginSchema = z.object({
    email,
    password: z.string().min(1).max(128), // no min-8 rule on login: just check what they typed
});

export const tokenSchema = z.object({ token });

export const refreshSchema = z.object({ refreshToken: token });

export const emailOnlySchema = z.object({ email });

export const resetPasswordSchema = z.object({ token, password });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
