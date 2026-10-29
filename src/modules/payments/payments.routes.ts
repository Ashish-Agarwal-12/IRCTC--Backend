import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { createRateLimiter } from "../../shared/middleware/rate-limit.js";
import * as payments from "./payments.controller.js";
import { checkoutPage } from "./payments.pages.js";

// Each of these calls Razorpay, so keep bots from making us hammer it.
const paymentLimiter = createRateLimiter(20, 60 * 1000);

export const paymentsRouter = Router();
paymentsRouter.post("/orders", paymentLimiter, authenticate, payments.createOrder);
// No login on these two: each request carries a signature only Razorpay can make.
paymentsRouter.post("/verify", paymentLimiter, payments.verify);
paymentsRouter.post("/webhook", payments.webhook); // not rate limited: Razorpay may send bursts
paymentsRouter.get("/checkout", checkoutPage);
