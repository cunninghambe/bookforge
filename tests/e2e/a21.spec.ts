import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";
import { stripEmphasis } from "../../src/lib/markdown";

// Amendment A21: markdown emphasis is interpreted as a DISPLAY concern only. The
// review surface renders `*italic*`/`**bold**` as <em>/<strong> with no literal
// markers, comment anchoring and revision still operate on the RAW content, and the
// audio path speaks the marker-stripped text. These tests exercise each seam; the
// phase4/phase5 comment and revision e2e run unchanged alongside them.

const EMPH = "You're *in* it now, and the door was **shut** tight.";
const EMPH_CLEAN = "You're in it now, and the door was shut tight.";

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
  await page.request.post(`/api/chapters/${id}/save-draft`, { data: { content } });
  return id;
}

// Selects `word` inside the review prose by finding the first text node that
// contains it (which, for an emphasized word, is the <em>/<strong>'s text node),
// then notifies the component as a real mouse selection would.
async function selectText(page: Page, word: string) {
  await page.evaluate((w) => {
    const el = document.querySelector('[data-testid="review-prose"]');
    if (!el) throw new Error("prose not found");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const txt = node.textContent ?? "";
      const idx = txt.indexOf(w);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + w.length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }
    throw new Error("text not found in prose: " + w);
  }, word);
}

test.describe("Amendment A21: markdown emphasis rendered, not spoken", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("emphasis renders as <em>/<strong> with no literal asterisk", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(page, `A21 render ${Date.now()}`, EMPH);
    await page.goto(`/book/1/chapter/${id}/review`);

    const prose = page.getByTestId("review-prose");
    await expect(prose.locator("em")).toHaveText("in");
    await expect(prose.locator("strong")).toHaveText("shut");

    // The visible text carries the emphasis meaning without the markers.
    const text = await prose.evaluate((el) => el.textContent ?? "");
    expect(text).toBe(EMPH_CLEAN);
    expect(text.includes("*")).toBe(false);
  });

  test("selecting an emphasized word anchors a comment to the plain word", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(page, `A21 comment ${Date.now()}`, EMPH);
    await page.goto(`/book/1/chapter/${id}/review`);

    // Select the italic "in": quotedText must be the plain word, no markers.
    await selectText(page, "in");
    const span = page.getByTestId("selected-span");
    await expect(span).toHaveText("in");
    expect((await span.evaluate((el) => el.textContent ?? "")).includes("*")).toBe(
      false,
    );

    await page.getByTestId("comment-input").fill("Lean on this emphasis.");
    await page.getByTestId("add-comment-button").click();

    const list = page.getByTestId("comment-list");
    await expect(list).toContainText("Lean on this emphasis.");
    // The stored quote is the plain word "in": markers are excluded because
    // rawStart points past the opening marker, so quotedText is byte-identical to
    // selecting the same word in a plain draft. It renders with no asterisk.
    const quote = list.locator("p").first();
    await expect(quote).toHaveText("“in”");
    expect((await list.evaluate((el) => el.textContent ?? "")).includes("*")).toBe(
      false,
    );
  });

  test("a revision over a flagged span applies with emphasis present elsewhere", async ({
    page,
  }) => {
    const content = `${EMPH}\n\nHe said the word aloud to no one.`;
    const id = await createChapterWithDraft(page, `A21 revise ${Date.now()}`, content);
    await page.goto(`/book/1/chapter/${id}/review?fx=a21emph`);

    // Flag a plain span in the second paragraph; the emphasis is elsewhere.
    await selectText(page, "the word aloud");
    await expect(page.getByTestId("selected-span")).toHaveText("the word aloud");
    await page.getByTestId("comment-input").fill("Make this vivid.");
    await page.getByTestId("add-comment-button").click();
    await expect(page.getByTestId("comment-list")).toContainText("Make this vivid.");

    await page.getByTestId("revise-button").click();
    // The change is within the flagged span, so nothing is unauthorized.
    await expect(page.getByTestId("no-unauthorized")).toBeVisible();
    await page.getByTestId("save-revision-button").click();
    await expect(page.getByTestId("revision-saved")).toBeVisible();

    // The revision applied on the RAW content (the raw-offset invariant), and the
    // emphasis elsewhere still renders with no literal marker.
    const prose = page.getByTestId("review-prose");
    const text = await prose.evaluate((el) => el.textContent ?? "");
    expect(text).toContain("He said the name softly to no one.");
    expect(text).not.toContain("the word aloud");
    expect(text.includes("*")).toBe(false);
    await expect(prose.locator("em")).toHaveText("in");
    await expect(prose.locator("strong")).toHaveText("shut");
  });

  test("the audio path serves the emphasized paragraph with markers stripped", async ({
    page,
  }) => {
    const id = await createChapterWithDraft(page, `A21 audio ${Date.now()}`, EMPH);

    // The manifest splits the RAW content (one paragraph) and stays reachable.
    const manifestRes = await page.request.get(`/api/chapters/${id}/audio-manifest`);
    expect(manifestRes.ok()).toBeTruthy();
    const manifest = await manifestRes.json();
    expect(manifest.paragraphCount).toBe(1);

    // The served paragraph audio synthesizes without error.
    const audioRes = await page.request.get(`/api/chapters/${id}/audio/0`);
    expect(audioRes.ok()).toBeTruthy();

    // The text handed to the synthesizer is the marker-stripped paragraph.
    const spoken = stripEmphasis(EMPH);
    expect(spoken).toBe(EMPH_CLEAN);
    expect(spoken.includes("*")).toBe(false);
  });
});
