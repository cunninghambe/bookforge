import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

async function addChapter(page: Page, title: string) {
  await page.getByTestId("add-chapter-input").fill(title);
  await page.getByTestId("add-chapter-button").click();
  const row = page.getByTestId("chapter-row").filter({ hasText: title });
  await expect(row).toHaveCount(1);
  return row;
}

test.describe("Phase 2: sequencer", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/book/1");
  });

  test("create a chapter with synopsis and beats, persisted across reload", async ({
    page,
  }) => {
    const title = `Chapter ${Date.now()}`;
    const row = await addChapter(page, title);
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByTestId("pov-input").fill("Mara");
    await row.getByTestId("synopsis-input").fill("Mara enters the hall.");
    await row.getByTestId("beat-input").fill("She hides her flame");
    await row.getByTestId("add-beat").click();
    await row.getByTestId("beat-input").fill("Julian arrives");
    await row.getByTestId("add-beat").click();
    await row.getByTestId("save-chapter").click();
    await expect(row.getByText("Saved")).toBeVisible();

    await page.reload();
    const row2 = page.getByTestId("chapter-row").filter({ hasText: title });
    await row2.getByRole("button", { name: "Edit" }).click();
    await expect(row2.getByTestId("synopsis-input")).toHaveValue(
      "Mara enters the hall.",
    );
    await expect(row2.getByTestId("beat-item")).toHaveCount(2);
  });

  test("reorder persists across reload", async ({ page }) => {
    const t1 = `First ${Date.now()}`;
    const t2 = `Second ${Date.now()}`;
    await addChapter(page, t1);
    await addChapter(page, t2);

    // t1 was added first so it sits above t2. Move t1 down, and wait for the
    // reorder POST to complete so the reload cannot race the persistence.
    const row1 = page.getByTestId("chapter-row").filter({ hasText: t1 });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/chapters/reorder") && r.ok(),
      ),
      row1.getByTestId("move-down").click(),
    ]);

    await page.reload();
    const titles = await page.getByTestId("chapter-title").allInnerTexts();
    expect(titles.indexOf(t2)).toBeLessThan(titles.indexOf(t1));
  });

  test("interrogation returns questions; answering makes a provisional fact that locks", async ({
    page,
  }) => {
    const title = `Interrogate ${Date.now()}`;
    const row = await addChapter(page, title);
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByTestId("interrogate-button").click();

    const questions = row.getByTestId("question-item");
    await expect(questions).toHaveCount(3);

    const first = questions.first();
    await first.getByTestId("answer-input").fill("Yes, she knows.");
    await first.getByTestId("save-answer").click();

    const fact = first.getByTestId("resulting-fact");
    await expect(fact).toBeVisible();
    await expect(fact.getByTestId("fact-status")).toHaveText("provisional");

    await first.getByTestId("lock-fact-button").click();
    await expect(fact.getByTestId("fact-status")).toHaveText("locked");
  });
});
