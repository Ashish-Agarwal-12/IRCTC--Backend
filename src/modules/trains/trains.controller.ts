import type { RequestHandler } from "express";
import { idParamSchema, paginationSchema } from "../../shared/validation.js";
import * as trainsService from "./trains.service.js";
import { generateSchedules as generateSchedulesForTrain } from "./schedules.service.js";
import { getAvailability, searchTrains } from "./search.service.js";
import {
    availabilityQuerySchema, createTrainSchema, generateSchedulesSchema, replaceCoachesSchema, replaceRouteSchema,
    scheduleIdParamSchema, searchTrainsSchema, trainNumberParamSchema,
} from "./trains.schemas.js";

export const list: RequestHandler = async (req, res) => {
    const pagination = paginationSchema.parse(req.query);
    res.json(await trainsService.listTrains(pagination));
};

export const getByNumber: RequestHandler = async (req, res) => {
    const { number } = trainNumberParamSchema.parse(req.params);
    res.json({ train: await trainsService.getTrainByNumber(number) });
};

export const search: RequestHandler = async (req, res) => {
    const input = searchTrainsSchema.parse(req.query);
    res.json(await searchTrains(input));
};

export const availability: RequestHandler = async (req, res) => {
    const { scheduleId } = scheduleIdParamSchema.parse(req.params);
    const query = availabilityQuerySchema.parse(req.query);
    res.json(await getAvailability(scheduleId, query));
};

export const create: RequestHandler = async (req, res) => {
    const input = createTrainSchema.parse(req.body);
    res.status(201).json({ train: await trainsService.createTrain(input) });
};

export const replaceRoute: RequestHandler = async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const { stops } = replaceRouteSchema.parse(req.body);
    res.json({ train: await trainsService.replaceRoute(id, stops) });
};

export const replaceCoaches: RequestHandler = async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const { coaches } = replaceCoachesSchema.parse(req.body);
    res.json({ train: await trainsService.replaceCoaches(id, coaches) });
};

export const generateSchedules: RequestHandler = async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const { from, to } = generateSchedulesSchema.parse(req.body);
    res.status(201).json(await generateSchedulesForTrain(id, from, to));
};
