import { describe, it, expect } from "vitest";
import {
  GLOBAL_MAX_FAILURES,
  PER_KEY_MAX_FAILURES,
  WINDOW_MS,
  createThrottleState,
  decideLogin,
  recordFailure,
  recordSuccess,
  throttleKeyFrom,
} from "@/lib/loginThrottle";

// A23.7 / D191: decideLogin is pure, so the whole limiter is testable without a
// server, a clock, or a request. The route only supplies the state, the key,
// and the time.

const T0 = 1_700_000_000_000;

function failTimes(
  state: ReturnType<typeof createThrottleState>,
  key: string,
  n: number,
  nowMs: number,
): void {
  for (let i = 0; i < n; i++) recordFailure(state, key, nowMs);
}

describe("decideLogin: under the per-IP limit", () => {
  it("allows a first attempt against fresh state", () => {
    const state = createThrottleState(T0);
    expect(decideLogin(state, "1.2.3.4", T0)).toEqual({
      allow: true,
      retryAfterSec: 0,
    });
  });

  it("allows attempts while failures stay below the per-IP limit", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES - 1, T0);
    expect(decideLogin(state, "1.2.3.4", T0).allow).toBe(true);
  });

  it("never mutates the state it inspects", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", 3, T0);
    decideLogin(state, "1.2.3.4", T0);
    decideLogin(state, "1.2.3.4", T0);
    expect(state.perKey.get("1.2.3.4")?.count).toBe(3);
    expect(state.global.count).toBe(3);
  });
});

describe("decideLogin: over the per-IP limit", () => {
  it("blocks once the per-IP limit is reached", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    const decision = decideLogin(state, "1.2.3.4", T0);
    expect(decision.allow).toBe(false);
    expect(decision.retryAfterSec).toBe(WINDOW_MS / 1000);
  });

  it("reports the seconds remaining in the window, never zero", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    const midway = T0 + WINDOW_MS / 2;
    expect(decideLogin(state, "1.2.3.4", midway).retryAfterSec).toBe(
      WINDOW_MS / 2000,
    );
    const almostOver = T0 + WINDOW_MS - 1;
    expect(decideLogin(state, "1.2.3.4", almostOver).retryAfterSec).toBe(1);
  });
});

describe("decideLogin: per-IP isolation", () => {
  it("blocking one key leaves another key allowed", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    expect(decideLogin(state, "1.2.3.4", T0).allow).toBe(false);
    expect(decideLogin(state, "9.9.9.9", T0).allow).toBe(true);
  });

  it("a success clears only that key", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    failTimes(state, "5.6.7.8", PER_KEY_MAX_FAILURES, T0);
    recordSuccess(state, "1.2.3.4", T0);
    expect(decideLogin(state, "1.2.3.4", T0).allow).toBe(true);
    expect(decideLogin(state, "5.6.7.8", T0).allow).toBe(false);
  });
});

describe("decideLogin: the global bound", () => {
  it("blocks a brand new key once the global limit is reached", () => {
    const state = createThrottleState(T0);
    // X-Forwarded-For is attacker-controlled, so an attacker can mint a fresh
    // key per attempt. The global counter is what actually holds.
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      recordFailure(state, `10.0.0.${i}`, T0);
    }
    expect(decideLogin(state, "203.0.113.7", T0).allow).toBe(false);
    expect(decideLogin(state, "203.0.113.7", T0).retryAfterSec).toBe(
      WINDOW_MS / 1000,
    );
  });

  it("stays allowed one failure short of the global limit", () => {
    const state = createThrottleState(T0);
    for (let i = 0; i < GLOBAL_MAX_FAILURES - 1; i++) {
      recordFailure(state, `10.0.0.${i}`, T0);
    }
    expect(decideLogin(state, "203.0.113.7", T0).allow).toBe(true);
  });

  it("a success resets the global window so the owner is never stranded", () => {
    const state = createThrottleState(T0);
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      recordFailure(state, `10.0.0.${i}`, T0);
    }
    recordSuccess(state, "203.0.113.7", T0);
    expect(decideLogin(state, "203.0.113.7", T0).allow).toBe(true);
  });
});

describe("decideLogin: window expiry", () => {
  it("allows again once the per-IP window has aged out", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    expect(decideLogin(state, "1.2.3.4", T0 + WINDOW_MS - 1).allow).toBe(false);
    expect(decideLogin(state, "1.2.3.4", T0 + WINDOW_MS).allow).toBe(true);
  });

  it("allows again once the global window has aged out", () => {
    const state = createThrottleState(T0);
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) {
      recordFailure(state, `10.0.0.${i}`, T0);
    }
    expect(decideLogin(state, "203.0.113.7", T0 + WINDOW_MS - 1).allow).toBe(
      false,
    );
    expect(decideLogin(state, "203.0.113.7", T0 + WINDOW_MS).allow).toBe(true);
  });

  it("a failure in a fresh window starts the count over", () => {
    const state = createThrottleState(T0);
    failTimes(state, "1.2.3.4", PER_KEY_MAX_FAILURES, T0);
    const later = T0 + WINDOW_MS;
    recordFailure(state, "1.2.3.4", later);
    expect(state.perKey.get("1.2.3.4")?.count).toBe(1);
    expect(decideLogin(state, "1.2.3.4", later).allow).toBe(true);
  });

  it("failures spread across a rolling window still add up inside it", () => {
    const state = createThrottleState(T0);
    for (let i = 0; i < PER_KEY_MAX_FAILURES; i++) {
      recordFailure(state, "1.2.3.4", T0 + i * 1000);
    }
    expect(decideLogin(state, "1.2.3.4", T0 + 60_000).allow).toBe(false);
  });
});

describe("throttleKeyFrom", () => {
  it("uses the first X-Forwarded-For hop", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(throttleKeyFrom(h)).toBe("203.0.113.5");
  });

  it("falls back to X-Real-IP, then to a fixed bucket", () => {
    expect(throttleKeyFrom(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe(
      "198.51.100.2",
    );
    expect(throttleKeyFrom(new Headers())).toBe("unknown");
  });
});
