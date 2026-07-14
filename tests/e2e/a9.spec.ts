import { test, expect } from "@playwright/test";
import { login } from "./helpers";

// Amendment A9: light/dark theme. The toggle flips the dark class on <html>
// immediately and persists it in a long-lived plain cookie. The root layout reads
// that cookie server-side and stamps the class at render, so a themed request
// arrives with the class already present (no flash of the wrong theme).

function isDark(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
}

test.describe("Amendment A9: theme toggle and no-flash server render", () => {
  test("toggle flips the html class and persists across reload and navigation", async ({
    page,
  }) => {
    await login(page);

    // Fresh session, no theme cookie yet: starts light.
    expect(await isDark(page)).toBe(false);

    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // Flips immediately, no reload.
    expect(await isDark(page)).toBe(true);

    // Persists across a full reload (cookie + server render).
    await page.reload();
    expect(await isDark(page)).toBe(true);

    // Persists across a navigation to another page.
    await page.getByRole("link", { name: "Characters" }).click();
    await expect(page).toHaveURL(/\/characters/);
    expect(await isDark(page)).toBe(true);

    // Toggle back to light and confirm it sticks across a reload.
    await page.getByTestId("theme-toggle").click();
    expect(await isDark(page)).toBe(false);
    await page.reload();
    expect(await isDark(page)).toBe(false);
  });

  test("a server-rendered request with the dark cookie set arrives already dark", async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId("theme-toggle").click();
    expect(await isDark(page)).toBe(true);

    // The toggle wrote the cookie into this browser context. page.request shares
    // that context, so the raw server-rendered HTML already carries the class.
    const homeRes = await page.request.get("/");
    const homeHtml = await homeRes.text();
    expect(homeHtml).toMatch(/<html[^>]*class="dark"/);

    // The login page is public and pre-auth themed the same way.
    const loginRes = await page.request.get("/login");
    const loginHtml = await loginRes.text();
    expect(loginHtml).toMatch(/<html[^>]*class="dark"/);
  });
});
