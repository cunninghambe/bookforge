import { describe, it, expect } from "vitest";
import { isAuthConfigured, mustBlockForMissingAuthConfig } from "@/lib/authConfig";

describe("isAuthConfigured", () => {
  it("is true only when both secrets are present and non-empty", () => {
    expect(
      isAuthConfigured({ APP_PASSWORD: "pw", SESSION_SECRET: "secret" }),
    ).toBe(true);
  });

  it("is false when APP_PASSWORD is missing", () => {
    expect(isAuthConfigured({ SESSION_SECRET: "secret" })).toBe(false);
  });

  it("is false when SESSION_SECRET is missing", () => {
    expect(isAuthConfigured({ APP_PASSWORD: "pw" })).toBe(false);
  });

  it("is false when either is an empty string", () => {
    expect(isAuthConfigured({ APP_PASSWORD: "", SESSION_SECRET: "secret" })).toBe(
      false,
    );
    expect(isAuthConfigured({ APP_PASSWORD: "pw", SESSION_SECRET: "" })).toBe(
      false,
    );
  });

  it("is false when neither is set", () => {
    expect(isAuthConfigured({})).toBe(false);
  });
});

describe("mustBlockForMissingAuthConfig", () => {
  it("blocks in production when unconfigured", () => {
    expect(mustBlockForMissingAuthConfig("production", {})).toBe(true);
    expect(
      mustBlockForMissingAuthConfig("production", { APP_PASSWORD: "pw" }),
    ).toBe(true);
  });

  it("does not block in production when fully configured", () => {
    expect(
      mustBlockForMissingAuthConfig("production", {
        APP_PASSWORD: "pw",
        SESSION_SECRET: "secret",
      }),
    ).toBe(false);
  });

  it("never blocks in development, even when unconfigured", () => {
    expect(mustBlockForMissingAuthConfig("development", {})).toBe(false);
  });

  it("never blocks in test, even when unconfigured", () => {
    expect(mustBlockForMissingAuthConfig("test", {})).toBe(false);
  });

  it("never blocks when NODE_ENV is undefined", () => {
    expect(mustBlockForMissingAuthConfig(undefined, {})).toBe(false);
  });
});
