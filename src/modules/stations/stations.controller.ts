import type { RequestHandler } from "express";
import { idParamSchema } from "../../shared/validation.js";
import * as stationsService from "./stations.service.js";
import { createStationSchema, searchStationsSchema, updateStationSchema } from "./stations.schemas.js";

export const search: RequestHandler = async (req, res) => {
    const { q } = searchStationsSchema.parse(req.query);
    res.json({ stations: await stationsService.searchStations(q) });
};

export const create: RequestHandler = async (req, res) => {
    const input = createStationSchema.parse(req.body);
    res.status(201).json({ station: await stationsService.createStation(input) });
};

export const update: RequestHandler = async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const input = updateStationSchema.parse(req.body);
    res.json({ station: await stationsService.updateStation(id, input) });
};
