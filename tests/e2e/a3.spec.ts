import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

interface CreatedChapter {
  id: number;
  orderIndex: number;
}

// Amendment A3: the series-bible importer. The acceptance check, verbatim: paste a
// bible (the fixture returns two world rules, a style note, two characters one with
// voice rules, and one character state), proposals come back categorized, approve a
// SUBSET via keyboard only (arrows + a/r), the approved items exist exactly (locked
// facts source 'bible', character rows, a state visible in the timeline), a chapter
// of the chosen book shows the approved facts and state in its assembled prompt, and
// the rejected proposals leave no trace.
test.describe("Amendment A3: series bible importer", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("paste, categorized proposals, keyboard-only subset approval, exact result, no trace of rejects", async ({
    page,
  }: {
    page: Page;
  }) => {
    // Reach the importer from the home Books page (SPEC: linked from home).
    await page.goto("/");
    await expect(page.getByTestId("import-bible-link")).toBeVisible();
    await page.getByTestId("import-bible-link").click();
    await expect(page).toHaveURL(/\/import-bible/);

    // Re-navigate with the fixture key so the mock LLM returns the A3 fixture.
    await page.goto("/import-bible?fx=bible1");

    // Choose a book scope (Book 2), which enables the character-state section.
    await page.getByTestId("bible-scope").selectOption("2");
    await page
      .getByTestId("bible-content")
      .fill(
        "The world runs on tideglass and old harbor debts. Wrenlow keeps the ledgers. Sethra casts the glass.",
      );
    await page.getByTestId("bible-import-button").click();

    // Proposals come back categorized: three facts, two characters, one state.
    await expect(page.getByTestId("bible-proposals")).toBeVisible();
    await expect(page.getByTestId("bible-fact-proposal-0")).toContainText(
      "tideglass rings",
    );
    await expect(page.getByTestId("bible-fact-proposal-1")).toContainText(
      "Salt roses",
    );
    await expect(page.getByTestId("bible-fact-proposal-2")).toContainText(
      "concrete image",
    );
    await expect(page.getByTestId("bible-character-proposal-0")).toContainText(
      "Wrenlow",
    );
    await expect(page.getByTestId("bible-character-proposal-1")).toContainText(
      "Sethra",
    );
    await expect(page.getByTestId("bible-state-proposal-0")).toContainText("Wrenlow");
    // Wrenlow is a brand new character (not yet tracked).
    await expect(page.getByTestId("bible-character-new-0")).toBeVisible();

    // Keyboard only from here. Focus starts on the first proposal row.
    await expect(page.getByTestId("bible-fact-proposal-0")).toBeFocused();

    // Approve fact 0 (tideglass), and prove both shortcuts: approve, reject, approve.
    await page.keyboard.press("a");
    await expect(page.getByTestId("bible-fact-approve-0")).toBeChecked();
    await page.keyboard.press("r");
    await expect(page.getByTestId("bible-fact-approve-0")).not.toBeChecked();
    await page.keyboard.press("a");
    await expect(page.getByTestId("bible-fact-approve-0")).toBeChecked();

    // Arrow down past fact 1 (Salt roses) and fact 2 (the style note), both left
    // rejected, into the characters section.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("bible-fact-proposal-1")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("bible-fact-proposal-2")).toBeFocused();

    // Into the characters section: approve Wrenlow (row 3), leave Sethra (row 4).
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("bible-character-proposal-0")).toBeFocused();
    await page.keyboard.press("a");
    await expect(page.getByTestId("bible-character-approve-0")).toBeChecked();

    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("bible-character-proposal-1")).toBeFocused();

    // Into the states section: the state names Wrenlow, whose creation is approved
    // above, so it shows as a same-batch creation. Approve it.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("bible-state-proposal-0")).toBeFocused();
    await expect(page.getByTestId("bible-state-batch-0")).toBeVisible();
    await page.keyboard.press("a");
    await expect(page.getByTestId("bible-state-approve-0")).toBeChecked();

    // The rejected rows are unchecked.
    await expect(page.getByTestId("bible-fact-approve-1")).not.toBeChecked();
    await expect(page.getByTestId("bible-character-approve-1")).not.toBeChecked();

    await page.getByTestId("bible-approve-button").click();
    await expect(page.getByTestId("bible-approve-success")).toBeVisible();

    // The approved facts landed as LOCKED canon with source 'bible' at Book 2 scope.
    const canonRes = await page.request.get("/api/canon");
    const canonFacts = (await canonRes.json()).facts as Array<{
      content: string;
      status: string;
      source: string | null;
      projectId: number | null;
    }>;
    const tideglass = canonFacts.find((f) => f.content.includes("tideglass rings"));
    expect(tideglass).toBeTruthy();
    expect(tideglass?.status).toBe("locked");
    expect(tideglass?.source).toBe("bible");
    expect(tideglass?.projectId).toBe(2);

    // The rejected proposals left no trace: neither the second world rule nor the
    // style note was written.
    expect(canonFacts.some((f) => f.content.includes("Salt roses"))).toBe(false);
    expect(canonFacts.some((f) => f.content.includes("concrete image"))).toBe(false);

    // The approved locked fact is visible on the canon page with a locked status.
    await page.goto("/canon");
    const row = page
      .getByTestId("canon-row")
      .filter({ hasText: "tideglass rings" });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "locked");

    // The approved character exists; the rejected one does not.
    const charsRes = await page.request.get("/api/characters");
    const chars = (await charsRes.json()).characters as Array<{
      id: number;
      name: string;
      voiceRules: string | null;
    }>;
    const wrenlow = chars.find((c) => c.name === "Wrenlow");
    expect(wrenlow).toBeTruthy();
    expect(wrenlow?.voiceRules).toContain("clips every sentence");
    expect(chars.some((c) => c.name === "Sethra")).toBe(false);

    // The approved state is visible in Wrenlow's timeline.
    await page.goto("/characters");
    const card = page
      .getByTestId("character-card")
      .filter({ hasText: "Wrenlow" })
      .first();
    await card.getByRole("button", { name: "Expand" }).click();
    await expect(card.getByTestId("state-timeline")).toContainText(
      "forged the tide ledger",
    );

    // A chapter of the chosen book (Book 2) shows the approved fact and state in its
    // assembled prompt. POV is Wrenlow so the character (and its state) appears.
    const chRes = await page.request.post("/api/chapters", {
      data: {
        projectId: 2,
        title: `A3 prompt check ${Date.now()}`,
        pov: "Wrenlow",
        synopsis: "Wrenlow audits the harbor ledgers.",
        beats: ["Wrenlow opens the ledger"],
      },
    });
    const chapter = (await chRes.json()).chapter as CreatedChapter;
    const promptRes = await page.request.get(`/api/dev/prompt/${chapter.id}`);
    const assembled = JSON.stringify(await promptRes.json());
    expect(assembled).toContain("tideglass rings"); // approved world rule in CANON
    expect(assembled).toContain("forged the tide ledger"); // approved state in CHARACTERS

    // The rejected proposals are absent from the assembled prompt too.
    expect(assembled).not.toContain("Salt roses");
  });
});
