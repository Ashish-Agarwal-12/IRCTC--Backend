import { Router } from "express";
import * as stations from "./stations.controller.js";

// Public: anyone can search stations (needed before login, on the search page).
export const stationsRouter = Router();
stationsRouter.get("/", stations.search);

// Admin: mounted under /admin, which already requires an ADMIN token (see app.ts).
export const adminStationsRouter = Router();
adminStationsRouter.post("/", stations.create);
adminStationsRouter.patch("/:id", stations.update);
