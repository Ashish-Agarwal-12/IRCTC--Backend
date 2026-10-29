import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { createRateLimiter } from "../../shared/middleware/rate-limit.js";
import * as auth from "./auth.controller.js";

const MINUTE = 60 * 1000;

// Tight limits where an attacker gains from volume: guessing passwords, spamming sign-ups or emails.
const loginLimiter = createRateLimiter(5, MINUTE);
const emailLimiter = createRateLimiter(5, 15 * MINUTE);
const generalAuthLimiter = createRateLimiter(30, MINUTE);

export const authRouter = Router();

// Each route runs its middlewares left to right: rate limit, then (sometimes) auth, then the handler.
authRouter.post("/register", emailLimiter, auth.register);
authRouter.post("/verify-email", generalAuthLimiter, auth.verifyEmail);
authRouter.post("/resend-verification", emailLimiter, auth.resendVerification);
authRouter.post("/login", loginLimiter, auth.login);
authRouter.post("/refresh", generalAuthLimiter, auth.refresh);
authRouter.post("/logout", generalAuthLimiter, auth.logout);
authRouter.post("/forgot-password", emailLimiter, auth.forgotPassword);
authRouter.post("/reset-password", generalAuthLimiter, auth.resetPassword);
authRouter.get("/me", authenticate, auth.me);
