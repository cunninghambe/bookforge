import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { testDb } from "./helpers";
import {
  modelFor,
  resolveModel,
  modelMap,
  envDefaultFor,
  MODEL_PURPOSES,
  FALLBACK_MODEL,
} from "@/lib/modelFor";
import { setSetting } from "@/lib/repo/settings";

// A8 resolver precedence: a settings override beats the purpose's env default, which
// beats the hardcoded fallback. Per-purpose env grouping: draft and revision read
// DRAFT_MODEL, every other purpose reads UTILITY_MODEL. Unknown purposes throw.

describe("modelFor resolver", () => {
  const savedDraft = process.env.DRAFT_MODEL;
  const savedUtility = process.env.UTILITY_MODEL;

  beforeEach(() => {
    delete process.env.DRAFT_MODEL;
    delete process.env.UTILITY_MODEL;
  });

  afterEach(() => {
    if (savedDraft === undefined) delete process.env.DRAFT_MODEL;
    else process.env.DRAFT_MODEL = savedDraft;
    if (savedUtility === undefined) delete process.env.UTILITY_MODEL;
    else process.env.UTILITY_MODEL = savedUtility;
  });

  it("falls back to the hardcoded default when no override and no env var", () => {
    const { db } = testDb();
    for (const purpose of MODEL_PURPOSES) {
      const r = resolveModel(db, purpose);
      expect(r.model).toBe(FALLBACK_MODEL);
      expect(r.source).toBe("fallback");
    }
  });

  it("uses the env default when set and no override (env beats fallback)", () => {
    process.env.DRAFT_MODEL = "env-draft";
    process.env.UTILITY_MODEL = "env-utility";
    const { db } = testDb();

    // draft and revision are the two prose purposes and read DRAFT_MODEL.
    for (const purpose of ["draft", "revision"] as const) {
      const r = resolveModel(db, purpose);
      expect(r.model).toBe("env-draft");
      expect(r.source).toBe("env");
    }
    // Everything else reads UTILITY_MODEL.
    for (const purpose of [
      "chat",
      "interrogation",
      "summary",
      "extraction",
      "sweep",
      "bible",
    ] as const) {
      const r = resolveModel(db, purpose);
      expect(r.model).toBe("env-utility");
      expect(r.source).toBe("env");
    }
  });

  it("uses the settings override when present (override beats env)", () => {
    process.env.DRAFT_MODEL = "env-draft";
    process.env.UTILITY_MODEL = "env-utility";
    const { db } = testDb();

    setSetting(db, "model.draft", "override-draft");
    setSetting(db, "model.sweep", "override-sweep");

    expect(resolveModel(db, "draft")).toEqual({
      model: "override-draft",
      source: "override",
    });
    expect(resolveModel(db, "sweep")).toEqual({
      model: "override-sweep",
      source: "override",
    });
    // A purpose without an override still reads its env default.
    expect(resolveModel(db, "revision")).toEqual({
      model: "env-draft",
      source: "env",
    });
    expect(resolveModel(db, "chat")).toEqual({
      model: "env-utility",
      source: "env",
    });
  });

  it("treats a blank override as absent (reverts to env then fallback)", () => {
    process.env.UTILITY_MODEL = "env-utility";
    const { db } = testDb();
    setSetting(db, "model.chat", "   ");
    expect(resolveModel(db, "chat")).toEqual({
      model: "env-utility",
      source: "env",
    });
  });

  it("modelFor returns just the string", () => {
    process.env.DRAFT_MODEL = "env-draft";
    const { db } = testDb();
    setSetting(db, "model.draft", "override-draft");
    expect(modelFor(db, "draft")).toBe("override-draft");
    expect(modelFor(db, "revision")).toBe("env-draft");
  });

  it("throws on an unknown purpose", () => {
    const { db } = testDb();
    expect(() => modelFor(db, "nonsense")).toThrow(/unknown model purpose/);
    // model_test is a real LlmPurpose but is NOT routable through modelFor.
    expect(() => modelFor(db, "model_test")).toThrow(/unknown model purpose/);
  });

  it("envDefaultFor groups purposes correctly and treats blank as unset", () => {
    process.env.DRAFT_MODEL = "d";
    process.env.UTILITY_MODEL = "u";
    expect(envDefaultFor("draft")).toBe("d");
    expect(envDefaultFor("revision")).toBe("d");
    expect(envDefaultFor("summary")).toBe("u");
    process.env.UTILITY_MODEL = "   ";
    expect(envDefaultFor("summary")).toBeUndefined();
  });

  it("modelMap reports effective, source, and override for every purpose", () => {
    process.env.DRAFT_MODEL = "env-draft";
    process.env.UTILITY_MODEL = "env-utility";
    const { db } = testDb();
    setSetting(db, "model.chat", "override-chat");

    const map = modelMap(db);
    expect(map.map((m) => m.purpose).sort()).toEqual([...MODEL_PURPOSES].sort());

    const chat = map.find((m) => m.purpose === "chat")!;
    expect(chat.effective).toBe("override-chat");
    expect(chat.source).toBe("override");
    expect(chat.override).toBe("override-chat");
    expect(chat.envDefault).toBe("env-utility");

    const draft = map.find((m) => m.purpose === "draft")!;
    expect(draft.effective).toBe("env-draft");
    expect(draft.source).toBe("env");
    expect(draft.override).toBeNull();
    expect(draft.envDefault).toBe("env-draft");
  });
});
