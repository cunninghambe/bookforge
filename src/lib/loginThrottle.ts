// A23.7 / D191: login throttling. The decision is a pure function over an
// explicit state object so it is unit testable the way the rest of this repo
// tests its rules; the login route owns one module-level state value, which is
// correct because DEPLOY.md pins exactly one pm2 instance (shared storage would
// be ceremony for a single-process, single-user app).
//
// Two counters, both over a fixed 15 minute window:
//   * per key (the client IP): 10 failures, then blocked for the rest of the
//     window. This is the useful signal in normal operation.
//   * global: 50 failures, then everything is blocked for the rest of the
//     window. X-Forwarded-For is attacker-controlled, so an attacker can mint
//     an unlimited number of per-IP buckets; the global bound is the one that
//     actually holds.
// Backoff is fixed rather than exponential: the window itself is the backoff,
// and Retry-After reports the exact seconds left in it. The password is long
// and random (D191), so this is cost control and a detection signal, not
// credential defense.
//
// D193: the route consults this AFTER checking the password, and only on a
// failed attempt, so a correct password is never throttled. Read decideLogin as
// "should this FAILURE be answered with 429 instead of 401", not as a gate in
// front of the credential check.

export const WINDOW_MS = 15 * 60 * 1000;
export const PER_KEY_MAX_FAILURES = 10;
export const GLOBAL_MAX_FAILURES = 50;

export interface ThrottleWindow {
  count: number;
  windowStartMs: number;
}

export interface ThrottleState {
  perKey: Map<string, ThrottleWindow>;
  global: ThrottleWindow;
}

export interface LoginDecision {
  allow: boolean;
  // Seconds until the blocking window expires. 0 when allowed.
  retryAfterSec: number;
}

export function createThrottleState(nowMs = 0): ThrottleState {
  return {
    perKey: new Map(),
    global: { count: 0, windowStartMs: nowMs },
  };
}

// A window that has aged out counts as empty. Reading never mutates: expiry is
// applied when a failure is recorded.
function liveCount(w: ThrottleWindow | undefined, nowMs: number): number {
  if (!w) return 0;
  if (nowMs - w.windowStartMs >= WINDOW_MS) return 0;
  return w.count;
}

function retryAfterSec(w: ThrottleWindow, nowMs: number): number {
  const remainingMs = w.windowStartMs + WINDOW_MS - nowMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

// Pure: does this attempt get to reach the password check? Never mutates state.
export function decideLogin(
  state: ThrottleState,
  key: string,
  nowMs: number,
): LoginDecision {
  if (liveCount(state.global, nowMs) >= GLOBAL_MAX_FAILURES) {
    return { allow: false, retryAfterSec: retryAfterSec(state.global, nowMs) };
  }
  const w = state.perKey.get(key);
  if (w && liveCount(w, nowMs) >= PER_KEY_MAX_FAILURES) {
    return { allow: false, retryAfterSec: retryAfterSec(w, nowMs) };
  }
  return { allow: true, retryAfterSec: 0 };
}

function bump(w: ThrottleWindow, nowMs: number): void {
  if (nowMs - w.windowStartMs >= WINDOW_MS) {
    w.count = 0;
    w.windowStartMs = nowMs;
  }
  w.count += 1;
}

export function recordFailure(
  state: ThrottleState,
  key: string,
  nowMs: number,
): void {
  bump(state.global, nowMs);
  const existing = state.perKey.get(key);
  if (existing) {
    bump(existing, nowMs);
    return;
  }
  state.perKey.set(key, { count: 1, windowStartMs: nowMs });
  // Bound the map so a spoofed-XFF flood cannot grow it without limit. Losing
  // an entry only forgives that key's failures; the global counter is
  // unaffected, so the bound that matters still holds.
  while (state.perKey.size > 1000) {
    const oldest = state.perKey.keys().next().value;
    if (oldest === undefined) break;
    state.perKey.delete(oldest);
  }
}

// A success clears that key's failures and resets the global window. Only the
// real password produces a success, so an attacker cannot use this to clear
// their own counters; it exists so a global block can never strand the owner
// once they do get through.
export function recordSuccess(
  state: ThrottleState,
  key: string,
  nowMs: number,
): void {
  state.perKey.delete(key);
  state.global.count = 0;
  state.global.windowStartMs = nowMs;
}

// The throttle key: the first X-Forwarded-For hop when the proxy set one, else
// the direct peer if the runtime exposed it. Attacker-controlled by design (see
// the global bound above); it exists so honest clients are bucketed apart.
export function throttleKeyFrom(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
