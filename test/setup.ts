// Runs inside every test file (vitest `setupFiles`). After each test, fail it if any response
// broke the documented API contract (see test/contract.ts).

import { afterEach, expect } from "vitest";
import { contractViolations } from "./contract.js";

afterEach(() => {
    const violations = contractViolations.splice(0); // read and clear
    expect(violations, "Responses that don't match the API docs (src/docs/)").toEqual([]);
});
