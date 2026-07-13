import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

interface CreatedChapter {
  id: number;
  orderIndex: number;
}

async function createChapter(
  page: Page,
  args: { title: string; pov?: string; synopsis?: string; beats?: string[] },
): Promise<CreatedChapter> {
  const res = await page.request.post("/api/chapters", {
    data: {
      projectId: 1,
      title: args.title,
      pov: args.pov ?? "Mara",
      synopsis: args.synopsis ?? "Mara climbs the tower.",
      beats: args.beats ?? ["She climbs", "She reads the ledger"],
    },
  });
  return (await res.json()).chapter as CreatedChapter;
}

async function createChapterWithDraft(
  page: Page,
  title: string,
  content: string,
): Promise<CreatedChapter> {
  const chapter = await createChapter(page, { title });
  await page.request.post(`/api/chapters/${chapter.id}/save-draft`, {
    data: { content },
  });
  return chapter;
}

async function createNamedCharacter(page: Page, name: string): Promise<number> {
  const res = await page.request.post("/api/characters", { data: { name } });
  return (await res.json()).character.id as number;
}

test.describe("Phase 6: backfill importer and export", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("import a chapter: paste, confirm, then approve one fact and one state via keyboard only", async ({
    page,
  }) => {
    // Mara must already exist so the extracted state auto-matches (Amendment A1),
    // same as the Phase 5 lock-time flow.
    await createNamedCharacter(page, "Mara");

    await page.goto("/book/1/import?fx=import1");

    const title = `Backfilled chapter ${Date.now()}`;
    await expect(page.getByTestId("import-title")).toBeFocused();
    await page.getByTestId("import-title").fill(title);
    await page
      .getByTestId("import-content")
      .fill("Mara reaches the harbor at dawn and confronts the harbormaster.");
    await page.getByTestId("import-button").click();

    await expect(page.getByTestId("import-summary")).toContainText(
      "diverted three nights earlier",
    );
    await expect(page.getByTestId("import-extraction-panel")).toBeVisible();
    await expect(page.getByTestId("import-fact-proposal-0")).toContainText(
      "harbor shipment was diverted",
    );
    await expect(page.getByTestId("import-state-proposal-0")).toContainText("Mara");
    await expect(page.getByTestId("import-state-unmatched-0")).toHaveCount(0);

    // Sensible focus flow: the first proposal row already has focus.
    await expect(page.getByTestId("import-fact-proposal-0")).toBeFocused();

    // Keyboard only from here: approve the focused fact, arrow down to the state
    // row, approve it too.
    await page.keyboard.press("a");
    await expect(page.getByTestId("import-fact-approve-0")).toBeChecked();

    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("import-state-proposal-0")).toBeFocused();
    await page.keyboard.press("a");
    await expect(page.getByTestId("import-state-approve-0")).toBeChecked();

    // Arrow back up and reject, then re-approve, proving both directions and both
    // shortcuts work from the keyboard.
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("import-fact-proposal-0")).toBeFocused();
    await page.keyboard.press("r");
    await expect(page.getByTestId("import-fact-approve-0")).not.toBeChecked();
    await page.keyboard.press("a");
    await expect(page.getByTestId("import-fact-approve-0")).toBeChecked();

    await page.getByTestId("import-approve-button").click();
    await expect(page.getByTestId("import-approve-success")).toBeVisible();

    // The fact lands as locked canon.
    await page.goto("/canon");
    const row = page
      .getByTestId("canon-row")
      .filter({ hasText: "harbor shipment was diverted on Bellamy" });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "locked");

    // The state lands in Mara's timeline.
    await page.goto("/characters");
    const card = page.getByTestId("character-card").filter({ hasText: "Mara" }).first();
    await card.getByRole("button", { name: "Expand" }).click();
    await expect(card.getByTestId("state-timeline")).toContainText(
      "Bellamy diverted the harbor shipment",
    );
  });

  test("importing three chapters back-to-back resets the flow cleanly each time", async ({
    page,
  }) => {
    await page.goto("/book/1/import?fx=import2");

    for (let i = 1; i <= 3; i++) {
      await expect(page.getByTestId("import-title")).toBeEnabled();
      await expect(page.getByTestId("import-title")).toBeFocused();
      await expect(page.getByTestId("import-title")).toHaveValue("");
      await expect(page.getByTestId("import-content")).toHaveValue("");
      await expect(page.getByTestId("import-count")).toContainText(
        `Imported this session: ${i - 1}`,
      );

      await page.getByTestId("import-title").fill(`Backfill batch ${i} ${Date.now()}`);
      await page
        .getByTestId("import-content")
        .fill(`Pasted text for backfilled chapter number ${i}.`);
      await page.getByTestId("import-button").click();

      await expect(page.getByTestId("import-summary")).toBeVisible();
      await expect(page.getByTestId("import-finish-button")).toBeVisible();

      await page.getByTestId("import-finish-button").click();
      await expect(page.getByTestId("import-count")).toContainText(
        `Imported this session: ${i}`,
      );
    }

    // Ready for a fourth paste: form is clear and focused.
    await expect(page.getByTestId("import-title")).toHaveValue("");
    await expect(page.getByTestId("import-content")).toHaveValue("");
    await expect(page.getByTestId("import-title")).toBeFocused();
  });

  test("export produces a single Markdown file with both chapter headings and text in reading order", async ({
    page,
  }) => {
    const titleA = `Export A ${Date.now()}`;
    const titleB = `Export B ${Date.now()}`;
    const a = await createChapterWithDraft(page, titleA, "The first chapter's prose.");
    const b = await createChapterWithDraft(page, titleB, "The second chapter's prose.");
    for (const id of [a.id, b.id]) {
      const res = await page.request.post(`/api/chapters/${id}/lock`, {
        data: { fixtureKey: "phase5" },
      });
      expect(res.ok()).toBeTruthy();
    }

    await page.goto("/book/1");
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-button").click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();
    const text = readFileSync(path as string, "utf8");

    expect(text).toContain(`## ${titleA}`);
    expect(text).toContain(`## ${titleB}`);
    expect(text).toContain("The first chapter's prose.");
    expect(text).toContain("The second chapter's prose.");
    expect(text.indexOf(titleA)).toBeLessThan(text.indexOf("first chapter's prose"));
    expect(text.indexOf("first chapter's prose")).toBeLessThan(text.indexOf(titleB));
    expect(text.indexOf(titleB)).toBeLessThan(text.indexOf("second chapter's prose"));
  });
});
