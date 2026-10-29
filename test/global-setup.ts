// Runs once before the whole test suite, in the main Vitest process.
// `prisma migrate deploy` creates irctc_test if it doesn't exist and applies every migration,
// so the test schema always matches prisma/migrations exactly.

import { execSync } from "node:child_process";
import { testEnv } from "./test-env.js";

export default function setup() {
    execSync("npx prisma migrate deploy", {
        env: { ...process.env, ...testEnv },
        stdio: "pipe", // keep Prisma's output out of the test report unless it fails
    });
}
