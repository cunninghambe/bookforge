import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A5: character chatbots. The character, its states, and locked chapters
// are created via the API (the patterns from phase5.spec.ts); the chat page is
// then driven through the pin flow, a fixture reply, the propose-as-fact gate, and
// a check that nothing is persisted.

async function createCharacter(page: Page, name: string): Promise<number> {
  const res = await page.request.post("/api/characters", {
    data: {
      name,
      voiceRules: "dry, understated, never says the thing directly",
    },
  });
  return (await res.json()).character.id as number;
}

async function addState(
  page: Page,
  characterId: number,
  chapterOrder: number,
  fields: { knows?: string; feels?: string; hiding?: string },
) {
  const res = await page.request.post(
    `/api/characters/${characterId}/states`,
    { data: { projectId: 1, chapterOrder, ...fields } },
  );
  expect(res.ok()).toBeTruthy();
}

async function createLockedChapter(page: Page, title: string, content: string) {
  const res = await page.request.post("/api/chapters", {
    data: {
      projectId: 1,
      title,
      pov: "Mara",
      synopsis: "Mara climbs the tower.",
      beats: ["She climbs"],
    },
  });
  const id = (await res.json()).chapter.id as number;
  await page.request.post(`/api/chapters/${id}/save-draft`, {
    data: { content },
  });
  const lockRes = await page.request.post(`/api/chapters/${id}/lock`, {
    data: { fixtureKey: "phase5" },
  });
  expect(lockRes.ok()).toBeTruthy();
  return id;
}

async function setupCharacter(page: Page): Promise<number> {
  const id = await createCharacter(page, `Mara ${Date.now()}`);
  // Two states, effective from UI chapters 1 and 4 (internal orders 0 and 3).
  await addState(page, id, 0, {
    knows: "the fire was set on purpose",
    hiding: "that she is an elemental, from everyone",
  });
  await addState(page, id, 3, { knows: "Julian set the fire" });
  // A short horizon of locked chapters in Book 1.
  await createLockedChapter(page, `A5 ch1 ${Date.now()}`, "The gate stood open.");
  await createLockedChapter(page, `A5 ch2 ${Date.now()}`, "The hall was cold.");
  await createLockedChapter(page, `A5 ch3 ${Date.now()}`, "The stairs turned.");
  return id;
}

test.describe("Amendment A5: character chatbots", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("pins a moment, streams an in-voice reply, proposes it as a provisional fact, and persists no transcript", async ({
    page,
  }) => {
    const id = await setupCharacter(page);

    await page.goto(`/characters/${id}/chat?fx=chat1`);

    // No chat is possible until the moment is pinned: the opening asks when.
    await expect(page.getByTestId("chat-opening")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toHaveCount(0);

    // Pin book 1, chapter 3.
    await page.getByTestId("chat-book").selectOption("1");
    // A5.1b: the valid pin range is shown for the selected book.
    await expect(page.getByTestId("pin-range")).toContainText("1 to");
    await page.getByTestId("chat-chapter").fill("3");
    await page.getByTestId("set-pin-button").click();

    // The pin is visible and the chat surface appears.
    await expect(page.getByTestId("chat-pin")).toContainText("chapter");
    await expect(page.getByTestId("chat-pin")).toContainText("3");
    await expect(page.getByTestId("chat-input")).toBeVisible();

    // Send a message; the fixture reply streams into a bot message.
    await page.getByTestId("chat-input").fill("How do you carry yourself at court?");
    await page.getByTestId("send-button").click();

    const bot = page.getByTestId("bot-message");
    await expect(bot).toHaveCount(1);
    await expect(bot).toContainText("I keep the flame low");

    // Propose the reply as a canon fact through the explicit gate.
    await bot.getByRole("button", { name: "Propose as canon fact" }).click();
    // Type defaults to character_fact; scope defaults to the pinned book.
    await expect(bot.getByLabel("Proposed fact content")).toHaveValue(
      /I keep the flame low/,
    );
    await bot.getByRole("button", { name: "Propose as provisional fact" }).click();
    await expect(
      page.getByTestId("propose-success-1"),
    ).toBeVisible();

    // The provisional fact exists with source chat:<id> (asserted via the API).
    const canonRes = await page.request.get("/api/canon?status=provisional");
    const { facts } = (await canonRes.json()) as {
      facts: Array<{ content: string; status: string; source: string; projectId: number | null }>;
    };
    const proposed = facts.find((f) => f.content.includes("I keep the flame low"));
    expect(proposed).toBeTruthy();
    expect(proposed!.status).toBe("provisional");
    expect(proposed!.source).toBe(`chat:${id}`);
    expect(proposed!.projectId).toBe(1);

    // And it is visible at /canon as a provisional row.
    await page.goto("/canon");
    const row = page
      .getByTestId("canon-row")
      .filter({ hasText: "I keep the flame low" });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "provisional");

    // No chat transcript is persisted anywhere: the schema has no chat table.
    const tablesRes = await page.request.get("/api/dev/tables");
    const { tables } = (await tablesRes.json()) as { tables: string[] };
    expect(tables.some((t) => /chat|transcript|message/i.test(t))).toBe(false);
  });

  test("refuses in character about a post-pin event and surfaces the missing-fact note", async ({
    page,
  }) => {
    const id = await setupCharacter(page);

    await page.goto(`/characters/${id}/chat?fx=chat2`);
    await page.getByTestId("chat-book").selectOption("1");
    await page.getByTestId("chat-chapter").fill("3");
    await page.getByTestId("set-pin-button").click();

    await page.getByTestId("chat-input").fill("How does the book end?");
    await page.getByTestId("send-button").click();

    const bot = page.getByTestId("bot-message");
    await expect(bot).toHaveCount(1);
    // In-character refusal about an event after the pin.
    await expect(bot).toContainText("has not happened to me yet");
    // The [MISSING FACT] line is stripped from the reply and surfaced as a note.
    await expect(bot).not.toContainText("[MISSING FACT]");
    await expect(page.getByTestId("missing-fact-note-1")).toContainText(
      "outside the pinned knowledge horizon",
    );
  });
});
