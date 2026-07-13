import { describe, it, expect } from "vitest";
import {
  analyzeRevision,
  applyResolution,
  type AnalyzeInput,
} from "@/lib/revision/diff";

// A chapter-ish body of separable paragraphs. The filler paragraph is deliberately
// longer than the 200-char tolerance window so the final paragraph sits outside any
// flagged span's reach.
const P0 = "Mara crossed the bridge at dawn.";
const P1 = "The river below was the colour of old iron.";
const FILLER =
  "The market beyond the wall was already awake, and the smell of it reached her before the sight did: bread and coal smoke and the sour tang of the tanneries, all of it braided together into the single smell that meant she was home again, whether she wanted to be or not.";
const P3 = "She did not look back at the city.";

const OLD = [P0, P1, FILLER, P3].join("\n\n");

// The author flags a span inside P1.
const FLAG_P1: AnalyzeInput = {
  flaggedSpans: [{ quotedText: "the colour of old iron", comment: "too flat" }],
  consistencyFixes: [],
};

function replace(text: string, from: string, to: string): string {
  return text.replace(from, to);
}

describe("analyzeRevision classification", () => {
  it("classifies an in-span change as authorized", () => {
    const NEW = replace(OLD, P1, "The river below was the colour of dull pewter.");
    const { hunks, unauthorizedCount } = analyzeRevision(OLD, NEW, FLAG_P1);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].classification).toBe("authorized");
    expect(unauthorizedCount).toBe(0);
  });

  it("classifies a change within the 200-char tolerance window as authorized", () => {
    // P0 is a separate paragraph but sits within 200 chars of the flagged span in P1.
    const NEW = replace(OLD, P0, "Mara crossed the old bridge at first light.");
    const { hunks, unauthorizedCount } = analyzeRevision(OLD, NEW, FLAG_P1);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].classification).toBe("authorized");
    expect(unauthorizedCount).toBe(0);
  });

  it("flags an out-of-span undeclared change as unauthorized", () => {
    // P3 is beyond the tolerance window (the filler paragraph separates it).
    const NEW = replace(OLD, P3, "She looked back at the city one last time.");
    const { hunks, unauthorizedCount } = analyzeRevision(OLD, NEW, FLAG_P1);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].classification).toBe("unauthorized");
    expect(unauthorizedCount).toBe(1);
  });

  it("passes an out-of-span change declared in [CONSISTENCY FIXES]", () => {
    const NEW = replace(OLD, P3, "She did not look back at Cindral.");
    const input: AnalyzeInput = {
      flaggedSpans: FLAG_P1.flaggedSpans,
      consistencyFixes: [
        'Renamed "city" to "Cindral" to match the flagged rename.',
      ],
    };
    const { hunks, unauthorizedCount } = analyzeRevision(OLD, NEW, input);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].classification).toBe("declared");
    expect(hunks[0].declaredBy).toMatch(/Cindral/);
    expect(unauthorizedCount).toBe(0);
  });

  it("separates an authorized change and an unauthorized change into distinct hunks", () => {
    let NEW = replace(OLD, P1, "The river below was the colour of dull pewter.");
    NEW = replace(NEW, P3, "She looked back at the city one last time.");
    const { hunks, unauthorizedCount } = analyzeRevision(OLD, NEW, FLAG_P1);
    expect(hunks).toHaveLength(2);
    const kinds = hunks.map((h) => h.classification).sort();
    expect(kinds).toEqual(["authorized", "unauthorized"]);
    expect(unauthorizedCount).toBe(1);
  });
});

describe("applyResolution reconstruction", () => {
  it("accepting every hunk reproduces the new text exactly", () => {
    let NEW = replace(OLD, P1, "The river below was the colour of dull pewter.");
    NEW = replace(NEW, P3, "She looked back at the city one last time.");
    const { hunks } = analyzeRevision(OLD, NEW, FLAG_P1);
    const decisions: Record<number, "accept" | "reject"> = {};
    for (const h of hunks) decisions[h.index] = "accept";
    expect(applyResolution(OLD, NEW, FLAG_P1, decisions)).toBe(NEW);
  });

  it("rejecting a hunk restores exactly the original text for that hunk while keeping accepted ones", () => {
    const P1_NEW = "The river below was the colour of dull pewter.";
    const P3_NEW = "She looked back at the city one last time.";
    let NEW = replace(OLD, P1, P1_NEW);
    NEW = replace(NEW, P3, P3_NEW);
    const { hunks } = analyzeRevision(OLD, NEW, FLAG_P1);
    const authorized = hunks.find((h) => h.classification === "authorized")!;
    const unauthorized = hunks.find((h) => h.classification === "unauthorized")!;
    const decisions = { [unauthorized.index]: "reject" as const };
    const result = applyResolution(OLD, NEW, FLAG_P1, decisions);
    // Expected: the authorized P1 change is kept, the unauthorized P3 change reverts.
    const expected = [P0, P1_NEW, FILLER, P3].join("\n\n");
    expect(result).toBe(expected);
    // Sanity: the authorized change really is present, the rejected one is gone.
    expect(result).toContain(P1_NEW);
    expect(result).not.toContain(P3_NEW);
    void authorized;
  });

  it("rejecting every unauthorized hunk still keeps authorized and declared changes", () => {
    // A body with a fourth paragraph, all of P3 and P4 beyond the flag's window.
    const P4 = "The gate guards knew her by name.";
    const OLD2 = [P0, P1, FILLER, P3, P4].join("\n\n");
    const P1_NEW = "The river below was the colour of dull pewter.";
    let NEW = replace(OLD2, P1, P1_NEW); // authorized (in-span)
    NEW = replace(NEW, P3, "She did not look back at Cindral."); // declared
    NEW = replace(NEW, P4, "The gate guards did not know her."); // unauthorized
    const input: AnalyzeInput = {
      flaggedSpans: FLAG_P1.flaggedSpans,
      consistencyFixes: ['Renamed "city" to "Cindral" to match the rename.'],
    };
    const { hunks } = analyzeRevision(OLD2, NEW, input);
    expect(hunks.map((h) => h.classification).sort()).toEqual([
      "authorized",
      "declared",
      "unauthorized",
    ]);
    const decisions: Record<number, "accept" | "reject"> = {};
    for (const h of hunks) {
      if (h.classification === "unauthorized") decisions[h.index] = "reject";
    }
    const result = applyResolution(OLD2, NEW, input, decisions);
    expect(result).toContain(P1_NEW); // authorized kept
    expect(result).toContain("Cindral"); // declared kept
    expect(result).toContain("The gate guards knew her by name."); // unauthorized reverted
    expect(result).not.toContain("did not know her");
  });
});
