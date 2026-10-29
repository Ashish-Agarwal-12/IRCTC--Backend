// The load and failure scenarios. Each returns a section for the report and the checks it made;
// a failed check fails the run (run-all.ts exits non-zero).

import { execSync } from "node:child_process";
import {
    BASE, book, bookingBody, createUsers, invariantViolations, isoDate, killServer, prisma, sleep, startServer,
    summary, sustained, timed, type Result,
} from "./harness.js";

// "correctness" checks must pass on any machine; "target" checks compare with the performance
// targets, which depend on hardware (requirements: validate them on production-like infrastructure).
export interface Check { name: string; pass: boolean; detail: string; kind: "correctness" | "target" }
export interface Section { title: string; lines: string[]; checks: Check[] }

const check = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail, kind: "correctness" });
const target = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail, kind: "target" });

// The server's worst event-loop delay since the previous call (prom-client resets it on each scrape).
async function eventLoopLagMax(): Promise<number> {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    return Number(/^nodejs_eventloop_lag_max_seconds (\S+)$/m.exec(text)?.[1] ?? NaN);
}
const table = (s: ReturnType<typeof summary>) =>
    `requests ${s.requests}${s.perSecond ? `, ${s.perSecond}/s` : ""} · p50 ${s.p50} ms · p95 ${s.p95} ms · p99 ${s.p99} ms · max ${s.max} ms · ${JSON.stringify(s.byStatus)}`;
// A booking under load may be held (201) or refused because the class is full (409 REGRET). Anything
// else (a 4xx from a broken request, a 5xx) means the scenario or the server is wrong.
const onlyBookingOutcomes = (results: Result[]) => results.length > 0 && results.every((r) => r.status === 201 || r.code === "REGRET");

// --------------------------------------------------------------------------- 1. the last seat

// Requirement 2.1: "500 concurrent requests for one seat ... only one request can win that seat."
export async function lastSeat(scheduleId: string): Promise<Section> {
    const where = { scheduleId_class_quota: { scheduleId, class: "AC3" as const, quota: "GENERAL" as const } };
    // One berth, no RAC: exactly one passenger can be CONFIRMED; the next 100 are waitlisted, the rest REGRET.
    await prisma.seatInventory.update({ where, data: { totalSeats: 1, availableSeats: 1, racCapacity: 0, racBooked: 0, waitlistBooked: 0 } });
    const tokens = await createUsers(500);

    const started = performance.now();
    // All 500 start together: each is its own user, own Idempotency-Key, own HTTP request.
    const results = await Promise.all(tokens.map((token, i) => timed(() => book(token, bookingBody(scheduleId, "AC3", `Racer ${i}`)))));
    const wall = performance.now() - started;

    const confirmed = await prisma.passenger.count({ where: { status: "CONFIRMED", booking: { scheduleId, class: "AC3", quota: "GENERAL" } } });
    const allocations = await prisma.seatAllocation.count({ where: { scheduleId } });
    const wl = (await prisma.passenger.findMany({ where: { status: "WAITLISTED", booking: { scheduleId } }, select: { waitlistNumber: true } }))
        .map((p) => p.waitlistNumber!).sort((a, b) => a - b);
    const held = results.filter((r) => r.status === 201).length;
    const regret = results.filter((r) => r.code === "REGRET").length;
    const errors = results.filter((r) => r.status >= 500 || r.status === 0);
    const s = summary(results);

    return {
        title: "500 concurrent requests for the last seat",
        lines: [
            `All 500 sent at once; the last answer came after ${Math.round(wall)} ms.`,
            table(s),
            `Database afterwards: ${confirmed} confirmed passenger, ${allocations} berth allocated, waitlist ${wl[0]}–${wl.at(-1)} (${wl.length}), ${regret} REGRET.`,
        ],
        checks: [
            check("exactly one request wins the berth", confirmed === 1 && allocations === 1, `${confirmed} confirmed, ${allocations} allocated`),
            check("waitlist numbers 1..100, each issued once", wl.length === 100 && wl.every((n, i) => n === i + 1), `${wl.length} issued`),
            check("every request got a definite answer (held or REGRET)", held + regret === 500, `${held} held + ${regret} REGRET`),
            check("no 5xx or dropped connections", errors.length === 0, `${errors.length} errors ${JSON.stringify(summary(errors).byStatus)}`),
            check("invariants hold", (await invariantViolations([scheduleId])).length === 0, (await invariantViolations([scheduleId])).join("; ") || "ok"),
        ],
    };
}

// --------------------------------------------------------------------------- 2. latency targets

export async function latency(scheduleIds: string[]): Promise<Section> {
    const tokens = await createUsers(100);
    const lines: string[] = [];
    const checks: Check[] = [];

    // Search: 20 clients for 15 s, across the two weeks of schedules.
    const searchMs = 15_000;
    const search = await sustained(20, searchMs, (i) => timed(() => fetch(`${BASE}/trains/search?from=NDLS&to=MMCT&date=${isoDate(1 + (i % 13))}`)));
    const ss = summary(search, searchMs);
    lines.push(`Search, 20 concurrent clients for 15 s: ${table(ss)}`);
    checks.push(target("search p95 under 200 ms", ss.p95 < 200, `p95 ${ss.p95} ms`));

    // Booking without contention: 20 clients spread over 12 schedules × 2 classes (each needs its own lock).
    const spreadMs = 15_000;
    const spread = await sustained(20, spreadMs, (i) =>
        timed(() => book(tokens[i % tokens.length], bookingBody(scheduleIds[i % 12], i % 2 ? "AC2" : "AC3"))));
    const sp = summary(spread, spreadMs);
    lines.push(`Booking across trains/classes, 20 concurrent clients for 15 s: ${table(sp)}`);
    checks.push(target("booking p95 under 2 s (spread load)", sp.p95 < 2_000, `p95 ${sp.p95} ms`));
    checks.push(check("every spread booking held or REGRET, no errors", onlyBookingOutcomes(spread), JSON.stringify(sp.byStatus)));

    // Tatkal rush: 100 clients hammering ONE class of ONE train for 15 s. Every booking takes the same lock.
    const rushMs = 15_000;
    await eventLoopLagMax(); // reset the server's max-lag window
    const rush = await sustained(100, rushMs, (i) => timed(() => book(tokens[i % tokens.length], bookingBody(scheduleIds[12], "AC3"))));
    const rs = summary(rush, rushMs);
    lines.push(`Rush on one train + class, 100 concurrent clients for 15 s: ${table(rs)}`);
    // Is the server CPU-bound? Event-loop delay is how long ready work waited for the single JS thread.
    lines.push(`Server event-loop delay during the rush: max ${Math.round((await eventLoopLagMax()) * 1000)} ms (Prisma 7 builds queries in JS, on the same thread).`);
    checks.push(target("booking p95 under 2 s (rush on one train)", rs.p95 < 2_000, `p95 ${rs.p95} ms`));
    checks.push(check("every rush booking held or REGRET, no errors", onlyBookingOutcomes(rush), JSON.stringify(rs.byStatus)));

    // Isolation: does a rush on one train slow down everyone else? Search other dates while 100
    // clients hammer one class, and compare with search on its own (measured above, same machine).
    const both = await Promise.all([
        sustained(100, rushMs, (i) => timed(() => book(tokens[i % tokens.length], bookingBody(scheduleIds[11], "AC2")))),
        sustained(5, rushMs, (i) => timed(() => fetch(`${BASE}/trains/search?from=NDLS&to=MMCT&date=${isoDate(1 + (i % 10))}`))),
    ]);
    const during = summary(both[1], rushMs);
    lines.push(`Search (5 clients) while 100 clients rush one train: ${table(during)}`);
    checks.push(target("search during a rush stays under 200 ms p95", during.p95 < 200, `p95 ${during.p95} ms (alone: ${ss.p95} ms)`));

    const violations = await invariantViolations(scheduleIds);
    checks.push(check("invariants hold after the load", violations.length === 0, violations.join("; ") || "ok"));
    return { title: "Latency against the targets (search < 200 ms, booking < 2 s)", lines, checks };
}

// --------------------------------------------------------------------------- 3. crash mid-burst

export async function crashMidBurst(scheduleIds: string[]): Promise<Section> {
    const tokens = await createUsers(200);
    const before = await prisma.booking.count();

    // 200 bookings in flight across 4 schedules; kill -9 once 25 have been answered, so some
    // bookings have definitely committed and many are still mid-transaction.
    let answeredSoFar = 0;
    const burst = Promise.all(tokens.map((t, i) => timed(() => book(t, bookingBody(scheduleIds[i % 4], i % 2 ? "AC2" : "AC3")))
        .then((r) => { if (r.status === 201) answeredSoFar += 1; return r; })));
    for (const until = Date.now() + 30_000; answeredSoFar < 25 && Date.now() < until;) await sleep(10);
    await killServer("SIGKILL");
    const results = await burst;
    const answered = results.filter((r) => r.status === 201).length;
    const cut = results.filter((r) => r.status === 0).length;

    await startServer();
    const after = await prisma.booking.count();
    const violations = await invariantViolations(scheduleIds);
    // Postgres rolled back every transaction the kill interrupted, so each booking either fully
    // exists or doesn't exist at all. A booking that committed but whose response was lost is
    // still there, and the client's retry with the same Idempotency-Key gets it back.
    return {
        title: "kill -9 in the middle of 200 concurrent bookings",
        lines: [
            `${answered} requests answered 201 before the kill, ${cut} connections cut. ${after - before} bookings exist afterwards.`,
            "Restarted; checked every inventory row, queue and berth.",
        ],
        checks: [
            check("the crash hit mid-burst (some answered, some cut)", answered > 0 && cut > 0, `${answered} answered, ${cut} cut`),
            check("every answered booking survived", after - before >= answered, `${after - before} stored ≥ ${answered} answered`),
            check("no half-written bookings; counters, queues and berths consistent", violations.length === 0, violations.join("; ") || "ok"),
        ],
    };
}

// --------------------------------------------------------------------------- 4. database outage

export async function databasePause(scheduleIds: string[]): Promise<Section> {
    const tokens = await createUsers(50);
    const container = execSync(`docker ps --filter "ancestor=postgres:16-alpine" --format "{{.Names}}"`).toString().trim().split("\n")[0];
    const results: (Result & { at: number })[] = [];
    const t0 = Date.now();
    let stop = false;

    // Steady traffic the whole time: 10 clients booking and searching.
    const traffic = Promise.all(Array.from({ length: 10 }, async (_, w) => {
        for (let i = 0; !stop; i++) {
            const r = await timed(() => i % 2
                ? fetch(`${BASE}/trains/search?from=NDLS&to=MMCT&date=${isoDate(2)}`)
                : book(tokens[(w * 7 + i) % tokens.length], bookingBody(scheduleIds[5 + (i % 3)], "AC3")));
            results.push({ ...r, at: Date.now() - t0 });
            await sleep(50);
        }
    }));

    await sleep(3_000);
    // Freezes Postgres: connections stay open but nothing answers, like a hung database or a network partition.
    execSync(`docker pause ${container}`);
    const pausedAt = Date.now() - t0;
    await sleep(1_500);
    const readyDuring = await timed(() => fetch(`${BASE}/health/ready`));
    await sleep(6_500);
    execSync(`docker unpause ${container}`);
    const resumedAt = Date.now() - t0;
    await sleep(8_000);
    stop = true;
    await traffic;
    const readyAfter = await timed(() => fetch(`${BASE}/health/ready`));

    const during = results.filter((r) => r.at >= pausedAt && r.at < resumedAt + 1_000);
    const recovered = results.filter((r) => r.at >= resumedAt + 3_000);
    const firstOk = results.find((r) => r.at >= resumedAt && r.status < 500 && r.status !== 0);
    const violations = await invariantViolations(scheduleIds);
    return {
        title: "Database frozen for 8 s under steady traffic (docker pause)",
        lines: [
            `During the freeze: ${table(summary(during))}`,
            `/health/ready during the freeze: ${readyDuring.status} after ${Math.round(readyDuring.ms)} ms; afterwards: ${readyAfter.status}.`,
            `First success ${firstOk ? firstOk.at - resumedAt : "n/a"} ms after the database came back. From 3 s after: ${table(summary(recovered))}`,
        ],
        checks: [
            check("readiness reports the outage (503)", readyDuring.status === 503, `${readyDuring.status}`),
            check("the server survives and recovers on its own (no restart)", recovered.length > 0 && recovered.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(summary(recovered).byStatus)),
            check("readiness is back to 200", readyAfter.status === 200, `${readyAfter.status}`),
            check("no corrupted data", violations.length === 0, violations.join("; ") || "ok"),
        ],
    };
}
