import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A15: the mobile core-flow subset. This spec runs ONLY in the
// "mobile" Playwright project (390x844, touch, mobile UA; see the iPhone 13
// device preset wired up in playwright.config.ts), against the same
// fixture-backed dev server as the desktop suite (Book 1 / projectId 1 is the
// shared seeded book, so names below are timestamped). Every page visited
// along the way asserts the SPEC's literal acceptance check: the page body
// itself never scrolls horizontally, even where a component (the braid) has
// its own internal horizontal scroller.

async function assertNoHorizontalBodyScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

async function createChapterWithDraft(
  page: Page,
  title: string,
  content: string,
): Promise<{ id: number; orderIndex: number }> {
  const res = await page.request.post("/api/chapters", {
    data: { projectId: 1, title, synopsis: "For the A15 mobile tests." },
  });
  expect(res.ok()).toBeTruthy();
  const chapter = (await res.json()).chapter as { id: number; orderIndex: number };
  const saveRes = await page.request.post(`/api/chapters/${chapter.id}/save-draft`, {
    data: { content },
  });
  expect(saveRes.ok()).toBeTruthy();
  return chapter;
}

test.describe("Amendment A15: mobile core flow", () => {
  test("login, home, canon, palette navigation, the braid, listen, and the folded nav, with no body scroll anywhere", async ({
    page,
  }) => {
    const ts = Date.now();

    // Login lands on /canon.
    await login(page);
    await assertNoHorizontalBodyScroll(page);

    // Home.
    await page.goto("/");
    await expect(page.getByTestId("book-list")).toBeVisible();
    await assertNoHorizontalBodyScroll(page);

    // Canon: the list renders, and a fact can be added from the mobile layout.
    await page.goto("/canon");
    await expect(page.getByTestId("canon-list")).toBeVisible();
    await assertNoHorizontalBodyScroll(page);
    const factContent = `Mobile canon fact ${ts}`;
    await page.getByLabel("New fact content").fill(factContent);
    await page.getByLabel("New fact content").press("Enter");
    await expect(
      page.getByTestId("canon-row").filter({ hasText: factContent }),
    ).toHaveCount(1);

    // A chapter with a draft, reached through the palette rather than a direct
    // goto: the TopNav Search button (mobile has no Ctrl+K affordance) opens
    // it, a search finds the chapter, and Enter/click navigates.
    const chapter = await createChapterWithDraft(
      page,
      `Mobile draft ${ts}`,
      "The tide came in before anyone noticed.",
    );
    await page.getByTestId("nav-search").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill(`Mobile draft ${ts}`);
    const hit = page.locator(`[data-hit="chapter-${chapter.id}"]`);
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(
      new RegExp(`/book/1/chapter/${chapter.id}/draft`),
    );
    await expect(page.getByTestId("draft-editor")).toBeVisible();
    await assertNoHorizontalBodyScroll(page);

    // Threads: the page renders, and the braid stays swipeable inside its own
    // overflow container even though its SVG is wider than the phone viewport
    // (a single locked-in chapter plus a touch is enough to draw a node).
    const threadRes = await page.request.post("/api/threads", {
      data: { name: `Mobile thread ${ts}`, type: "mystery", projectId: 1 },
    });
    expect(threadRes.ok()).toBeTruthy();
    const thread = (await threadRes.json()).thread as { id: number };
    const touchRes = await page.request.post(
      `/api/threads/${thread.id}/touches`,
      { data: { chapter: chapter.orderIndex + 1, kind: "advance", projectId: 1 } },
    );
    expect(touchRes.ok()).toBeTruthy();

    await page.goto("/book/1/threads");
    await expect(page.getByTestId("threads-list")).toBeVisible();
    const braid = page.getByTestId("braid-svg");
    await expect(braid).toBeVisible();
    // The SVG's own parent is the scroller (BraidView's overflow-x-auto div),
    // not the page body.
    const parentHasOwnScroller = await braid.evaluate(
      (svg) => svg.parentElement?.classList.contains("overflow-x-auto") ?? false,
    );
    expect(parentHasOwnScroller).toBe(true);
    await assertNoHorizontalBodyScroll(page);

    // Listen: controls render in fixture mode (A14, unchanged by A15, already
    // phone-first).
    await page.goto(`/listen/${chapter.id}`);
    await expect(page.getByTestId("listen-player")).toBeVisible();
    await expect(page.getByTestId("listen-play")).toBeVisible();
    await assertNoHorizontalBodyScroll(page);

    // The nav disclosure: closed by default, opens on a tap of the 44px
    // toggle, and reaches Settings through the same data-testid the desktop
    // suite uses ("nav-settings" exists exactly once in the DOM, so it is
    // reachable on both layouts without a strict-mode ambiguity).
    await expect(page.getByTestId("nav-links")).toBeHidden();
    await page.getByTestId("nav-menu-toggle").click();
    await expect(page.getByTestId("nav-links")).toBeVisible();
    await page.getByTestId("nav-settings").click();
    await expect(page).toHaveURL(/\/settings/);
    await assertNoHorizontalBodyScroll(page);
  });
});
