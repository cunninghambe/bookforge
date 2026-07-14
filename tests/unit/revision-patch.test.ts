import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parsePatchEnvelope,
  applyPatches,
  replacementsHaveEmDash,
  flaggedCoverage,
  shouldUseFullMode,
} from "@/lib/revision/patch";
import { analyzeRevision, type FlaggedSpan } from "@/lib/revision/diff";

const phase4Case = JSON.parse(
  readFileSync(
    new URL("../fixtures/phase4.case.json", import.meta.url),
    "utf8",
  ),
) as {
  old: string;
  flagQuote: string;
  expectedAccept: string;
  expectedReject: string;
};

const a4Fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/revision.a4patch.json", import.meta.url),
    "utf8",
  ),
) as { text: string };

describe("parsePatchEnvelope", () => {
  it("parses a valid patch envelope", () => {
    const res = parsePatchEnvelope(
      '{"patches":[{"original":"a","replacement":"b"}],"consistency_fixes":[]}',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.envelope.patches).toEqual([{ original: "a", replacement: "b" }]);
      expect(res.envelope.consistencyFixes).toEqual([]);
    }
  });

  it("parses a code-fenced envelope and drops entries with an empty original", () => {
    const res = parsePatchEnvelope(
      '```json\n{"patches":[{"original":"a","replacement":"b"},{"original":"","replacement":"x"}]}\n```',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.envelope.patches).toHaveLength(1);
  });

  it("fails on a full-text prose revision (no patch object)", () => {
    // A full-text revision, including a trailing [CONSISTENCY FIXES] block, must
    // not parse as a patch envelope, so the route falls back to full mode.
    const fullText =
      "Mara climbed the stairs.\n\n[CONSISTENCY FIXES]:\n- Renamed Kesh to Kessa.";
    const res = parsePatchEnvelope(fullText);
    expect(res.ok).toBe(false);
  });

  it("fails on garbage", () => {
    expect(parsePatchEnvelope("not json at all").ok).toBe(false);
  });
});

describe("applyPatches", () => {
  it("applies multiple patches offset-safely regardless of order", () => {
    const text = "one two three four five";
    const forward = applyPatches(
      text,
      [
        { original: "one", replacement: "ONE" },
        { original: "five", replacement: "FIVE" },
      ],
      [],
    );
    const reversed = applyPatches(
      text,
      [
        { original: "five", replacement: "FIVE" },
        { original: "one", replacement: "ONE" },
      ],
      [],
    );
    expect(forward.newText).toBe("ONE two three four FIVE");
    expect(reversed.newText).toBe(forward.newText);
    expect(forward.failedPatches).toHaveLength(0);
  });

  it("collects a failed anchor while the others still apply", () => {
    const text = "alpha beta gamma";
    const res = applyPatches(
      text,
      [
        { original: "alpha", replacement: "ALPHA" },
        { original: "not-present", replacement: "X" },
      ],
      [],
    );
    expect(res.newText).toBe("ALPHA beta gamma");
    expect(res.failedPatches).toHaveLength(1);
    expect(res.failedPatches[0].original).toBe("not-present");
    expect(res.failedPatches[0].reason).toBe("not found");
  });

  it("collects an overlapping patch as failed while the earlier one applies", () => {
    const text = "the quick brown fox";
    const res = applyPatches(
      text,
      [
        { original: "quick brown", replacement: "slow" },
        { original: "brown fox", replacement: "red hound" },
      ],
      [],
    );
    expect(res.newText).toBe("the slow fox");
    expect(res.failedPatches).toHaveLength(1);
    expect(res.failedPatches[0].reason).toBe("overlap");
  });

  it("returns the justifications of applied consistency fixes", () => {
    const text = "Kesh waited.";
    const res = applyPatches(
      text,
      [],
      [
        {
          original: "Kesh",
          replacement: "Kessa",
          justification: "Renamed Kesh to Kessa.",
        },
      ],
    );
    expect(res.newText).toBe("Kessa waited.");
    expect(res.declaredJustifications).toEqual(["Renamed Kesh to Kessa."]);
  });
});

describe("replacementsHaveEmDash", () => {
  it("detects an em-dash in a patch replacement", () => {
    // The literal em-dash here is negative-test input for the lint only.
    expect(
      replacementsHaveEmDash(
        [{ original: "a", replacement: "b — c" }],
        [],
      ),
    ).toBe(true);
  });

  it("detects an em-dash in a consistency-fix replacement", () => {
    expect(
      replacementsHaveEmDash(
        [],
        [{ original: "a", replacement: "b — c", justification: "j" }],
      ),
    ).toBe(true);
  });

  it("passes clean replacements", () => {
    expect(
      replacementsHaveEmDash(
        [{ original: "a", replacement: "b, c" }],
        [{ original: "d", replacement: "e. f", justification: "j" }],
      ),
    ).toBe(false);
  });
});

describe("flaggedCoverage / shouldUseFullMode", () => {
  it("chooses full mode when flagged spans cover more than 40 percent", () => {
    const text = "0123456789"; // 10 chars
    const spans: FlaggedSpan[] = [{ quotedText: "012345" }]; // 6 chars = 60%
    expect(flaggedCoverage(text, spans)).toBeCloseTo(0.6, 5);
    expect(shouldUseFullMode(text, spans)).toBe(true);
  });

  it("stays in patch mode for a small flagged span", () => {
    const text = "0123456789";
    const spans: FlaggedSpan[] = [{ quotedText: "01" }]; // 20%
    expect(shouldUseFullMode(text, spans)).toBe(false);
  });

  it("merges overlapping spans so coverage is not double counted", () => {
    const text = "0123456789";
    const spans: FlaggedSpan[] = [
      { quotedText: "0123" },
      { quotedText: "2345" },
    ];
    // Union is chars 0..5 (6 chars) = 60%, not 8/10.
    expect(flaggedCoverage(text, spans)).toBeCloseTo(0.6, 5);
  });
});

// The load-bearing invariant: a patch-produced newText, fed to the UNMODIFIED
// analyzeRevision, classifies exactly as Phase 4's full-text revision did.
describe("patch output through the frozen classifier", () => {
  it("classifies in-span authorized, declared fix passes, undeclared patch unauthorized", () => {
    const envelope = JSON.parse(a4Fixture.text) as {
      patches: Array<{ original: string; replacement: string }>;
      consistency_fixes: Array<{
        original: string;
        replacement: string;
        justification: string;
      }>;
    };
    const consistencyFixes = envelope.consistency_fixes.map((f) => ({
      original: f.original,
      replacement: f.replacement,
      justification: f.justification,
    }));
    const applied = applyPatches(
      phase4Case.old,
      envelope.patches,
      consistencyFixes,
    );

    // The mechanically applied full text matches Phase 4's expected accept text.
    expect(applied.newText).toBe(phase4Case.expectedAccept);

    const flaggedSpans: FlaggedSpan[] = [{ quotedText: phase4Case.flagQuote }];
    const analysis = analyzeRevision(phase4Case.old, applied.newText, {
      flaggedSpans,
      consistencyFixes: applied.declaredJustifications,
    });

    const byClass = (c: string) =>
      analysis.hunks.filter((h) => h.classification === c);
    expect(byClass("authorized").length).toBe(1);
    expect(byClass("declared").length).toBe(1);
    expect(byClass("unauthorized").length).toBe(1);
    expect(analysis.unauthorizedCount).toBe(1);

    // The single unauthorized hunk is the undeclared quiet -> dark change.
    const unauth = byClass("unauthorized")[0];
    expect(unauth.newText).toContain("dark");
    expect(unauth.oldText).toContain("quiet");
  });
});
