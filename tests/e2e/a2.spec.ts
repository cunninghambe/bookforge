import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

interface CreatedChapter {
  id: number;
  orderIndex: number;
}

async function createChapterWithDraft(
  page: Page,
  args: { projectId: number; title: string; content: string },
): Promise<CreatedChapter> {
  const res = await page.request.post("/api/chapters", {
    data: {
      projectId: args.projectId,
      title: args.title,
      pov: "omniscient",
      synopsis: "A chapter.",
      beats: ["A beat"],
    },
  });
  const chapter = (await res.json()).chapter as CreatedChapter;
  await page.request.post(`/api/chapters/${chapter.id}/save-draft`, {
    data: { content: args.content },
  });
  return chapter;
}

test.describe("Amendment A2", () => {
  // This spec sorts first in the suite, so it pays the Next dev server's cold
  // compile cost. Warm the routes the per-test login and the tests hit, with a
  // generous budget, so the 20s login helper below is never racing a cold compile.
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/login", { timeout: 90_000 });
    await page.getByLabel("Password").fill("test-password");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page).toHaveURL(/\/canon/, { timeout: 90_000 });
    await page.goto("/characters", { timeout: 90_000, waitUntil: "networkidle" });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // The mandatory A2.1 regression: entering "chapter 1" for a book's first chapter
  // (order_index 0) must store chapter_order 0 so the state applies to that very
  // chapter. Uses Book 2 (id 2), which no other e2e test touches, so the created
  // chapter is guaranteed to be that book's first (order_index 0).
  test("A2.1 regression: a state effective from chapter 1 applies to the book's first chapter prompt", async ({
    page,
  }) => {
    const uniq = Date.now();
    const charName = `Aeronmar${uniq}`;

    // The character must exist and appear in the chapter (POV) for its state to be
    // assembled into the prompt.
    await page.request.post("/api/characters", { data: { name: charName } });

    const chRes = await page.request.post("/api/chapters", {
      data: {
        projectId: 2,
        title: `A2 first ${uniq}`,
        pov: charName,
        synopsis: `${charName} enters the hall.`,
        beats: ["An arrival"],
      },
    });
    const chapter = (await chRes.json()).chapter as CreatedChapter;
    // Must be the book's first chapter for the regression to be meaningful: under
    // the old (buggy) convention, entering 1 stored 1, and 1 <= 0 is false, so the
    // state never applied to order_index 0.
    expect(chapter.orderIndex).toBe(0);

    const knows = `the sealed name ${uniq}`;

    // Add the state through the character page form, entering the 1-based number 1.
    await page.goto("/characters");
    const card = page
      .getByTestId("character-card")
      .filter({ hasText: charName })
      .first();
    await card.getByRole("button", { name: "Expand" }).click();
    await card.getByLabel("State book").selectOption("2");
    await card.getByLabel("Effective from chapter").fill("1");
    await card.getByLabel("knows").fill(knows);
    await card.getByRole("button", { name: "Add state" }).click();

    // The timeline displays it as chapter 1 (1-based).
    const timeline = card.getByTestId("state-timeline");
    await expect(timeline).toContainText(knows);
    await expect(timeline).toContainText("ch 1:");

    // And it is effective in the first chapter's assembled prompt.
    const res = await page.request.get(`/api/dev/prompt/${chapter.id}`);
    const assembled = await res.json();
    expect(JSON.stringify(assembled)).toContain(knows);
  });

  test("A2.1: the importer order field is 1-based (1 = first)", async ({ page }) => {
    await page.goto("/book/1/import");
    // The label speaks a 1-based position, never a 0-based order.
    await expect(page.getByText(/Position \(1 = first/)).toBeVisible();
    // The default value is 1-based: at least 1, never 0.
    const value = await page.getByTestId("import-order").inputValue();
    expect(Number(value)).toBeGreaterThanOrEqual(1);
  });

  // A2.2: a per-chapter LLM failure is reported with a reason and the run continues.
  // Uses Book 3 (id 3), untouched by other tests, so the two created chapters are
  // that book's first two (order_index 0 and 1, sweep positions 1 and 2). Fixture
  // sweep.a2err.2.json exists (chapter 2, clean); sweep.a2err.1.json is deliberately
  // absent, so chapter 1's fixture load throws and surfaces as an error entry.
  test("A2.2: a per-chapter sweep failure is reported with a reason and does not abort the run", async ({
    page,
  }) => {
    const uniq = Date.now();
    const a = await createChapterWithDraft(page, {
      projectId: 3,
      title: `Sweep err A ${uniq}`,
      content: "The first chapter text.",
    });
    const b = await createChapterWithDraft(page, {
      projectId: 3,
      title: `Sweep err B ${uniq}`,
      content: "The second chapter text.",
    });
    expect(b.orderIndex).toBe(a.orderIndex + 1);

    for (const id of [a.id, b.id]) {
      const res = await page.request.post(`/api/chapters/${id}/lock`, {
        data: { fixtureKey: "phase5" },
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.goto("/book/3/sweep?fx=a2err");
    await page.getByTestId("sweep-from").selectOption(String(a.orderIndex));
    await page.getByTestId("sweep-to").selectOption(String(b.orderIndex));
    await expect(page.getByTestId("sweep-estimate")).toContainText("2 chapters");

    await page.getByTestId("run-sweep").click();
    await expect(page.getByTestId("sweep-report")).toBeVisible();

    // Chapter A (position 1) has no fixture: its failure is reported with a reason.
    const errRegion = page.getByTestId(`sweep-error-${a.id}`);
    await expect(errRegion).toBeVisible();
    await expect(errRegion).toContainText("ENOENT");

    // Chapter B (position 2) was still processed: the run did not abort. It is clean.
    await expect(page.getByTestId(`sweep-clean-${b.id}`)).toBeVisible();

    // The bare, reasonless failure string is never shown.
    await expect(page.getByTestId("sweep-error")).toHaveCount(0);
  });
});
