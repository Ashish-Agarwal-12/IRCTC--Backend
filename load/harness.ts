// Shared plumbing for the load and failure tests.
//
// Unlike the Vitest suite (which calls the app in-process through Supertest), these run the real
// built server (dist/server.js) as a separate process on its own port and its own database
// (irctc_load), and talk to it over HTTP. That's what makes it possible to measure real latency,
// to send hundreds of truly concurrent requests through the connection pool, and to kill -9 the
// process in the middle of work. Your development database is never touched.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Agent, setGlobalDispatcher } from "undici";

// The load client reuses up to 256 keep-alive connections, the way a load balancer in front of the
// API does. Without this, 500 brand-new TCP connections in the same millisecond overflow Windows'
// accept backlog and some are refused (ECONNREFUSED): a property of the test machine, not the API.
setGlobalDispatcher(new Agent({ connections: 256, pipelining: 1, keepAliveTimeout: 30_000 }));

export const PORT = 3100;
export const BASE = `http://localhost:${PORT}`;
const ADMIN_URL = "postgresql://irctc:irctc@localhost:5432/irctc"; // only used to drop/create irctc_load
export const LOAD_DATABASE_URL = "postgresql://irctc:irctc@localhost:5432/irctc_load";

export const loadEnv: Record<string, string> = {
    NODE_ENV: "development",
    PORT: String(PORT),
    DATABASE_URL: LOAD_DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "load-test-secret-that-is-at-least-32-characters",
    APP_URL: BASE,
    DISABLE_RATE_LIMITS: "true", // one machine sends everything; see env.ts
};

// The harness imports app code (Prisma client, token signing), which reads env at import time.
Object.assign(process.env, loadEnv);
const { prisma } = await import("../src/shared/prisma.js");
const { signAccessToken } = await import("../src/modules/auth/tokens.js");
export { prisma };

export const RESULTS_DIR = new URL("./results/", import.meta.url);
mkdirSync(RESULTS_DIR, { recursive: true });

// --------------------------------------------------------------------------- database

export async function freshDatabase() {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS irctc_load WITH (FORCE)");
    await admin.query("CREATE DATABASE irctc_load");
    await admin.end();
    execSync("npx prisma migrate deploy", { env: { ...process.env, ...loadEnv }, stdio: "pipe" });
}

// --------------------------------------------------------------------------- server process

let server: ChildProcess | null = null;
const serverLog = createWriteStream(new URL("server.log", RESULTS_DIR), { flags: "a" });

export async function startServer() {
    server = spawn(process.execPath, ["dist/server.js"], { env: { ...process.env, ...loadEnv }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.pipe(serverLog, { end: false });
    server.stderr!.pipe(serverLog, { end: false });
    for (let i = 0; i < 120; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) return;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error("Server didn't start; see load/results/server.log");
}

// SIGKILL: no graceful shutdown, no cleanup. Exactly what a crash or an OOM kill looks like.
export async function killServer(signal: NodeJS.Signals = "SIGKILL") {
    if (!server) return;
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill(signal);
    await exited;
    server = null;
}

// --------------------------------------------------------------------------- data

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isoDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export async function createUsers(count: number) {
    const users = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(), email: `load${i}-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "-",
        firstName: "Load", lastName: `User${i}`, isEmailVerified: true, role: "USER" as const,
    }));
    await prisma.user.createMany({ data: users });
    return users.map((u) => signAccessToken(u));
}

// The same catalog as the test fixtures: train 12952 NDLS → KOTA → RTM → MMCT, one AC2 and
// `ac3Coaches` AC3 coaches, scheduled for the next two weeks.
export async function createCatalog(ac3Coaches = 2) {
    const admin = await prisma.user.create({
        data: { email: `admin-${randomUUID()}@example.test`, passwordHash: "-", firstName: "A", lastName: "D", role: "ADMIN", isEmailVerified: true },
    });
    const token = signAccessToken(admin);
    const call = async (method: string, url: string, body: object) => {
        const res = await fetch(`${BASE}/admin${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
        return res.json();
    };
    await prisma.fareRule.createMany({ data: [{ class: "AC3", baseFare: 4_000, perKm: 120 }, { class: "AC2", baseFare: 5_000, perKm: 175 }] });
    for (const [code, name, city] of [["NDLS", "New Delhi", "Delhi"], ["KOTA", "Kota Junction", "Kota"], ["RTM", "Ratlam Junction", "Ratlam"], ["MMCT", "Mumbai Central", "Mumbai"]]) {
        await call("POST", "/stations", { code, name, city });
    }
    const { train } = await call("POST", "/trains", { number: "12952", name: "Mumbai Rajdhani", runningDays: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], departureTime: "16:55" });
    await call("PUT", `/trains/${train.id}/route`, {
        stops: [
            { stationCode: "NDLS", arrivalMinutes: null, departureMinutes: 0, distanceKm: 0 },
            { stationCode: "KOTA", arrivalMinutes: 270, departureMinutes: 275, distanceKm: 465 },
            { stationCode: "RTM", arrivalMinutes: 515, departureMinutes: 518, distanceKm: 733 },
            { stationCode: "MMCT", arrivalMinutes: 955, departureMinutes: null, distanceKm: 1386 },
        ],
    });
    await call("PUT", `/trains/${train.id}/coaches`, {
        coaches: [{ code: "A1", class: "AC2" }, ...Array.from({ length: ac3Coaches }, (_, i) => ({ code: `B${i + 1}`, class: "AC3" }))],
    });
    await call("POST", `/trains/${train.id}/schedules`, { from: isoDate(1), to: isoDate(14) });
    const schedules = await prisma.trainSchedule.findMany({ where: { trainId: train.id }, orderBy: { journeyDate: "asc" } });
    return { trainId: train.id as string, scheduleIds: schedules.map((s) => s.id) };
}

// --------------------------------------------------------------------------- requests

export interface Result { status: number; ms: number; code?: string }

export async function timed(fn: () => Promise<Response>): Promise<Result> {
    const started = performance.now();
    try {
        const res = await fn();
        const body = await res.json().catch(() => null);
        return { status: res.status, ms: performance.now() - started, code: body?.error?.code };
    } catch (err) {
        return { status: 0, ms: performance.now() - started, code: (err as Error).cause ? String((err as { cause: { code?: string } }).cause.code) : "NETWORK" };
    }
}

export const book = (token: string, body: object) => fetch(`${BASE}/bookings`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify(body),
});

export const bookingBody = (scheduleId: string, coachClass = "AC3", name = "Load Passenger") => ({
    scheduleId, from: "NDLS", to: "MMCT", class: coachClass, contactPhone: "9876543210",
    passengers: [{ name, age: 35, gender: "FEMALE" }],
});

// Runs `worker` from `concurrency` loops until `durationMs` passes.
export async function sustained(concurrency: number, durationMs: number, worker: (i: number) => Promise<Result>) {
    const results: Result[] = [];
    const until = Date.now() + durationMs;
    let n = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (Date.now() < until) results.push(await worker(n++));
    }));
    return results;
}

// --------------------------------------------------------------------------- reporting

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summary(results: Result[], durationMs?: number) {
    const ms = results.map((r) => r.ms);
    const byStatus = results.reduce<Record<string, number>>((acc, r) => {
        const key = r.code ? `${r.status} ${r.code}` : String(r.status);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});
    return {
        requests: results.length,
        ...(durationMs && { perSecond: Math.round((results.length / durationMs) * 1000) }),
        p50: Math.round(percentile(ms, 50)), p95: Math.round(percentile(ms, 95)), p99: Math.round(percentile(ms, 99)), max: Math.round(Math.max(...ms)),
        byStatus,
    };
}

// Checks that must hold however much load or chaos came before. Returns the list of violations.
export async function invariantViolations(scheduleIds: string[]): Promise<string[]> {
    const problems: string[] = [];
    for (const scheduleId of scheduleIds) {
        const inventories = await prisma.seatInventory.findMany({ where: { scheduleId } });
        for (const inv of inventories) {
            const where = { booking: { scheduleId, class: inv.class, quota: inv.quota } };
            const confirmed = await prisma.passenger.count({ where: { ...where, status: "CONFIRMED" } });
            const rac = await prisma.passenger.findMany({ where: { ...where, status: "RAC" }, select: { racNumber: true } });
            const wl = await prisma.passenger.findMany({ where: { ...where, status: "WAITLISTED" }, select: { waitlistNumber: true } });
            const tag = `${scheduleId.slice(0, 8)} ${inv.class}/${inv.quota}`;
            // Berths handed out + berths still free = berths this quota started with (total minus RAC berths held back).
            const startedWith = inv.totalSeats - inv.racCapacity / 2;
            if (confirmed + inv.availableSeats !== startedWith) problems.push(`${tag}: ${confirmed} confirmed + ${inv.availableSeats} free != ${startedWith}`);
            if (inv.racBooked !== rac.length) problems.push(`${tag}: racBooked ${inv.racBooked} but ${rac.length} RAC passengers`);
            if (inv.waitlistBooked !== wl.length) problems.push(`${tag}: waitlistBooked ${inv.waitlistBooked} but ${wl.length} waitlisted`);
            const contiguous = (ns: (number | null)[]) => ns.map(Number).sort((a, b) => a - b).every((n, i) => n === i + 1);
            if (!contiguous(rac.map((p) => p.racNumber))) problems.push(`${tag}: RAC positions not 1..n`);
            if (!contiguous(wl.map((p) => p.waitlistNumber))) problems.push(`${tag}: WL positions not 1..n`);
        }
        const confirmedAll = await prisma.passenger.count({ where: { status: "CONFIRMED", booking: { scheduleId } } });
        const allocations = await prisma.seatAllocation.findMany({ where: { scheduleId }, select: { seatId: true, passenger: { select: { status: true } } } });
        if (allocations.length !== confirmedAll) problems.push(`${scheduleId.slice(0, 8)}: ${allocations.length} berths allocated for ${confirmedAll} confirmed passengers`);
        if (new Set(allocations.map((a) => a.seatId)).size !== allocations.length) problems.push(`${scheduleId.slice(0, 8)}: a berth is allocated twice`);
        if (allocations.some((a) => a.passenger.status !== "CONFIRMED")) problems.push(`${scheduleId.slice(0, 8)}: a berth is held by a non-confirmed passenger`);
    }
    // Every booking is whole: no booking without passengers (a transaction cut in half would leave one).
    const empty = await prisma.booking.count({ where: { passengers: { none: {} } } });
    if (empty) problems.push(`${empty} bookings have no passengers`);
    return problems;
}
