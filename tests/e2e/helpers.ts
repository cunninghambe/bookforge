import { type Page, expect } from "@playwright/test";

// Logs in through the gate using the E2E password from playwright.config.ts.
//
// Cold-start hardening: on a cold dev server the login form can render before
// React hydrates. A click that lands pre-hydration triggers a NATIVE form
// submit (no onSubmit handler attached yet), which never calls the login API
// and never navigates, so the page sits on /login forever. The fix is to treat
// "the login API responded" as proof the click landed on hydrated code, and to
// retry the fill-and-click sequence until it does. No assertion is weakened:
// reaching /canon is still required.
export async function login(page: Page) {
  const deadline = Date.now() + 120_000;
  await page.goto("/login");
  while (true) {
    await page.getByLabel("Password").fill("test-password");
    const apiResponse = page
      .waitForResponse((r) => r.url().includes("/api/auth/login"), {
        timeout: 10_000,
      })
      .catch(() => null);
    await page.getByRole("button", { name: "Enter" }).click();
    const resp = await apiResponse;
    if (resp && resp.ok()) break;
    if (resp && !resp.ok()) {
      // Diagnostic breadcrumb for cold-start investigation.
      console.log(
        `login API responded ${resp.status()}: ${await resp.text().catch(() => "(unreadable)")}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        "login never succeeded; the form kept submitting pre-hydration or the API kept failing",
      );
    }
    // The lost click may have caused a native submit that reloaded the page.
    await page.goto("/login");
  }
  await expect(page).toHaveURL(/\/canon/, { timeout: 30_000 });
}
