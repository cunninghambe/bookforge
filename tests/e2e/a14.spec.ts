import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A14: listen (TTS) and voice notes (STT). The playwright webServer sets
// USE_FIXTURE_LLM=1 and two non-empty service URLs, so the surfaces show and both
// bridges short-circuit to fixtures with no network call. Book 1 (projectId 1) is
// the seeded book shared across specs, so titles are timestamped to stay distinct.

async function createChapterWithDraft(
  page: Page,
  title: string,
  content: string,
): Promise<number> {
  const res = await page.request.post("/api/chapters", {
    data: { projectId: 1, title, synopsis: "For the A14 listen tests." },
  });
  expect(res.ok()).toBeTruthy();
  const id = (await res.json()).chapter.id as number;
  const saveRes = await page.request.post(`/api/chapters/${id}/save-draft`, {
    data: { content },
  });
  expect(saveRes.ok()).toBeTruthy();
  return id;
}

test.describe("Amendment A14: listen and voice notes", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("the listen page plays fixture audio, skips, and persists position", async ({
    page,
  }) => {
    const ts = Date.now();
    const content =
      "Paragraph one opens the chapter.\n\n" +
      "Paragraph two carries it forward.\n\n" +
      "Paragraph three brings it to a close.";
    const id = await createChapterWithDraft(page, `Listen ${ts}`, content);

    await page.goto(`/listen/${id}`);
    const player = page.getByTestId("listen-player");
    await expect(player).toBeVisible();
    await expect(page.getByTestId("listen-position")).toHaveText("paragraph 1 of 3");
    const audio = page.getByTestId("listen-audio");
    await expect(audio).toHaveAttribute(
      "src",
      new RegExp(`/api/chapters/${id}/audio/0$`),
    );

    // Play then pause: the player reflects its state transitions (we assert player
    // state, not actual sound).
    await page.getByTestId("listen-play").click();
    await expect(player).toHaveAttribute("data-playing", "true");
    await page.getByTestId("listen-play").click();
    await expect(player).toHaveAttribute("data-playing", "false");

    // Skip forward past two paragraphs.
    await page.getByTestId("listen-next").click();
    await expect(page.getByTestId("listen-position")).toHaveText("paragraph 2 of 3");
    await expect(audio).toHaveAttribute(
      "src",
      new RegExp(`/api/chapters/${id}/audio/1$`),
    );
    await page.getByTestId("listen-next").click();
    await expect(page.getByTestId("listen-position")).toHaveText("paragraph 3 of 3");
    // Next is disabled at the end.
    await expect(page.getByTestId("listen-next")).toBeDisabled();

    // Skip back.
    await page.getByTestId("listen-prev").click();
    await expect(page.getByTestId("listen-position")).toHaveText("paragraph 2 of 3");

    // Position survives a reload (localStorage resume).
    await page.reload();
    await expect(page.getByTestId("listen-position")).toHaveText("paragraph 2 of 3");
    await expect(page.getByTestId("listen-audio")).toHaveAttribute(
      "src",
      new RegExp(`/api/chapters/${id}/audio/1$`),
    );
  });

  test("a voice note lands as a comment anchored to the target paragraph", async ({
    page,
  }) => {
    const ts = Date.now();
    const content =
      "Mara crossed the bridge at dawn. She did not look back.\n\n" +
      "Kesh waited on the far bank, saying nothing.";
    const id = await createChapterWithDraft(page, `Voice ${ts}`, content);

    await page.goto(`/listen/${id}`);
    await expect(page.getByTestId("listen-player")).toBeVisible();

    // The hold-to-record button is present, or the graceful fallback message is.
    await expect(
      page
        .getByTestId("voice-record-button")
        .or(page.getByTestId("voice-record-unsupported")),
    ).toBeVisible();

    // MediaRecorder cannot be driven headlessly, so upload a small blob through the
    // same endpoint the button posts to, targeting paragraph 0.
    const result = await page.evaluate(async (chapterId) => {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], {
        type: "audio/webm",
      });
      const form = new FormData();
      form.append("audio", blob, "note.webm");
      form.append("chapterId", String(chapterId));
      form.append("paragraphIndex", "0");
      const res = await fetch("/api/voice-notes", { method: "POST", body: form });
      return { ok: res.ok, body: (await res.json()) as { transcript: string } };
    }, id);
    expect(result.ok).toBeTruthy();
    expect(result.body.transcript.length).toBeGreaterThan(0);

    // The comment appears on the review page, anchored to paragraph 0's opening
    // sentence, carrying the fixture transcript.
    await page.goto(`/book/1/chapter/${id}/review`);
    const list = page.getByTestId("comment-list");
    await expect(list).toContainText("Mara crossed the bridge at dawn.");
    await expect(list).toContainText(result.body.transcript);
  });

  test("quiet Listen links and the review voice-note affordance show when configured", async ({
    page,
  }) => {
    const ts = Date.now();
    const id = await createChapterWithDraft(
      page,
      `Links ${ts}`,
      "A single paragraph draft for the link checks.",
    );

    await page.goto(`/book/1/chapter/${id}/draft`);
    await expect(page.getByTestId("listen-link")).toBeVisible();

    await page.goto(`/book/1/chapter/${id}/review`);
    await expect(page.getByTestId("listen-link")).toBeVisible();
    await expect(page.getByTestId("voice-note-recorder")).toBeVisible();
  });
});
