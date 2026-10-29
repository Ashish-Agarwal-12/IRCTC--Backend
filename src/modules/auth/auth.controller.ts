// HTTP layer: validate the request, call the service, shape the response. No business logic here.
// Express 5 catches errors thrown by async handlers (including ZodError from .parse) and passes
// them to the error handler, so there's no try/catch in any of these.

import type { RequestHandler } from "express";
import * as authService from "./auth.service.js";
import {
    emailOnlySchema, loginSchema, refreshSchema, registerSchema, resetPasswordSchema, tokenSchema,
} from "./auth.schemas.js";

export const register: RequestHandler = async (req, res) => {
    const input = registerSchema.parse(req.body);
    const user = await authService.register(input);
    res.status(201).json({ user });
};

export const verifyEmail: RequestHandler = async (req, res) => {
    const { token } = tokenSchema.parse(req.body);
    await authService.verifyEmail(token);
    res.status(204).end();
};

export const resendVerification: RequestHandler = async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    await authService.resendVerification(email);
    res.status(202).json({ message: "If that account exists and is unverified, a new link has been sent" });
};

export const login: RequestHandler = async (req, res) => {
    const input = loginSchema.parse(req.body);
    const session = await authService.login(input);
    res.json(session);
};

export const refresh: RequestHandler = async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const session = await authService.refresh(refreshToken);
    res.json(session);
};

export const logout: RequestHandler = async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await authService.logout(refreshToken);
    res.status(204).end();
};

export const forgotPassword: RequestHandler = async (req, res) => {
    const { email } = emailOnlySchema.parse(req.body);
    await authService.forgotPassword(email);
    res.status(202).json({ message: "If that account exists, a reset link has been sent" });
};

export const resetPassword: RequestHandler = async (req, res) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(token, password);
    res.status(204).end();
};

export const me: RequestHandler = async (req, res) => {
    // `authenticate` runs before this handler, so req.user is set; the ! tells TypeScript so.
    const user = await authService.getMe(req.user!.id);
    res.json({ user });
};
