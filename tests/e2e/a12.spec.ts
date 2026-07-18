import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A12 (phase 2): the threads page and the braid view. Book 1
// (projectId 1) is the seeded book shared with other spec files in the same
// run, so every name here is timestamped to stay distinctive.

interface CreatedChapter {
  id: number;
  orderIndex: number;
}

async function createChapter(page: Page, title: string): Promise<CreatedChapter> {
  const res = await page.request.post("/api/chapters", {
    data: { projectId: 1, title, synopsis: "For the A12 braid tests." },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).chapter as CreatedChapter;
}

async function createChapterWithDraft(
  page: Page,
  title: string,
  content: string,
): Promise<CreatedChapter> {
  const chapter = await createChapter(page, title);
  const saveRes = await page.request.post(`/api/chapters/${chapter.id}/save-draft`, {
    data: { content },
  });
  expect(saveRes.ok()).toBeTruthy();
  return chapter;
}

async function lockChapter(page: Page, chapterId: number) {
  const res = await page.request.post(`/api/chapters/${chapterId}/lock`, {
    data: { fixtureKey: "phase5" },
  });
  expect(res.ok()).toBeTruthy();
}

async function createThread(
  page: Page,
  name: string,
  type: string,
): Promise<{ id: number }> {
  const res = await page.request.post("/api/threads", {
    data: { name, type, projectId: 1 },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).thread as { id: number };
}

async function addTouch(
  page: Page,
  threadId: number,
  chapter: number,
  kind: string,
) {
  const res = await page.request.post(`/api/threads/${threadId}/touches`, {
    data: { chapter, kind, projectId: 1 },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("Amendment A12: threads and the braid view", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("create a thread and two manual touches through the UI, see the line and nodes in the braid", async ({
    page,
  }) => {
    const ts = Date.now();
    const chA = await createChapter(page, `Braid ch A ${ts}`);
    const chB = await createChapter(page, `Braid ch B ${ts}`);

    await page.goto("/book/1/threads");
    await expect(page.getByTestId("threads-list")).toBeVisible();

    const threadName = `Loom thread ${ts}`;
    await page.getByTestId("new-thread-name").fill(threadName);
    await page.getByTestId("new-thread-type").selectOption("mystery");
    await page.getByTestId("new-thread-form").getByRole("button", { name: "Add thread" }).click();

    const row = page.getByTestId("thread-row").filter({ hasText: threadName });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Expand" }).click();
    await row.getByTestId("touch-chapter-input").fill(String(chA.orderIndex + 1));
    await row.getByTestId("touch-kind-select").selectOption("advance");
    await row.getByTestId("touch-evidence-input").fill("the first thread of the loom");
    await row.getByTestId("add-touch-button").click();
    await expect(row.getByTestId("thread-touches")).toContainText(
      "the first thread of the loom",
    );

    await row.getByTestId("touch-chapter-input").fill(String(chB.orderIndex + 1));
    await row.getByTestId("touch-kind-select").selectOption("complicate");
    await row.getByTestId("touch-evidence-input").fill("the loom tightens");
    await row.getByTestId("add-touch-button").click();
    await expect(row.getByTestId("thread-touches")).toContainText("the loom tightens");

    const threadId = await row.getAttribute("data-thread-id");
    await expect(page.getByTestId("braid-svg")).toBeVisible();
    const nodes = page.locator(`[data-testid="braid-node"][data-thread="${threadId}"]`);
    await expect(nodes).toHaveCount(2);
    await expect(nodes.first()).toHaveAttribute("data-kind", "advance");
    await expect(nodes.last()).toHaveAttribute("data-kind", "complicate");
  });

  test("lock-time thread proposals: approve an attach and a new thread via keyboard, see both on the threads page", async ({
    page,
  }) => {
    const ts = Date.now();
    // Pre-create the attach target the extraction.phase5.json fixture names,
    // so the lock-time normalization matches it by name instead of proposing
    // it as new (D111 in the phase 1 decisions: name match is authoritative).
    await createThread(page, "Mara and Julian", "relationship");

    const chapter = await createChapterWithDraft(
      page,
      `Thread lock ${ts}`,
      "The gate stood open.",
    );
    await page.goto(`/book/1/chapter/${chapter.id}/review?fx=phase5`);
    await page.getByTestId("lock-button").click();

    await expect(page.getByTestId("thread-attach-proposal-0")).toBeVisible();
    await expect(page.getByTestId("thread-attach-proposal-0")).toContainText(
      "Mara and Julian",
    );
    await expect(page.getByTestId("thread-new-proposal-0")).toContainText(
      "The smothering trick",
    );

    // Keyboard only from here: focus each row, press "a" to approve it, then
    // focus and Enter the shared Approve button (the LockPanel a/r recipe,
    // same as the existing fact/state proposal rows).
    await page.getByTestId("thread-attach-proposal-0").focus();
    await page.keyboard.press("a");
    await expect(page.getByTestId("thread-attach-approve-0")).toBeChecked();

    await page.getByTestId("thread-new-proposal-0").focus();
    await page.keyboard.press("a");
    await expect(page.getByTestId("thread-new-approve-0")).toBeChecked();

    await page.getByTestId("approve-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("approve-success")).toBeVisible();

    await page.goto("/book/1/threads");
    await expect(
      page.getByTestId("thread-row").filter({ hasText: "Mara and Julian" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("thread-row").filter({ hasText: "The smothering trick" }),
    ).toBeVisible();
  });

  test("a stale thread shows its flag chip and a dashed segment in the braid", async ({
    page,
  }) => {
    const ts = Date.now();
    const thread = await createThread(page, `The dropped promise ${ts}`, "promise");

    const early = await createChapter(page, `Stale early ${ts}`);
    await addTouch(page, thread.id, early.orderIndex + 1, "advance");

    // Lock five more chapters after the touch: a gap of 5 exceeds STALE_GAP (4).
    let lastOrder = early.orderIndex;
    for (let i = 0; i < 5; i += 1) {
      const c = await createChapterWithDraft(page, `Stale filler ${ts} ${i}`, "Filler text.");
      await lockChapter(page, c.id);
      lastOrder = c.orderIndex;
    }
    expect(lastOrder - early.orderIndex).toBeGreaterThan(4);

    await page.goto("/book/1/threads");
    const row = page
      .getByTestId("thread-row")
      .filter({ hasText: `The dropped promise ${ts}` });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("thread-flag")).toBeVisible();

    const threadId = await row.getAttribute("data-thread-id");
    const staleSegment = page.locator(
      `[data-testid="braid-segment"][data-thread="${threadId}"][data-stale="true"]`,
    );
    await expect(staleSegment.first()).toBeVisible();
  });

  test("resolving a thread ends its line with a terminal tick and removes the flag", async ({
    page,
  }) => {
    const ts = Date.now();
    const thread = await createThread(page, `Resolve me ${ts}`, "arc");

    const early = await createChapter(page, `Resolve early ${ts}`);
    await addTouch(page, thread.id, early.orderIndex + 1, "advance");
    for (let i = 0; i < 5; i += 1) {
      const c = await createChapterWithDraft(page, `Resolve filler ${ts} ${i}`, "Filler.");
      await lockChapter(page, c.id);
    }

    await page.goto("/book/1/threads");
    const row = page.getByTestId("thread-row").filter({ hasText: `Resolve me ${ts}` });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("thread-flag")).toBeVisible();

    await row.getByTestId("thread-resolve").click();
    await expect(row).toHaveAttribute("data-status", "resolved");
    await expect(row.getByTestId("thread-flag")).toHaveCount(0);

    const threadId = await row.getAttribute("data-thread-id");
    const terminal = page.locator(
      `[data-testid="braid-node"][data-thread="${threadId}"][data-terminal="true"]`,
    );
    await expect(terminal.first()).toBeVisible();
    const runout = page.locator(
      `[data-testid="braid-segment"][data-thread="${threadId}"][data-runout="true"]`,
    );
    await expect(runout).toHaveCount(0);
  });

  test("a palette search for a thread name lands on the threads page with the row flashed", async ({
    page,
  }) => {
    const ts = Date.now();
    const name = `Palette thread ${ts}`;
    const res = await page.request.post("/api/threads", {
      data: { name, type: "arc", projectId: 1, note: "a distinctive palette note" },
    });
    expect(res.ok()).toBeTruthy();
    const { thread } = (await res.json()) as { thread: { id: number } };

    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill(name);
    const result = page.locator(`[data-hit="thread-${thread.id}"]`);
    await expect(result).toBeVisible();
    await result.click();

    await expect(page).toHaveURL(
      new RegExp(`/book/1/threads\\?highlight=${thread.id}`),
    );
    const row = page.locator(`#thread-${thread.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(name);
  });
});
