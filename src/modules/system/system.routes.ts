import { Router } from "express";

export const systemRouter = Router();
systemRouter.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

// Mounted under /admin: a cheap way to check that a token has admin rights.
export const adminSystemRouter = Router();
adminSystemRouter.get("/ping", (_req, res) => {
    res.json({ status: "ok", admin: true });
});
