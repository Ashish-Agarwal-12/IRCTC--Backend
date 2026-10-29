import type { Router } from "express";
import { describe, expect, it } from "vitest";
import { adminMounts, publicMounts } from "../src/app.js";
import { operations } from "../src/docs/operations.js";
import { api } from "./helpers.js";

// Express keeps each router's routes in `router.stack`; a layer with `.route` is an endpoint.
interface RouteLayer { route?: { path: string; methods: Record<string, boolean> } }

// "/admin/" + "/stations/:id" → "/admin/stations/{id}" (OpenAPI path style)
function normalize(path: string): string {
    const clean = path.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
    return clean.replace(/:(\w+)/g, "{$1}");
}

function routesOf(router: Router, prefix: string): string[] {
    return (router.stack as RouteLayer[])
        .filter((layer) => layer.route)
        .flatMap((layer) =>
            Object.entries(layer.route!.methods)
                .filter(([, enabled]) => enabled)
                .map(([method]) => `${method.toUpperCase()} ${normalize(prefix + "/" + layer.route!.path)}`),
        );
}

const realRoutes = [
    ...publicMounts.flatMap(({ path, router }) => routesOf(router, path)),
    ...adminMounts.flatMap(({ path, router }) => routesOf(router, "/admin/" + path)),
].sort();

const documentedRoutes = operations.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort();

describe("API documentation", () => {
    it("documents every route the app serves, and nothing more", () => {
        // If this fails: a route was added without an entry in src/docs/operations.ts (or the reverse).
        expect(documentedRoutes).toEqual(realRoutes);
    });

    it("lists each operation once", () => {
        expect(new Set(documentedRoutes).size).toBe(documentedRoutes.length);
    });

    it("gives every operation a success response", () => {
        for (const op of operations) {
            const statuses = Object.keys(op.responses).map(Number);
            expect(statuses.some((s) => s >= 200 && s < 300), `${op.method} ${op.path}`).toBe(true);
        }
    });

    it("serves the OpenAPI document and Swagger UI", async () => {
        const spec = await api().get("/openapi.json").expect(200);
        expect(spec.body.openapi).toBe("3.1.0");
        expect(Object.keys(spec.body.paths)).toHaveLength(new Set(operations.map((o) => o.path)).size);
        expect(spec.body.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });

        const ui = await api().get("/docs/").expect(200);
        expect(ui.text).toContain("swagger-ui");
    });

    // These endpoints aren't exercised by the other test files; calling them here runs their
    // responses through the contract check too.
    it("serves the system endpoints and email-link pages as documented", async () => {
        await api().get("/health").expect(200);
        await api().get("/verify-email").expect(200).expect("content-type", /html/);
        await api().get("/reset-password").expect(200).expect("content-type", /html/);
    });
});
