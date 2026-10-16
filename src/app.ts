import express from "express";
import { pinoHttp } from "pino-http";

export function buildApp() {
    const app = express();
    app.use(pinoHttp());
    app.use(express.json());

    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });

    return app;
}
