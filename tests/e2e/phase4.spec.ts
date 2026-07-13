import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { login } from "./helpers";

interface Case {
  old: string;
  flagQuote: string;
  expectedAccept: string;
  expectedReject: string;
}

const case4 = JSON.parse(
  readFileSync(new URL("../fixtures/phase4.case.json", import.meta.url), "utf8"),
) as Case;

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
  await page.request.post(`/api/chapters/${id}/save-draft`, {
    data: { content },
  });
  return id;
}

// Sets a text selection over `quote` inside the read-only prose, then notifies the
// component the way a real mouse selection would.
async function selectSpan(page: Page, quote: string) {
  await page.evaluate((q) => {
    const el = document.querySelector('[data-testid="review-prose"]');
    if (!el) throw new Error("prose not found");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode) throw new Error("no text node");
    const content = textNode.textContent ?? "";
    const start = content.indexOf(q);
    if (start < 0) throw new Error("quote not in prose");
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + q.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, quote);
}

async function attachComment(page: Page, quote: string, comment: string) {
  await selectSpan(page, quote);
  await expect(page.getByTestId("selected-span")).toContainText(quote);
  await page.getByTestId("comment-input").fill(comment);
  await page.getByTestId("add-comment-button").click();
  await expect(page.getByTestId("comment-list")).toContainText(comment);
}

test.describe("Phase 4: review and revision with diff enforcement", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("unauthorized panel catches only the undeclared out-of-span edit", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `Review only ${Date.now()}`,
      case4.old,
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=phase4`);

    await attachComment(page, case4.flagQuote, "This is too fussy, tighten it.");
    await page.getByTestId("revise-button").click();

    const panel = page.getByTestId("unauthorized-panel");
    await expect(panel).toBeVisible();
    // Exactly one unauthorized hunk: the undeclared "quiet" -> "dark" edit.
    await expect(panel.locator('[data-testid^="accept-hunk-"]')).toHaveCount(1);
    await expect(panel).toContainText("dark");
    // The in-span fix (a) and the declared consistency fix (b) must NOT appear here.
    await expect(panel).not.toContainText("two at a time");
    await expect(panel).not.toContainText("Kessa");
    // Two authorized/declared changes are kept silently.
    await expect(page.getByTestId("authorized-summary")).toContainText("2");
  });

  test("rejecting the unauthorized hunk restores the original for that span", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `Review reject ${Date.now()}`,
      case4.old,
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=phase4`);
    await attachComment(page, case4.flagQuote, "Tighten this.");
    await page.getByTestId("revise-button").click();

    const panel = page.getByTestId("unauthorized-panel");
    await expect(panel).toBeVisible();
    await panel.locator('[data-testid^="reject-hunk-"]').click();
    await page.getByTestId("save-revision-button").click();

    await expect(page.getByTestId("revision-saved")).toBeVisible();
    const finalText = await page
      .getByTestId("review-prose")
      .evaluate((el) => el.textContent ?? "");
    expect(finalText).toBe(case4.expectedReject);
  });

  test("accepting the unauthorized hunk keeps the full revised text", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `Review accept ${Date.now()}`,
      case4.old,
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=phase4`);
    await attachComment(page, case4.flagQuote, "Tighten this.");
    await page.getByTestId("revise-button").click();

    const panel = page.getByTestId("unauthorized-panel");
    await expect(panel).toBeVisible();
    await panel.locator('[data-testid^="accept-hunk-"]').click();
    await page.getByTestId("save-revision-button").click();

    await expect(page.getByTestId("revision-saved")).toBeVisible();
    const finalText = await page
      .getByTestId("review-prose")
      .evaluate((el) => el.textContent ?? "");
    expect(finalText).toBe(case4.expectedAccept);
  });

  test("an em-dash in a revision triggers a retry and the saved text is clean", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `Review emdash ${Date.now()}`,
      "The gate stood open.",
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=emdashrev`);
    await attachComment(page, "open", "Add a sensory detail here.");
    await page.getByTestId("revise-button").click();

    await expect(page.getByTestId("revision-retry-alert")).toBeVisible();
    await expect(page.getByTestId("revision-emdash-unresolved")).toHaveCount(0);
    // In-span change, so no unauthorized hunks: save directly.
    await page.getByTestId("save-revision-button").click();
    await expect(page.getByTestId("revision-saved")).toBeVisible();
    const finalText = await page
      .getByTestId("review-prose")
      .evaluate((el) => el.textContent ?? "");
    expect(finalText).toBe("The gate stood open, its hinges rusted and loose.");
    expect(finalText.includes("—")).toBe(false);
  });
});
