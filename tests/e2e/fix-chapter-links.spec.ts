import { test, expect } from "@playwright/test";
import { login } from "./helpers";

// Regression: the sequencer's chapter titles were plain text, so a book whose
// chapters were all locked (an imported finished book) had no clickable path
// into any chapter. Titles are now links: pipeline chapters open the draft
// surface, locked and in-review chapters open the reading/notes surface.

test.describe("Sequencer chapter title links", () => {
  test("a planned chapter's title opens draft; a locked chapter's title opens review", async ({
    page,
  }) => {
    await login(page);

    const planned = await (
      await page.request.post("/api/chapters", {
        data: { projectId: 2, title: "Link Target Planned" },
      })
    ).json();
    const locked = await (
      await page.request.post("/api/chapters", {
        data: { projectId: 2, title: "Link Target Locked" },
      })
    ).json();
    await page.request.post(`/api/chapters/${locked.chapter.id}/save-draft`, {
      data: { content: "Prose that will be locked for the link test." },
    });
    await page.request.post(`/api/chapters/${locked.chapter.id}/lock`, {
      data: { fixtureKey: "phase5" },
    });

    await page.goto("/book/2");
    const plannedRow = page.locator(
      `[data-testid="chapter-row"][data-chapter-id="${planned.chapter.id}"]`,
    );
    await expect(
      plannedRow.getByTestId("chapter-open-link"),
    ).toHaveAttribute(
      "href",
      `/book/2/chapter/${planned.chapter.id}/draft`,
    );

    const lockedRow = page.locator(
      `[data-testid="chapter-row"][data-chapter-id="${locked.chapter.id}"]`,
    );
    await expect(
      lockedRow.getByTestId("chapter-open-link"),
    ).toHaveAttribute(
      "href",
      `/book/2/chapter/${locked.chapter.id}/review`,
    );

    // And the click actually lands on the reading surface.
    await lockedRow.getByTestId("chapter-open-link").click();
    await expect(page).toHaveURL(
      new RegExp(`/book/2/chapter/${locked.chapter.id}/review`),
    );
    await expect(page.getByTestId("review-prose")).toBeVisible();
  });
});
