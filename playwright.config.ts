import { defineConfig } from "@playwright/test";

// E2E runs against a dev server started with a throwaway DB and a known password.
// The webServer block boots the app; env vars are set so tests are deterministic
// and never touch the real Anthropic API (USE_FIXTURE_LLM=1).
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      APP_PASSWORD: "test-password",
      SESSION_SECRET: "test-secret-do-not-use-in-prod-0000000000000000",
      DATABASE_PATH: "./data/test-e2e.db",
      USE_FIXTURE_LLM: "1",
      ANTHROPIC_API_KEY: "sk-ant-fixture-not-real",
      DRAFT_MODEL: "claude-sonnet-4-6",
      UTILITY_MODEL: "claude-sonnet-4-6",
    },
  },
});
