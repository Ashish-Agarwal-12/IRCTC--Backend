import { defineConfig } from "vitest/config";
import { testEnv } from "./test/test-env.js";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        env: testEnv, // applied to process.env in every test worker, before src/config/env.ts runs
        globalSetup: ["./test/global-setup.ts"],
        setupFiles: ["./test/setup.ts"], // checks every response against the API docs
        // All test files share one database, so run them one at a time to avoid wiping each other's data.
        fileParallelism: false,
        testTimeout: 20_000,
        hookTimeout: 60_000,
    },
});
