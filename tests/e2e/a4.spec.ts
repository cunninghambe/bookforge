import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { login } from "./helpers";

interface Case {
  old: string;
  flagQuote: string;
  expectedAccept: string;
  expectedReject: string;
}

// A4.2 re-runs the Phase 4 scenario in patch mode, reusing the same source text and
// expected accept/reject results: the patch fixture (revision.a4patch.json) carries
// an in-span patch, a declared consistency-fix patch, and an undeclared out-of-span
// patch, and applying it mechanically yields exactly the Phase 4 texts.
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

test.describe("Amendment A4: patch-mode revision", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("patch mode catches only the undeclared out-of-span patch", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `A4 patch ${Date.now()}`,
      case4.old,
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=a4patch`);

    await attachComment(page, case4.flagQuote, "Tighten this.");
    await page.getByTestId("revise-button").click();

    // The revision ran in patch mode.
    await expect(page.getByTestId("revision-mode")).toContainText("patch revision");

    const panel = page.getByTestId("unauthorized-panel");
    await expect(panel).toBeVisible();
    // Exactly one unauthorized hunk: the undeclared quiet -> dark patch.
    await expect(panel.locator('[data-testid^="accept-hunk-"]')).toHaveCount(1);
    await expect(panel).toContainText("dark");
    // The in-span patch and the declared consistency fix must NOT appear here.
    await expect(panel).not.toContainText("two at a time");
    await expect(panel).not.toContainText("Kessa");
    // Two authorized/declared changes are kept silently.
    await expect(page.getByTestId("authorized-summary")).toContainText("2");
    // No patches failed to anchor for this clean fixture.
    await expect(page.getByTestId("failed-patches")).toHaveCount(0);

    // The patch revision logged output tokens far below the chapter's size: a
    // full rewrite of this ~600 character chapter would cost well over 100 output
    // tokens, the patch envelope costs a fraction of that.
    const callsRes = await page.request.get(
      `/api/dev/llm-calls?chapterId=${id}&purpose=revision`,
    );
    const { calls } = (await callsRes.json()) as {
      calls: Array<{ purpose: string; outputTokens: number }>;
    };
    expect(calls.length).toBeGreaterThan(0);
    const logged = calls[0].outputTokens;
    expect(logged).toBeGreaterThan(0);
    expect(logged).toBeLessThan(100);
    expect(logged * 4).toBeLessThan(case4.old.length);
  });

  test("rejecting the undeclared patch yields the exact expected text with clean seams", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(
      page,
      `A4 reject ${Date.now()}`,
      case4.old,
    );
    await page.goto(`/book/1/chapter/${id}/review?fx=a4patch`);
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

    // The mid-paragraph in-span patch reads cleanly at both seams: no doubled
    // spaces anywhere, and the replaced sentence keeps its surrounding punctuation.
    expect(finalText.includes("  ")).toBe(false);
    expect(finalText).toContain(
      "Mara climbed the tower stairs, taking them two at a time.",
    );
    expect(finalText.includes("—")).toBe(false);
  });
});
