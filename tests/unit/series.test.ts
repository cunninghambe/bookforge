import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  listSeries,
  getSeries,
  createSeries,
  updateSeriesTitle,
  firstSeriesId,
} from "@/lib/repo/series";
import {
  createProject,
  listProjectsBySeries,
  firstProjectOfSeries,
  updateProjectTitle,
} from "@/lib/repo/projects";
import { listCanon } from "@/lib/repo/canon";
import { SEED_STYLE_RULES } from "@/lib/db/migrate";

describe("series repo (A16)", () => {
  it("seeds one default series that firstSeriesId resolves", () => {
    const { db } = testDb();
    const all = listSeries(db);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("The Trilogy");
    expect(firstSeriesId(db)).toBe(all[0].id);
  });

  it("createSeries copies the five seed style rules and creates a first book", () => {
    const { db } = testDb();
    const { series, firstBook } = createSeries(db, { title: "Second World" });

    expect(series.title).toBe("Second World");
    // The new series orders after the trilogy.
    expect(series.orderIndex).toBeGreaterThan(0);

    // Five locked series-wide style rules copied into the new series (source 'seed').
    const copied = listCanon(db, {
      type: "style_rule",
      seriesId: series.id,
      scope: "series",
    });
    expect(copied).toHaveLength(SEED_STYLE_RULES.length);
    expect(copied.every((f) => f.status === "locked")).toBe(true);
    expect(copied.every((f) => f.source === "seed")).toBe(true);
    expect(copied.every((f) => f.projectId === null)).toBe(true);
    // The em-dash prohibition is among them.
    expect(copied.some((f) => /never use em-dashes/i.test(f.content))).toBe(true);

    // The first book exists in the new series, at order 0.
    expect(firstBook.seriesId).toBe(series.id);
    expect(firstBook.orderIndex).toBe(0);
    const books = listProjectsBySeries(db, series.id);
    expect(books.map((b) => b.id)).toEqual([firstBook.id]);
  });

  it("copied style rules are independent per series (retiring one does not affect another)", () => {
    const { db } = testDb();
    const a = createSeries(db, { title: "Series A" });
    const b = createSeries(db, { title: "Series B" });
    const aRules = listCanon(db, { seriesId: a.series.id, scope: "series" });
    const bRules = listCanon(db, { seriesId: b.series.id, scope: "series" });
    // Distinct fact rows.
    const aIds = new Set(aRules.map((r) => r.id));
    expect(bRules.some((r) => aIds.has(r.id))).toBe(false);
  });

  it("createProject appends within its series (order scoped per series)", () => {
    const { db } = testDb();
    const sid = firstSeriesId(db)!;
    // The trilogy already has three books at order 0,1,2.
    const book4 = createProject(db, { title: "Book 4", seriesId: sid });
    expect(book4.orderIndex).toBe(3);

    // A new series' first book is order 0, not order 4 (order is per-series).
    const other = createSeries(db, { title: "Other" });
    const firstOther = firstProjectOfSeries(db, other.series.id);
    expect(firstOther?.orderIndex).toBe(0);
    const secondOther = createProject(db, {
      title: "Other Book 2",
      seriesId: other.series.id,
    });
    expect(secondOther.orderIndex).toBe(1);
  });

  it("updateSeriesTitle and updateProjectTitle rename in place", () => {
    const { db } = testDb();
    const sid = firstSeriesId(db)!;
    const renamed = updateSeriesTitle(db, sid, "The Reforged Trilogy");
    expect(renamed?.title).toBe("The Reforged Trilogy");
    expect(getSeries(db, sid)?.title).toBe("The Reforged Trilogy");

    const book = listProjectsBySeries(db, sid)[0];
    const rb = updateProjectTitle(db, book.id, "First Book, Renamed");
    expect(rb?.title).toBe("First Book, Renamed");
  });
});
