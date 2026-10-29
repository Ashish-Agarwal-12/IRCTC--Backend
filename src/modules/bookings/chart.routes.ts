import { Router, type RequestHandler } from "express";
import { scheduleIdParamSchema } from "../trains/trains.schemas.js";
import { prepareChart } from "./chart.js";

// Admin: prepare a schedule's chart now instead of waiting for the job (4 h before departure).
// Useful for testing, and for trains whose chart is prepared early.
const prepareNow: RequestHandler = async (req, res) => {
    const { scheduleId } = scheduleIdParamSchema.parse(req.params);
    res.json({ chart: await prepareChart(scheduleId) });
};

export const adminChartRouter = Router();
adminChartRouter.post("/:scheduleId/chart", prepareNow);
