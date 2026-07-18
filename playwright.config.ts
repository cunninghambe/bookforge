import { defineConfig } from "@playwright/test";

// E2E runs against a dev server started with a throwaway DB and a known password.
// The webServer block boots the app; env vars are set so tests are deterministic
// and never touch the real Anthropic API (USE_FIXTURE_LLM=1).
//
// A15: two projects share that one server. "desktop" is the pre-A15 suite,
// unchanged, minus the new mobile spec (testIgnore). "mobile" is an
// iPhone-class viewport (390x844, deviceScaleFactor 3, touch, a mobile Safari
// UA) that runs ONLY tests/e2e/a15-mobile.spec.ts (testMatch). The settings are
// manual (the iPhone 13 numbers) rather than the devices["iPhone 13"] preset,
// because the preset also sets defaultBrowserType: "webkit" and only Chromium
// is installed on the test machines; running both projects on one engine also
// keeps the suite's flake profile uniform. workers stay at 1 globally, so the
// two projects still execute strictly one test at a time, preserving the
// existing non-parallel execution model.
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
  projects: [
    {
      name: "desktop",
      testIgnore: /a15-mobile\.spec\.ts$/,
    },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
      },
      testMatch: /a15-mobile\.spec\.ts$/,
    },
  ],
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
      // A14: non-empty URLs so the listen and voice-note surfaces show. Fixture
      // mode (USE_FIXTURE_LLM=1) short-circuits both bridges before any network
      // call, so these hosts are never actually contacted.
      TTS_SERVICE_URL: "http://fixture.invalid",
      STT_SERVICE_URL: "http://fixture.invalid",
    },
  },
});
