import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  passwordMatches,
  verifySessionToken,
} from "@/lib/auth";

const SECRET = "unit-test-secret-0000000000000000";

describe("auth", () => {
  it("round-trips a valid session token", async () => {
    const now = 1_000_000;
    const token = await createSessionToken(SECRET, now);
    expect(await verifySessionToken(token, SECRET, now + 10)).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const now = 1_000_000;
    const token = await createSessionToken(SECRET, now);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(await verifySessionToken(tampered, SECRET, now)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const now = 1_000_000;
    const token = await createSessionToken(SECRET, now);
    expect(await verifySessionToken(token, "other-secret", now)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const now = 1_000_000;
    const token = await createSessionToken(SECRET, now);
    const later = now + 60 * 60 * 24 * 31; // 31 days, past the 30 day max age
    expect(await verifySessionToken(token, SECRET, later)).toBe(false);
  });

  it("rejects missing or malformed tokens", async () => {
    expect(await verifySessionToken(undefined, SECRET, 0)).toBe(false);
    expect(await verifySessionToken("", SECRET, 0)).toBe(false);
    expect(await verifySessionToken("nodot", SECRET, 0)).toBe(false);
  });

  it("password matches only the exact string", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
    expect(passwordMatches("hunter2", "hunter3")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
    expect(passwordMatches("x", "")).toBe(false);
  });
});
