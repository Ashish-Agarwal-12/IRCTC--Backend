import type { RequestHandler } from "express";
import * as paymentsService from "./payments.service.js";
import { createOrderSchema, verifyPaymentSchema } from "./payments.schemas.js";

export const createOrder: RequestHandler = async (req, res) => {
    const { pnr } = createOrderSchema.parse(req.body);
    const { payment, created } = await paymentsService.createOrder(req.user!.id, pnr);
    // 201 for a new order; 200 when the booking's open order is reused.
    res.status(created ? 201 : 200).json({ payment });
};

export const verify: RequestHandler = async (req, res) => {
    const input = verifyPaymentSchema.parse(req.body);
    res.json(await paymentsService.verifyCheckout(input));
};

const header = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

export const webhook: RequestHandler = async (req, res) => {
    const result = await paymentsService.handleWebhook(
        req.rawBody,
        header(req.headers["x-razorpay-signature"]),
        header(req.headers["x-razorpay-event-id"]),
    );
    // Any 2xx tells Razorpay to stop redelivering; an error (500) makes it retry later.
    res.json(result);
};
