import { test, expect } from "@playwright/test";
import { login } from "./helpers";

// Amendment A11: universal search + command palette. Data is created through
// the API with the page's session cookies; the fixture LLM is never involved
// (search makes no LLM calls).

test.describe("A11 universal search and command palette", () => {
  test("finds chapter prose, navigates by keyboard, and drops superseded drafts", async ({
    page,
  }) => {
    await login(page);

    const chRes = await page.request.post("/api/chapters", {
      data: {
        projectId: 1,
        title: "The Silver Locket",
        synopsis: "An heirloom surfaces.",
      },
    });
    expect(chRes.ok()).toBeTruthy();
    const { chapter } = (await chRes.json()) as { chapter: { id: number } };
    const saveRes = await page.request.post(
      `/api/chapters/${chapter.id}/save-draft`,
      {
        data: {
          content:
            "She pried the floorboard loose and found the tarnished locket beneath.",
        },
      },
    );
    expect(saveRes.ok()).toBeTruthy();

    // Open with the shortcut, search, and confirm the match is highlighted.
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("tarnished locket");
    // Target THIS run's chapter by id, so a reused dev server with an
    // unwiped database cannot make the test click a stale twin.
    const result = page.locator(`[data-hit="chapter-${chapter.id}"]`);
    await expect(result).toBeVisible();
    await expect(result.locator("mark").first()).toBeVisible();

    // Open it and land on the chapter's draft page.
    await result.click();
    await expect(page).toHaveURL(
      new RegExp(`/book/1/chapter/${chapter.id}/draft`),
    );

    // Overwriting the working draft removes the hit: only the latest version
    // is searchable.
    await page.request.post(`/api/chapters/${chapter.id}/save-draft`, {
      data: { content: "The floorboard was empty." },
    });
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("tarnished");
    await expect(page.getByTestId("palette-empty")).toBeVisible();
  });

  test("a canon hit deep-links to /canon with the row highlighted", async ({
    page,
  }) => {
    await login(page);

    const factRes = await page.request.post("/api/canon", {
      data: {
        type: "world_rule",
        content: "Vermilion wax seals only royal decrees.",
        status: "locked",
      },
    });
    expect(factRes.ok()).toBeTruthy();
    const { fact } = (await factRes.json()) as { fact: { id: number } };

    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("vermilion wax");
    const result = page.locator(`[data-hit="canon-${fact.id}"]`);
    await expect(result).toBeVisible();
    await result.click();

    await expect(page).toHaveURL(
      new RegExp(`/canon\\?highlight=${fact.id}`),
    );
    const row = page.locator(`#fact-${fact.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Vermilion wax");
  });

  test("Esc closes; the TopNav button reopens; quick-nav reaches /settings", async ({
    page,
  }) => {
    await login(page);

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).not.toBeVisible();

    await page.getByTestId("nav-search").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("settings");
    // Arrow keys move the selection; down then up lands back on the first
    // item (the Settings quick-nav command), which Enter opens.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings/);
  });
});
