import { Router } from "express";
import * as trains from "./trains.controller.js";

// Public. (Phase 3 adds GET /search here; it must be registered before "/:number",
// or Express would treat the word "search" as a train number.)
export const trainsRouter = Router();
trainsRouter.get("/", trains.list);
trainsRouter.get("/:number", trains.getByNumber);

// Admin: mounted under /admin/trains (admin-only, see app.ts).
// PUT = "replace the whole thing"; route and coaches are always sent as complete lists.
export const adminTrainsRouter = Router();
adminTrainsRouter.post("/", trains.create);
adminTrainsRouter.put("/:id/route", trains.replaceRoute);
adminTrainsRouter.put("/:id/coaches", trains.replaceCoaches);
adminTrainsRouter.post("/:id/schedules", trains.generateSchedules);
