// npm run load: builds the server, gives it a fresh irctc_load database, and runs every scenario.
// Writes the report to load/results/report.md and exits 1 if any check failed.
// Needs Docker Compose's Postgres running. Takes about two minutes.

import { writeFileSync } from "node:fs";
import { RESULTS_DIR, createCatalog, freshDatabase, killServer, prisma, startServer } from "./harness.js";
import { crashMidBurst, databasePause, lastSeat, latency, type Section } from "./scenarios.js";

const only = process.argv[2]; // e.g. `npm run load -- last-seat`
const scenarios: Record<string, (ids: string[]) => Promise<Section>> = {
    "last-seat": (ids) => lastSeat(ids[0]),
    latency: (ids) => latency(ids.slice(1)),
    crash: (ids) => crashMidBurst(ids.slice(1, 5)),
    "db-pause": (ids) => databasePause(ids.slice(1)),
};

const sections: Section[] = [];
try {
    console.log("Fresh database irctc_load…");
    await freshDatabase();
    await startServer();
    const { scheduleIds } = await createCatalog(4);
    for (const [name, run] of Object.entries(scenarios)) {
        if (only && only !== name) continue;
        console.log(`\n▶ ${name}`);
        const section = await run(scheduleIds);
        sections.push(section);
        for (const line of section.lines) console.log("  " + line);
        // ✔ passed · ✘ correctness failure · △ performance target missed on this machine
        for (const c of section.checks) console.log(`  ${c.pass ? "✔" : c.kind === "target" ? "△" : "✘"} ${c.name}: ${c.detail}`);
    }
} finally {
    await killServer("SIGTERM");
    await prisma.$disconnect();
}

const report = [
    `# Load and failure test report`,
    ``,
    `${new Date().toISOString()} · Node ${process.version} · ${process.platform} · server and Postgres on one machine`,
    ``,
    ...sections.flatMap((s) => [
        `## ${s.title}`, ``, ...s.lines.map((l) => `- ${l}`), ``,
        `| Check | Result | Detail |`, `|---|---|---|`,
        ...s.checks.map((c) => `| ${c.name} | ${result(c)} | ${c.detail.replace(/\|/g, "\\|")} |`), ``,
    ]),
].join("\n");
writeFileSync(new URL("report.md", RESULTS_DIR), report);

// Only correctness failures fail the run. Missed performance targets are reported: they depend
// on the machine (requirements: validate the targets on production-like infrastructure).
const all = sections.flatMap((s) => s.checks);
const failed = all.filter((c) => !c.pass && c.kind === "correctness");
const missed = all.filter((c) => !c.pass && c.kind === "target");
console.log(`\n${failed.length === 0 ? "All correctness checks passed." : `${failed.length} correctness check(s) FAILED.`} ` +
    `${missed.length} performance target(s) missed on this machine. Report: load/results/report.md`);
process.exit(failed.length === 0 ? 0 : 1);

function result(c: { pass: boolean; kind: string }) {
    if (c.kind === "target") return c.pass ? "target met" : "target missed";
    return c.pass ? "PASS" : "**FAIL**";
}
