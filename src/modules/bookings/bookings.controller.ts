import type { RequestHandler } from "express";
import { paginationSchema } from "../../shared/validation.js";
import * as bookingsService from "./bookings.service.js";
import { createBookingSchema, idempotencyHeaderSchema, pnrParamSchema } from "./bookings.schemas.js";

// req.user! : these routes sit behind `authenticate`, so the user is always set here.

export const create: RequestHandler = async (req, res) => {
    const { "idempotency-key": idempotencyKey } = idempotencyHeaderSchema.parse(req.headers);
    const input = createBookingSchema.parse(req.body);
    const { booking, created } = await bookingsService.createBooking(req.user!.id, input, idempotencyKey);
    // 201 for a new booking; 200 when the same Idempotency-Key was already used (a retry).
    res.status(created ? 201 : 200).json({ booking });
};

export const list: RequestHandler = async (req, res) => {
    const pagination = paginationSchema.parse(req.query);
    res.json(await bookingsService.listBookings(req.user!.id, pagination));
};

export const getByPnr: RequestHandler = async (req, res) => {
    const { pnr } = pnrParamSchema.parse(req.params);
    res.json({ booking: await bookingsService.getBooking(req.user!.id, pnr) });
};
