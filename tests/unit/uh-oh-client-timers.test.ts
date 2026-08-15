import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@/lib/uh-oh-client";

// Regression: the client's timer seams defaulted to UNBOUND native globals, so
// invoking them as methods (this.setIntervalFn(...)) handed the browser a
// wrong `this` and threw "TypeError: Illegal invocation". Node's timers do not
// brand-check their receiver, so these fakes reproduce the browser rule:
// `this === undefined` is substituted with the global, anything else throws.

type TimerName = "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval";
type TimerFn = (...args: unknown[]) => unknown;

// Captured before any stubbing so the fakes can delegate to the real timers,
// which keeps the Node event loop working while the client drains.
const realTimers: Record<TimerName, TimerFn> = {
  setTimeout: globalThis.setTimeout as unknown as TimerFn,
  clearTimeout: globalThis.clearTimeout as unknown as TimerFn,
  setInterval: globalThis.setInterval as unknown as TimerFn,
  clearInterval: globalThis.clearInterval as unknown as TimerFn,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Client timer seams", () => {
  it("never invokes a native timer with a non-global `this`", async () => {
    const calls: Record<TimerName, number> = {
      setTimeout: 0,
      clearTimeout: 0,
      setInterval: 0,
      clearInterval: 0,
    };
    const violations: TimerName[] = [];

    // Declared with `function` (not an arrow) so the fake sees its receiver.
    const brandEnforcing = (name: TimerName): TimerFn =>
      function branded(this: unknown, ...args: unknown[]): unknown {
        calls[name] += 1;
        if (this !== undefined && this !== globalThis) {
          violations.push(name);
          throw new TypeError("Illegal invocation");
        }
        return Reflect.apply(realTimers[name], undefined, args);
      };

    for (const name of Object.keys(realTimers) as TimerName[]) {
      vi.stubGlobal(name, brandEnforcing(name));
    }

    // Every timer dep is left unset on purpose: the constructor defaults are
    // exactly what is under test here. install() is deliberately not called.
    const client = new Client(
      { dsn: "https://pk@uh-oh.invalid/p1", release: "0.0.0+test" },
      { fetchFn: () => Promise.reject(new Error("offline")) },
    );

    // Enqueue, drain, fetch rejects, the queue stays non-empty, so the retry
    // interval gets armed. That is the path that crashed in browsers.
    client.captureMessage("boom");
    await client.flush(50);

    expect(violations).toEqual([]);
    // Guards against a vacuous pass: the retry-timer path must have run.
    expect(calls.setInterval).toBeGreaterThan(0);

    client.close();
  });
});
