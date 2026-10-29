import { describe, expect, it } from "vitest";
import { BusyError, inFlight, perKey } from "../src/shared/keyed-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const one = { concurrency: 1, maxWaiting: 100 };

describe("perKey", () => {
    it("with concurrency 1, runs callers for one key strictly one after another, in arrival order", async () => {
        const events: string[] = [];
        const job = (name: string) => perKey("train-1:AC3", one, async () => {
            events.push(`${name} start`);
            await sleep(10);
            events.push(`${name} end`);
            return name;
        });
        expect(await Promise.all([job("a"), job("b"), job("c")])).toEqual(["a", "b", "c"]);
        expect(events).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
        expect(inFlight("train-1:AC3")).toBe(0); // the key is forgotten once nobody is left
    });

    it("never runs more than `concurrency` at once, and starts the rest in arrival order", async () => {
        let running = 0;
        let peak = 0;
        const order: number[] = [];
        await Promise.all(Array.from({ length: 8 }, (_, i) => perKey("k2", { concurrency: 2, maxWaiting: 100 }, async () => {
            order.push(i);
            running += 1;
            peak = Math.max(peak, running);
            await sleep(5);
            running -= 1;
        })));
        expect(peak).toBe(2);
        expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it("runs different keys in parallel", async () => {
        const started: string[] = [];
        const job = (key: string) => perKey(key, one, async () => { started.push(key); await sleep(20); });
        const all = Promise.all([job("x"), job("y")]);
        await sleep(5);
        expect(started.sort()).toEqual(["x", "y"]);
        await all;
    });

    it("keeps going after a caller fails", async () => {
        const failing = perKey("k", one, async () => { throw new Error("boom"); });
        const next = perKey("k", one, async () => "ok");
        await expect(failing).rejects.toThrow("boom");
        expect(await next).toBe("ok");
    });

    it("refuses with 503 TRAIN_BUSY once the line is full", async () => {
        const limits = { concurrency: 1, maxWaiting: 2 };
        const slow = Array.from({ length: 3 }, () => perKey("busy", limits, () => sleep(30))); // 1 running + 2 waiting
        const refused = perKey("busy", limits, async () => "never");
        await expect(refused).rejects.toBeInstanceOf(BusyError);
        await expect(refused).rejects.toMatchObject({ statusCode: 503, code: "TRAIN_BUSY", retryAfterSeconds: 1 });
        await Promise.all(slow);
        expect(await perKey("busy", limits, async () => "room again")).toBe("room again");
    });
});
