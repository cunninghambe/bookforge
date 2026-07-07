import { type Page, expect } from "@playwright/test";

// Logs in through the gate using the E2E password from playwright.config.ts.
export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page).toHaveURL(/\/canon/);
}
