import { test, expect, type Page } from "@playwright/test";
import { login } from "./helpers";

// Amendment A16: multiple series and creating books. The acceptance check: create
// a new series and a book in it through the UI; add a canon fact and a character
// to the new series; the new book's assembled prompt (dev inspector) contains its
// own canon and character and none of the trilogy's series-wide canon or
// characters; the trilogy's own prompt is unchanged; the palette finds content
// from both series (global by default) and the seriesId filter narrows it; rename
// a series and a book and see both stick.
test.describe("Amendment A16: multiple series and creating books", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("create series and book, scoped prompt, unchanged trilogy, global search, rename", async ({
    page,
  }: {
    page: Page;
  }) => {
    // The seeded database starts with three books in one series, "The Trilogy".
    const trilogy = (
      (await (await page.request.get("/api/series")).json()) as {
        series: Array<{ id: number; title: string }>;
      }
    ).series.find((s) => s.title === "The Trilogy")!;
    expect(trilogy).toBeTruthy();

    // A distinctive trilogy series-wide canon fact (projectId null defaults to the
    // first series, the trilogy) and a trilogy character.
    await page.request.post("/api/canon", {
      data: {
        type: "world_rule",
        content: "TRILOGYSECRET binds the old houses.",
        status: "locked",
        projectId: null,
      },
    });
    await page.request.post("/api/characters", {
      data: { name: "Trilogyhero", seriesId: trilogy.id },
    });

    // Create a new series through the UI (copies the seed rules, makes a first book).
    await page.goto("/");
    await page.getByTestId("new-series-toggle").click();
    const seriesTitle = "Standalone Saga";
    await page.getByTestId("new-series-title").fill(seriesTitle);
    await page.getByTestId("new-series-submit").click();

    const group = page
      .getByTestId("series-group")
      .filter({ hasText: seriesTitle });
    await expect(group).toBeVisible();

    // Add a book to the new series through the UI.
    await group.getByTestId("new-book-title").fill("Saga Book Two");
    await group.getByTestId("new-book-submit").click();
    const newBookRow = group
      .getByTestId("book-row")
      .filter({ hasText: "Saga Book Two" });
    await expect(newBookRow).toBeVisible();
    const newBookId = Number(await newBookRow.getAttribute("data-project-id"));
    expect(Number.isFinite(newBookId)).toBe(true);

    // Resolve the new series id.
    const newSeries = (
      (await (await page.request.get("/api/series")).json()) as {
        series: Array<{ id: number; title: string }>;
      }
    ).series.find((s) => s.title === seriesTitle)!;
    expect(newSeries).toBeTruthy();

    // Add a canon fact (scoped to the new book) and a character to the new series.
    await page.request.post("/api/canon", {
      data: {
        type: "world_rule",
        content: "SAGARULE governs the standalone world.",
        status: "locked",
        projectId: newBookId,
      },
    });
    await page.request.post("/api/characters", {
      data: { name: "Sagahero", seriesId: newSeries.id },
    });

    // A chapter in the new book with the new character as POV.
    const newChapter = (
      (await (
        await page.request.post("/api/chapters", {
          data: {
            projectId: newBookId,
            title: "Saga Ch",
            pov: "Sagahero",
            synopsis: "Sagahero begins.",
            beats: ["Sagahero acts"],
          },
        })
      ).json()) as { chapter: { id: number } }
    ).chapter;

    // The new book's assembled prompt: its own canon and character, none of the
    // trilogy's series-wide canon or characters.
    const assembled = JSON.stringify(
      await (await page.request.get(`/api/dev/prompt/${newChapter.id}`)).json(),
    );
    expect(assembled).toContain("SAGARULE");
    expect(assembled).toContain("Sagahero");
    expect(assembled).not.toContain("TRILOGYSECRET");
    expect(assembled).not.toContain("Trilogyhero");

    // The trilogy's own prompt is unchanged: a trilogy chapter still sees its own
    // canon and character, and none of the new series'.
    const trilogyChapter = (
      (await (
        await page.request.post("/api/chapters", {
          data: {
            projectId: 1,
            title: "Trilogy Ch",
            pov: "Trilogyhero",
            synopsis: "Trilogyhero returns.",
            beats: ["Trilogyhero acts"],
          },
        })
      ).json()) as { chapter: { id: number } }
    ).chapter;
    const trilogyAssembled = JSON.stringify(
      await (
        await page.request.get(`/api/dev/prompt/${trilogyChapter.id}`)
      ).json(),
    );
    expect(trilogyAssembled).toContain("TRILOGYSECRET");
    expect(trilogyAssembled).toContain("Trilogyhero");
    expect(trilogyAssembled).not.toContain("SAGARULE");
    expect(trilogyAssembled).not.toContain("Sagahero");

    // The palette (global search) finds content from both series.
    const sagaHits = (
      (await (await page.request.get("/api/search?q=SAGARULE")).json()) as {
        results: unknown[];
      }
    ).results;
    expect(sagaHits.length).toBeGreaterThan(0);
    const trilogyHits = (
      (await (
        await page.request.get("/api/search?q=TRILOGYSECRET")
      ).json()) as { results: unknown[] }
    ).results;
    expect(trilogyHits.length).toBeGreaterThan(0);
    // The optional seriesId filter narrows: SAGARULE is not in the trilogy series.
    const filtered = (
      (await (
        await page.request.get(`/api/search?q=SAGARULE&seriesId=${trilogy.id}`)
      ).json()) as { results: unknown[] }
    ).results;
    expect(filtered.length).toBe(0);

    // Rename the series through the UI; it sticks after a reload. Locate the group
    // and book row by their stable data ids, since the visible title becomes an
    // input during a rename and a text filter would stop matching.
    await page.goto("/");
    const groupLoc = page.locator(
      `[data-testid="series-group"][data-series-id="${newSeries.id}"]`,
    );
    await groupLoc.getByTestId("series-rename").click();
    await groupLoc.getByTestId("series-rename-input").fill("Standalone Saga Renamed");
    await groupLoc.getByTestId("series-rename-save").click();
    await expect(groupLoc.getByTestId("series-title")).toHaveText(
      "Standalone Saga Renamed",
    );

    // Rename the book through the UI; it sticks too.
    const bookRowLoc = page.locator(
      `[data-testid="book-row"][data-project-id="${newBookId}"]`,
    );
    await bookRowLoc.getByTestId("book-rename").click();
    await bookRowLoc.getByTestId("book-rename-input").fill("Saga Book Two Renamed");
    await bookRowLoc.getByTestId("book-rename-save").click();
    await expect(bookRowLoc.getByTestId("book-link")).toHaveText(
      "Saga Book Two Renamed",
    );

    // Both renames persist across a fresh load.
    await page.goto("/");
    await expect(groupLoc.getByTestId("series-title")).toHaveText(
      "Standalone Saga Renamed",
    );
    await expect(bookRowLoc.getByTestId("book-link")).toHaveText(
      "Saga Book Two Renamed",
    );
  });
});
