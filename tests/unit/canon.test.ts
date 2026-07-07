import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  assemblableCanon,
  bulkCreateCanon,
  createCanon,
  listCanon,
  updateCanon,
} from "@/lib/repo/canon";

describe("canon repo", () => {
  it("creates a provisional fact by default", () => {
    const { db } = testDb();
    const f = createCanon(db, { type: "world_rule", content: "Magic is loud." });
    expect(f.status).toBe("provisional");
    expect(f.source).toBe("manual");
    expect(f.projectId).toBeNull();
  });

  it("locks and retires via update, and filters by status", () => {
    const { db } = testDb();
    const f = createCanon(db, { type: "world_rule", content: "Iron burns them." });
    updateCanon(db, f.id, { status: "locked" });
    expect(listCanon(db, { status: "locked", type: "world_rule" }).length).toBe(1);
    updateCanon(db, f.id, { status: "retired" });
    expect(listCanon(db, { status: "locked", type: "world_rule" }).length).toBe(0);
    expect(listCanon(db, { status: "retired" }).length).toBe(1);
  });

  it("scopes facts by series vs book", () => {
    const { db } = testDb();
    createCanon(db, { type: "plot_decision", content: "series wide", projectId: null });
    createCanon(db, { type: "plot_decision", content: "book one", projectId: 1 });
    expect(listCanon(db, { scope: "series", type: "plot_decision" }).length).toBe(1);
    expect(listCanon(db, { scope: 1, type: "plot_decision" }).length).toBe(1);
  });

  it("bulk creates one provisional fact per non-empty line", () => {
    const { db } = testDb();
    const created = bulkCreateCanon(db, {
      type: "timeline_event",
      lines: "a\n\n  b  \nc\n",
    });
    expect(created.length).toBe(3);
    expect(created.every((f) => f.status === "provisional")).toBe(true);
    expect(created.map((f) => f.content)).toEqual(["a", "b", "c"]);
  });

  it("assemblableCanon includes locked in-scope only, excludes retired/provisional/out-of-scope", () => {
    const { db } = testDb();
    // Seeded style rules are locked + series-wide. Filter to plot_decision here.
    createCanon(db, { type: "plot_decision", content: "locked series", status: "locked", projectId: null });
    createCanon(db, { type: "plot_decision", content: "locked book1", status: "locked", projectId: 1 });
    createCanon(db, { type: "plot_decision", content: "locked book2", status: "locked", projectId: 2 });
    createCanon(db, { type: "plot_decision", content: "provisional", status: "provisional", projectId: 1 });
    const retired = createCanon(db, { type: "plot_decision", content: "retired", status: "locked", projectId: 1 });
    updateCanon(db, retired.id, { status: "retired" });

    const got = assemblableCanon(db, { projectId: 1, types: ["plot_decision"] });
    const contents = got.map((f) => f.content).sort();
    expect(contents).toEqual(["locked book1", "locked series"]);
  });
});
