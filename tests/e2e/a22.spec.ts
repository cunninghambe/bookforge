import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A22: desk-first inline review. A floating toolbar appears over a prose
// selection with Comment and Suggest edit actions; c and e open the composers from
// the keyboard; a suggestion is the author's exact text and applies mechanically
// with no model call; unresolved comments and suggestions render as inline anchors.
// The static "Selected span" panel and every existing spec stay green unchanged
// (exercised by phase4/phase5/a21); these tests cover only the new surface, so the
// apply-suggestions path needs no LLM fixture.

const PLAIN = "The gate stood open in the grey light and the road ran on.";

async function createChapterWithDraft(page: Page, title: string, content: string) {
  const res = await page.request.post("/api/chapters", {
    data: {
      projectId: 1,
      title,
      pov: "Mara",
      synopsis: "Mara climbs the tower.",
      beats: ["She climbs", "She reaches the top"],
    },
  });
  const id = (await res.json()).chapter.id as number;
  const draftRes = await page.request.post(`/api/chapters/${id}/save-draft`, {
    data: { content },
  });
  const draftId = (await draftRes.json()).draft.id as number;
  return { id, draftId };
}

// Selects `phrase` inside the review prose by finding the first text node that
// contains it, then notifies the component as a real mouse selection would. Reused
// from the A21/phase4 helper technique.
async function selectText(page: Page, phrase: string) {
  await page.evaluate((p) => {
    const el = document.querySelector('[data-testid="review-prose"]');
    if (!el) throw new Error("prose not found");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const txt = node.textContent ?? "";
      const idx = txt.indexOf(p);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + p.length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }
    throw new Error("phrase not found in prose: " + p);
  }, phrase);
}

test.describe("Amendment A22: desk-first inline review", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("a selection shows the floating toolbar with both actions", async ({
    page,
  }) => {
    const { id } = await createChapterWithDraft(page, `A22 toolbar ${Date.now()}`, PLAIN);
    await page.goto(`/book/1/chapter/${id}/review`);

    await selectText(page, "gate stood open");
    await expect(page.getByTestId("selection-toolbar")).toBeVisible();
    await expect(page.getByTestId("toolbar-comment-button")).toBeVisible();
    await expect(page.getByTestId("toolbar-suggest-button")).toBeVisible();
    // A22.4: the shortcuts are discoverable on screen, not only in muscle memory:
    // key-cap chips on the toolbar buttons and a standing hint line under the prose.
    await expect(
      page.getByTestId("toolbar-comment-button").locator("kbd"),
    ).toHaveText("c");
    await expect(
      page.getByTestId("toolbar-suggest-button").locator("kbd"),
    ).toHaveText("e");
    await expect(page.getByTestId("shortcut-hints")).toBeVisible();
    await expect(page.getByTestId("shortcut-hints")).toContainText("Select a passage");
    // The static panel is still the fallback surface and captured the same span.
    await expect(page.getByTestId("selected-span")).toHaveText("gate stood open");
  });

  test("the comment path stores a comment and shows an inline anchor", async ({
    page,
  }) => {
    const { id } = await createChapterWithDraft(page, `A22 comment ${Date.now()}`, PLAIN);
    await page.goto(`/book/1/chapter/${id}/review`);

    await selectText(page, "grey light");
    await page.getByTestId("toolbar-comment-button").click();
    await expect(page.getByTestId("inline-composer")).toBeVisible();
    await page.getByTestId("inline-comment-input").fill("Soften this image.");
    await page.getByTestId("inline-composer-submit").click();

    await expect(page.getByTestId("comment-list")).toContainText("Soften this image.");
    // The unresolved comment renders as a tinted anchor over its exact span.
    const anchor = page.locator(
      '[data-testid="review-prose"] [data-anchor-ids]',
    );
    await expect(anchor).toHaveCount(1);
    await expect(anchor.first()).toHaveText("grey light");
  });

  test("the suggest path prefills, submits, applies, and updates the prose", async ({
    page,
  }) => {
    const { id } = await createChapterWithDraft(page, `A22 suggest ${Date.now()}`, PLAIN);
    await page.goto(`/book/1/chapter/${id}/review`);

    await selectText(page, "grey light");
    await page.getByTestId("toolbar-suggest-button").click();
    await expect(page.getByTestId("inline-composer")).toBeVisible();
    // The suggest field is prefilled with the raw selected text.
    await expect(page.getByTestId("inline-suggest-input")).toHaveValue("grey light");

    await page.getByTestId("inline-suggest-input").fill("pale dawn");
    await page.getByTestId("inline-note-input").fill("Try a warmer image.");
    await page.getByTestId("inline-composer-submit").click();

    // The sidebar card carries the suggestion badge and shows the replacement.
    await expect(page.getByTestId("comment-list")).toContainText("Suggestion");
    await expect(page.getByTestId("comment-list")).toContainText("pale dawn");

    // Apply mechanically: the prose swaps to the author's exact words, no model call.
    await page.getByTestId("apply-suggestions-button").click();
    await expect(page.getByTestId("suggestions-applied")).toContainText(
      "1 suggestion applied",
    );
    const text = await page
      .getByTestId("review-prose")
      .evaluate((el) => el.textContent ?? "");
    expect(text).toContain("pale dawn");
    expect(text).not.toContain("grey light");
  });

  test("a not-found suggestion is skipped and reported", async ({ page }) => {
    const { id, draftId } = await createChapterWithDraft(
      page,
      `A22 skip ${Date.now()}`,
      PLAIN,
    );
    // One anchorable suggestion and one whose quote is absent, created directly.
    await page.request.post(`/api/drafts/${draftId}/comments`, {
      data: { quotedText: "the road", suggestedText: "the lane", comment: "" },
    });
    await page.request.post(`/api/drafts/${draftId}/comments`, {
      data: {
        quotedText: "a phrase that is absent",
        suggestedText: "never applied",
        comment: "",
      },
    });
    await page.goto(`/book/1/chapter/${id}/review`);

    await page.getByTestId("apply-suggestions-button").click();
    await expect(page.getByTestId("suggestions-applied")).toContainText(
      "1 suggestion applied",
    );
    await expect(page.getByTestId("suggestion-skips")).toBeVisible();
    await expect(page.getByTestId("suggestion-skips")).toContainText("not found");

    const text = await page
      .getByTestId("review-prose")
      .evaluate((el) => el.textContent ?? "");
    expect(text).toContain("the lane");
  });

  test("c and e open the composers and Escape closes them", async ({ page }) => {
    const { id } = await createChapterWithDraft(page, `A22 keys ${Date.now()}`, PLAIN);
    await page.goto(`/book/1/chapter/${id}/review`);

    await selectText(page, "gate stood open");
    await page.keyboard.press("c");
    await expect(page.getByTestId("inline-comment-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inline-composer")).toHaveCount(0);

    await selectText(page, "gate stood open");
    await page.keyboard.press("e");
    await expect(page.getByTestId("inline-suggest-input")).toBeVisible();
    await expect(page.getByTestId("inline-suggest-input")).toHaveValue(
      "gate stood open",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inline-composer")).toHaveCount(0);
  });

  test("the revise button stays disabled when only suggestions are pending", async ({
    page,
  }) => {
    const { id, draftId } = await createChapterWithDraft(
      page,
      `A22 gate ${Date.now()}`,
      PLAIN,
    );
    // Only a suggestion pends: revise has nothing to do, but apply does.
    await page.request.post(`/api/drafts/${draftId}/comments`, {
      data: { quotedText: "the road", suggestedText: "the lane", comment: "" },
    });
    await page.goto(`/book/1/chapter/${id}/review`);

    await expect(page.getByTestId("revise-button")).toBeDisabled();
    await expect(page.getByTestId("apply-suggestions-button")).toBeEnabled();
  });
});
