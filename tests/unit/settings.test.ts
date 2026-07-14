import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
} from "@/lib/repo/settings";

// A8 settings repo: round-trip, upsert-overwrite, delete, and prefix listing.
describe("settings repo", () => {
  it("round-trips a value and overwrites on re-set", () => {
    const { db } = testDb();
    expect(getSetting(db, "model.draft")).toBeUndefined();
    setSetting(db, "model.draft", "claude-fable-5");
    expect(getSetting(db, "model.draft")).toBe("claude-fable-5");
    // Upsert overwrites, does not duplicate.
    setSetting(db, "model.draft", "claude-opus-4-8");
    expect(getSetting(db, "model.draft")).toBe("claude-opus-4-8");
    expect(listSettings(db, "model.")).toHaveLength(1);
  });

  it("deletes a key and is a no-op on an absent key", () => {
    const { db } = testDb();
    setSetting(db, "model.chat", "sonnet");
    deleteSetting(db, "model.chat");
    expect(getSetting(db, "model.chat")).toBeUndefined();
    // No throw on deleting something that is not there.
    expect(() => deleteSetting(db, "model.chat")).not.toThrow();
  });

  it("lists by prefix and excludes non-matching keys", () => {
    const { db } = testDb();
    setSetting(db, "model.draft", "a");
    setSetting(db, "model.sweep", "b");
    setSetting(db, "other.thing", "c");
    const rows = listSettings(db, "model.").sort((x, y) =>
      x.key.localeCompare(y.key),
    );
    expect(rows).toEqual([
      { key: "model.draft", value: "a" },
      { key: "model.sweep", value: "b" },
    ]);
  });
});
