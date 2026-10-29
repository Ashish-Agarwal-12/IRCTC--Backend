import type { RequestHandler } from "express";
import { paginationSchema } from "../../shared/validation.js";
import * as bookingsService from "./bookings.service.js";
import { cancelQuerySchema, createBookingSchema, idempotencyHeaderSchema, pnrParamSchema } from "./bookings.schemas.js";
import * as cancellationService from "./cancellation.service.js";

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

export const ticket: RequestHandler = async (req, res) => {
    const { pnr } = pnrParamSchema.parse(req.params);
    const { filename, pdf } = await bookingsService.getTicketPdf(req.user!.id, pnr);
    res.set({
        "Content-Disposition": `attachment; filename="${filename}"`, // download rather than open in the tab
        "Cache-Control": "private, no-store", // personal data: no shared caches, and always the current status
    });
    res.type("application/pdf").send(pdf);
};

export const cancel: RequestHandler = async (req, res) => {
    const { pnr } = pnrParamSchema.parse(req.params);
    const { passengers } = cancelQuerySchema.parse(req.query);
    res.json(await cancellationService.cancelBooking(req.user!.id, pnr, passengers));
};
