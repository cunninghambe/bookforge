import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A17: the thread backfill scan. Each test creates its OWN series and
// book (so the scan's default range is exactly this book's locked chapters and
// nothing another spec seeded), locks a couple of chapters, then drives the scan
// from the threads page against per-chapter fixtures.

interface CreatedChapter {
  id: number;
  orderIndex: number;
}

async function createBook(page: Page, title: string): Promise<number> {
  const res = await page.request.post("/api/series", { data: { title } });
  expect(res.ok()).toBeTruthy();
  const { firstBook } = (await res.json()) as { firstBook: { id: number } };
  return firstBook.id;
}

async function createLockedChapter(
  page: Page,
  projectId: number,
  title: string,
  content: string,
): Promise<CreatedChapter> {
  const res = await page.request.post("/api/chapters", {
    data: { projectId, title, synopsis: "For the A17 scan tests." },
  });
  expect(res.ok()).toBeTruthy();
  const chapter = (await res.json()).chapter as CreatedChapter;
  const saveRes = await page.request.post(
    `/api/chapters/${chapter.id}/save-draft`,
    { data: { content } },
  );
  expect(saveRes.ok()).toBeTruthy();
  // Locking generates the summary only (extraction proposals are a separate,
  // gated call), so the chapter lands locked and touchless: a scan candidate.
  const lockRes = await page.request.post(`/api/chapters/${chapter.id}/lock`, {
    data: { fixtureKey: "phase5" },
  });
  expect(lockRes.ok()).toBeTruthy();
  return chapter;
}

async function openScanPanel(page: Page) {
  if (!(await page.getByTestId("scan-panel").isVisible())) {
    await page.getByTestId("scan-toggle").click();
  }
  await expect(page.getByTestId("scan-panel")).toBeVisible();
}

test.describe("Amendment A17: thread backfill scan", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("scan two locked chapters, approve a shared new thread and an attach via keyboard, see the braid populate", async ({
    page,
  }) => {
    const ts = Date.now();
    const bookId = await createBook(page, `Scan series ${ts}`);

    // Pre-create the attach target the scan1.1 fixture names, so the run
    // attaches to it rather than proposing it as new.
    const attachRes = await page.request.post("/api/threads", {
      data: { name: "Ledger mystery", type: "mystery", projectId: bookId },
    });
    expect(attachRes.ok()).toBeTruthy();

    await createLockedChapter(page, bookId, "Scan ch A", "The gate stood open.");
    await createLockedChapter(page, bookId, "Scan ch B", "The gate was shut.");

    await page.goto(`/book/${bookId}/threads?fx=scan1`);
    await openScanPanel(page);
    await expect(page.getByTestId("scan-estimate")).toContainText("2 chapters");

    await page.getByTestId("run-scan").click();
    await expect(page.getByTestId("scan-proposals")).toBeVisible();

    // The attach group (Ledger mystery) and the shared new thread (Theo and
    // Mara, two touches across both chapters) are both present.
    await expect(page.getByTestId("scan-attach-groups")).toContainText(
      "Ledger mystery",
    );
    await expect(page.getByTestId("scan-new-groups")).toContainText(
      "Theo and Mara",
    );

    // Keyboard only: focus each touch row, press "a", then Enter the shared
    // Approve button (flat order: attach touch, then the two new-thread touches).
    for (const flat of [0, 1, 2]) {
      await page.getByTestId(`scan-touch-${flat}`).focus();
      await page.keyboard.press("a");
      await expect(page.getByTestId(`scan-touch-approve-${flat}`)).toBeChecked();
    }
    await page.getByTestId("scan-approve-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("scan-approve-success")).toBeVisible();

    // The braid fills in: Theo and Mara has two touches, Ledger mystery one.
    const theoRow = page
      .getByTestId("thread-row")
      .filter({ hasText: "Theo and Mara" });
    await expect(theoRow).toBeVisible();
    const theoId = await theoRow.getAttribute("data-thread-id");
    await expect(
      page.locator(`[data-testid="braid-node"][data-thread="${theoId}"]`),
    ).toHaveCount(2);

    const ledgerRow = page
      .getByTestId("thread-row")
      .filter({ hasText: "Ledger mystery" });
    const ledgerId = await ledgerRow.getAttribute("data-thread-id");
    await expect(
      page.locator(`[data-testid="braid-node"][data-thread="${ledgerId}"]`),
    ).toHaveCount(1);
  });

  test("a planted per-chapter failure surfaces its reason while the other chapter still proposes", async ({
    page,
  }) => {
    const ts = Date.now();
    const bookId = await createBook(page, `Scan fail series ${ts}`);

    const chFail = await createLockedChapter(
      page,
      bookId,
      "Scan fail ch 1",
      "The prose that will not parse.",
    );
    await createLockedChapter(page, bookId, "Scan fail ch 2", "A key in the mud.");

    // No threads yet, so the empty-state invitation renders and the panel opens.
    await page.goto(`/book/${bookId}/threads?fx=scanfail`);
    await expect(page.getByTestId("scan-empty-invite")).toBeVisible();
    await expect(page.getByTestId("scan-panel")).toBeVisible();

    await page.getByTestId("run-scan").click();

    // The first chapter's unparseable reply becomes a named failure...
    await expect(
      page.getByTestId(`scan-chapter-failure-${chFail.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`scan-failure-reason-${chFail.id}`),
    ).not.toBeEmpty();

    // ...while the second chapter's proposal still arrives.
    await expect(page.getByTestId("scan-new-groups")).toContainText(
      "The buried key",
    );
  });
});
