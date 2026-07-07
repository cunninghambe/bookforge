import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

async function createChapter(page: Page, title: string) {
  const res = await page.request.post("/api/chapters", {
    data: {
      projectId: 1,
      title,
      pov: "Mara",
      synopsis: "Mara enters the hall.",
      beats: ["She hides her flame", "Julian confronts her"],
    },
  });
  const data = await res.json();
  return data.chapter.id as number;
}

test.describe("Phase 3: drafting", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("drafting a beat streams clean prose into the editor", async ({ page }) => {
    const id = await createChapter(page, `Draft clean ${Date.now()}`);
    await page.goto(`/book/1/chapter/${id}/draft?fx=clean`);
    await page.getByTestId("continue-button").click();
    await expect(page.getByTestId("draft-editor")).toHaveValue(
      /Mara stepped into the hall/,
    );
  });

  test("em-dash in output triggers a retry and the saved text is clean", async ({
    page,
  }) => {
    const id = await createChapter(page, `Draft emdash ${Date.now()}`);
    await page.goto(`/book/1/chapter/${id}/draft?fx=emdash`);
    await page.getByTestId("continue-button").click();

    await expect(page.getByTestId("retry-alert")).toBeVisible();
    const editor = page.getByTestId("draft-editor");
    await expect(editor).toHaveValue(/She paused, then spoke/);
    const value = await editor.inputValue();
    expect(value.includes("—")).toBe(false);
    // The unresolved-em-dash warning must NOT be shown, since the retry was clean.
    await expect(page.getByTestId("emdash-unresolved")).toHaveCount(0);
  });

  test("a MISSING FACT line surfaces as an alert", async ({ page }) => {
    const id = await createChapter(page, `Draft missing ${Date.now()}`);
    await page.goto(`/book/1/chapter/${id}/draft?fx=missing`);
    await page.getByTestId("continue-button").click();

    const alert = page.getByTestId("missing-fact");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/east hall/);
    // The marker line must be stripped from the prose itself.
    await expect(page.getByTestId("draft-editor")).not.toHaveValue(
      /\[MISSING FACT\]/,
    );
  });

  test("the assembled prompt is inspectable for one chapter", async ({ page }) => {
    const id = await createChapter(page, `Inspect ${Date.now()}`);
    await page.goto(`/book/1/chapter/${id}/prompt`);
    await expect(page.getByTestId("system-block")).toContainText(
      "Never use em-dashes",
    );
    await expect(page.getByTestId("block-canon")).toBeVisible();
    await expect(page.getByTestId("block-current-chapter")).toContainText(
      "She hides her flame",
    );
    await expect(page.getByTestId("full-prompt")).not.toHaveValue("");
  });
});
