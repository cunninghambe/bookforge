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
  const chapter = (await res.json()).chapter as CreatedChapter;
  return chapter;
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

// Sets a text selection over `quote` inside the read-only prose (same trick the
// Phase 4 spec uses), then notifies the component as a real mouse selection would.
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

async function createNamedCharacter(page: Page, name: string): Promise<number> {
  const res = await page.request.post("/api/characters", { data: { name } });
  return (await res.json()).character.id as number;
}

test.describe("Phase 5: lock, extract, sweep", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("resolving all comments enables Lock; locking stores a summary and shows proposals", async ({
    page,
  }) => {
    const chapter = await createChapterWithDraft(
      page,
      `Lock gate ${Date.now()}`,
      "The gate stood open.",
    );
    await page.goto(`/book/1/chapter/${chapter.id}/review?fx=phase5`);

    // Attach a comment: Lock must be disabled while it is unresolved.
    await selectSpan(page, "gate");
    await expect(page.getByTestId("selected-span")).toContainText("gate");
    await page.getByTestId("comment-input").fill("Add a sensory detail.");
    await page.getByTestId("add-comment-button").click();
    await expect(page.getByTestId("comment-list")).toContainText(
      "Add a sensory detail.",
    );
    await expect(page.getByTestId("lock-button")).toBeDisabled();
    await expect(page.getByTestId("lock-hint")).toBeVisible();

    // Resolve it: Lock becomes enabled.
    await page.getByTestId(/^resolve-comment-/).first().click();
    await expect(page.getByTestId("lock-button")).toBeEnabled();

    // Lock: a summary is generated and stored, and proposals render.
    await page.getByTestId("lock-button").click();
    await expect(page.getByTestId("chapter-summary")).toContainText(
      "climbs the tower",
    );
    await expect(page.getByTestId("extraction-panel")).toBeVisible();
    await expect(page.getByTestId("fact-proposal-0")).toContainText("smother");
    await expect(page.getByTestId("state-proposal-0")).toContainText("Mara");

    // The summary is stored: it survives a reload of the (now locked) chapter.
    await page.reload();
    await expect(page.getByTestId("locked-indicator")).toBeVisible();
    await expect(page.getByTestId("chapter-summary")).toContainText(
      "climbs the tower",
    );
  });

  test("approving a fact proposal creates a locked canon fact visible at /canon", async ({
    page,
  }) => {
    const chapter = await createChapterWithDraft(
      page,
      `Approve fact ${Date.now()}`,
      "The gate stood open.",
    );
    await page.goto(`/book/1/chapter/${chapter.id}/review?fx=phase5`);

    await page.getByTestId("lock-button").click();
    await expect(page.getByTestId("fact-proposal-0")).toBeVisible();

    await page.getByTestId("fact-approve-0").check();
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approve-success")).toBeVisible();

    await page.goto("/canon");
    const row = page
      .getByTestId("canon-row")
      .filter({ hasText: "Mara can smother her own flame at will." });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "locked");
  });

  test("approving a character-state proposal shows in the timeline and the next chapter prompt", async ({
    page,
  }) => {
    // Mara must exist so the extracted state auto-matches (Amendment A1).
    await createNamedCharacter(page, "Mara");

    const chapter1 = await createChapterWithDraft(
      page,
      `State src ${Date.now()}`,
      "The gate stood open.",
    );
    // The next chapter, POV Mara, immediately after chapter1.
    const chapter2 = await createChapter(page, {
      title: `State next ${Date.now()}`,
      pov: "Mara",
      synopsis: "Mara returns to the tower.",
      beats: ["She returns"],
    });
    expect(chapter2.orderIndex).toBe(chapter1.orderIndex + 1);

    await page.goto(`/book/1/chapter/${chapter1.id}/review?fx=phase5`);
    await page.getByTestId("lock-button").click();
    await expect(page.getByTestId("state-proposal-0")).toBeVisible();
    // Auto-matched, so no unmatched badge.
    await expect(page.getByTestId("state-unmatched-0")).toHaveCount(0);

    await page.getByTestId("state-approve-0").check();
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approve-success")).toBeVisible();

    // Visible in Mara's timeline.
    await page.goto("/characters");
    const card = page
      .getByTestId("character-card")
      .filter({ hasText: "Mara" })
      .first();
    await card.getByRole("button", { name: "Expand" }).click();
    await expect(card.getByTestId("state-timeline")).toContainText(
      "smothered at will",
    );

    // Effective in the next chapter's assembled prompt.
    const res = await page.request.get(`/api/dev/prompt/${chapter2.id}`);
    const assembled = await res.json();
    expect(JSON.stringify(assembled)).toContain("smothered at will");
  });

  test("sweep over two locked chapters reports a planted contradiction with quote and severity", async ({
    page,
  }) => {
    // Two chapters with drafts, both locked via the API (summary fixture reused).
    const a = await createChapterWithDraft(
      page,
      `Sweep A ${Date.now()}`,
      "The two moons rose together over the ridge.",
    );
    const b = await createChapterWithDraft(
      page,
      `Sweep B ${Date.now()}`,
      "The town slept quietly under one moon.",
    );
    for (const id of [a.id, b.id]) {
      const res = await page.request.post(`/api/chapters/${id}/lock`, {
        data: { fixtureKey: "phase5" },
      });
      expect(res.ok()).toBeTruthy();
    }

    // Plant a conflicting canon fact (the sweep fixture reports the contradiction).
    await page.request.post("/api/canon", {
      data: {
        type: "world_rule",
        content: "The world has a single moon.",
        status: "locked",
        projectId: 1,
      },
    });

    await page.goto("/book/1/sweep?fx=sweep1");
    // Scope the range to exactly our two chapters.
    await page.getByTestId("sweep-from").selectOption(String(a.orderIndex));
    await page.getByTestId("sweep-to").selectOption(String(b.orderIndex));
    await expect(page.getByTestId("sweep-estimate")).toContainText("2 chapters");

    await page.getByTestId("run-sweep").click();
    await expect(page.getByTestId("sweep-report")).toBeVisible();

    // Chapter A (position 1) reports the contradiction with quote and severity.
    const chapterA = page.getByTestId(`sweep-chapter-${a.id}`);
    await expect(chapterA).toContainText("two moons rose together");
    await expect(
      chapterA.getByTestId(`contradiction-severity-${a.id}-0`),
    ).toContainText("high");
    await expect(
      chapterA.getByTestId(`contradiction-quote-${a.id}-0`),
    ).toContainText("two moons rose together");

    // Chapter B (position 2) is clean.
    await expect(
      page.getByTestId(`sweep-clean-${b.id}`),
    ).toBeVisible();
  });
});
