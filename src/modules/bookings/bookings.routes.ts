import { Router } from "express";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { createRateLimiter } from "../../shared/middleware/rate-limit.js";
import * as bookings from "./bookings.controller.js";

// Per IP. Generous enough for a family retrying during a Tatkal rush, tight enough to slow a bot.
const bookingLimiter = createRateLimiter(20, 60 * 1000);

// Every booking route needs a logged-in user; router.use applies authenticate to all of them.
export const bookingsRouter = Router();
bookingsRouter.use(authenticate);
bookingsRouter.post("/", bookingLimiter, bookings.create);
bookingsRouter.get("/", bookings.list);
bookingsRouter.get("/:pnr", bookings.getByPnr);
bookingsRouter.get("/:pnr/ticket.pdf", bookings.ticket);
