import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

const OVERRIDE = "claude-test-model-a8";

// A8: per-purpose model routing. Set an override for draft on /settings, run a
// fixture draft, and assert the logged llm_calls row records the override while
// another purpose still logs its env default; Reset restores the env default; the
// Test button returns ok under fixtures.

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

// Runs one fixture draft call through the streaming draft route and waits for the
// prose to land in the editor (which means the server finished and logged the call).
async function runFixtureDraft(page: Page, chapterId: number) {
  await page.goto(`/book/1/chapter/${chapterId}/draft?fx=clean`);
  await page.getByTestId("continue-button").click();
  await expect(page.getByTestId("draft-editor")).toHaveValue(
    /Mara stepped into the hall/,
  );
}

async function loggedModel(
  page: Page,
  chapterId: number,
  purpose: string,
): Promise<string | null> {
  const res = await page.request.get(
    `/api/dev/llm-calls?chapterId=${chapterId}&purpose=${purpose}`,
  );
  const { calls } = (await res.json()) as {
    calls: Array<{ purpose: string; model: string | null }>;
  };
  return calls.length ? calls[0].model : null;
}

test.describe("Amendment A8: per-purpose model routing", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("override routes the draft model while other purposes keep the env default, and reset restores it", async ({
    page,
  }) => {
    // Set the draft override on /settings.
    await page.goto("/settings");
    await expect(page.getByTestId("model-row-draft")).toBeVisible();
    await page.getByTestId("model-input-draft").fill(OVERRIDE);
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("effective-draft")).toHaveText(OVERRIDE);
    await expect(page.getByTestId("source-draft")).toHaveText(/override/i);

    // Run a fixture draft: it must log the override model.
    const id = await createChapter(page, `A8 draft ${Date.now()}`);
    await runFixtureDraft(page, id);
    expect(await loggedModel(page, id, "draft")).toBe(OVERRIDE);

    // A different purpose (interrogation) still logs its env default, since only the
    // draft override was set.
    const interRes = await page.request.post(`/api/chapters/${id}/interrogate`);
    expect(interRes.ok()).toBe(true);
    expect(await loggedModel(page, id, "interrogation")).toBe("claude-sonnet-4-6");

    // Reset the draft override: it reverts to the env default.
    await page.goto("/settings");
    await page.getByTestId("reset-draft").click();
    await expect(page.getByTestId("effective-draft")).toHaveText(
      "claude-sonnet-4-6",
    );
    await expect(page.getByTestId("source-draft")).toHaveText(/env/i);

    // The next draft call now logs the env default, not the old override.
    const id2 = await createChapter(page, `A8 draft reset ${Date.now()}`);
    await runFixtureDraft(page, id2);
    expect(await loggedModel(page, id2, "draft")).toBe("claude-sonnet-4-6");
  });

  test("the Test button returns ok and shows the reply snippet under fixtures", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByTestId("test-draft").click();
    const result = page.getByTestId("test-result-draft");
    await expect(result).toBeVisible();
    await expect(result).toContainText(/OK/i);
    await expect(page.getByTestId("test-snippet-draft")).toContainText(
      "Reachable.",
    );
  });
});
