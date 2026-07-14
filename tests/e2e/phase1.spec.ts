import { test, expect } from "@playwright/test";
import { login } from "./helpers";

test.describe("Phase 1: auth gate", () => {
  test("unauthenticated visit to /canon redirects to login", async ({ page }) => {
    await page.goto("/canon");
    await expect(page).toHaveURL(/\/login/);
  });

  test("wrong password shows an error and stays on login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByText("Incorrect password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("correct password logs in and reveals seeded style rules", async ({ page }) => {
    await login(page);
    await expect(
      page.getByText(/Never use em-dashes anywhere in prose/i),
    ).toBeVisible();
  });
});

test.describe("Phase 1: canon manager", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("seeded style rules render as locked", async ({ page }) => {
    // Filter to style_rule + locked to isolate the seeds.
    await page.getByLabel("Filter by type").selectOption("style_rule");
    // Wait for the combined type+status filtered response so a slower,
    // now-stale type-only response cannot land after it and overwrite the
    // list (mirrors the wait pattern in phase2.spec.ts "reorder persists
    // across reload").
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/canon") &&
          r.url().includes("type=style_rule") &&
          r.url().includes("status=locked") &&
          r.ok(),
      ),
      page.getByLabel("Filter by status").selectOption("locked"),
    ]);
    const rows = page.getByTestId("canon-row");
    await expect(rows).toHaveCount(5);
    // Each seeded row shows a locked status.
    for (let i = 0; i < 5; i++) {
      await expect(rows.nth(i).getByTestId("row-status")).toHaveText("locked");
    }
  });

  test("add a fact, lock it, then retire it", async ({ page }) => {
    const content = `Test rule ${Date.now()}`;
    await page.getByLabel("New fact type").selectOption("world_rule");
    await page.getByLabel("New fact content").fill(content);
    await page.getByLabel("New fact content").press("Enter");

    const row = page.getByTestId("canon-row").filter({ hasText: content });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("row-status")).toHaveText("provisional");

    await row.getByRole("button", { name: "Lock" }).click();
    await expect(row.getByTestId("row-status")).toHaveText("locked");

    await row.getByRole("button", { name: "Retire" }).click();
    await expect(row.getByTestId("row-status")).toHaveText("retired");
  });
});

test.describe("Phase 1: characters", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/characters");
  });

  test("create a character and add a state to its timeline", async ({ page }) => {
    const name = `Mara ${Date.now()}`;
    await page.getByRole("button", { name: "+ New character" }).click();
    await page.getByLabel("name").fill(name);
    await page.getByLabel("role").fill("fire elemental, POV");
    await page.getByRole("button", { name: "Create" }).click();

    const card = page.getByTestId("character-card").filter({ hasText: name });
    await expect(card).toHaveCount(1);

    await card.getByRole("button", { name: "Expand" }).click();
    await card.getByLabel("knows").fill("Julian's real name");
    await card.getByLabel("feels").fill("distrusts Julian");
    await card.getByRole("button", { name: "Add state" }).click();

    const timeline = card.getByTestId("state-timeline");
    await expect(timeline).toContainText("Julian's real name");
    await expect(timeline).toContainText("distrusts Julian");
  });
});
