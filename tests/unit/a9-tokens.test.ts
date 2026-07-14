import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A9 repo check: components and pages must use the semantic design tokens, never
// raw Tailwind palette classes. This keeps the token system from silently eroding
// as new UI is added. globals.css and tailwind.config.ts DEFINE the tokens and are
// exempt by nature; this check scans only .tsx under src/app and src/components.
//
// The forbidden list matches exactly what A9 migrated away from: neutral scale
// (surfaces, text, borders, dividers), the four alert palettes (amber/sky/red/
// green), and raw bg-white / text-white.

const root = fileURLToPath(new URL("../../", import.meta.url));

const FORBIDDEN: RegExp[] = [
  /\bbg-white\b/,
  /\btext-white\b/,
  /\bbg-neutral-\d+\b/,
  /\btext-neutral-\d+\b/,
  /\bborder-neutral-\d+\b/,
  /\bdivide-neutral-\d+\b/,
  /\bbg-amber-\d+\b/,
  /\btext-amber-\d+\b/,
  /\bborder-amber-\d+\b/,
  /\bbg-sky-\d+\b/,
  /\btext-sky-\d+\b/,
  /\bborder-sky-\d+\b/,
  /\bbg-red-\d+\b/,
  /\btext-red-\d+\b/,
  /\bborder-red-\d+\b/,
  /\bbg-green-\d+\b/,
  /\btext-green-\d+\b/,
  /\bborder-green-\d+\b/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("A9 design tokens are used, not raw palette classes", () => {
  const files = [
    ...walk(join(root, "src", "app")),
    ...walk(join(root, "src", "components")),
  ];

  it("scans a non-trivial number of UI files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = file.slice(root.length).replace(/\\/g, "/");
    it(`${rel} has no forbidden raw palette classes`, () => {
      const source = readFileSync(file, "utf8");
      const hits: string[] = [];
      for (const re of FORBIDDEN) {
        const m = source.match(new RegExp(re, "g"));
        if (m) hits.push(...m);
      }
      expect(hits, `raw palette classes found in ${rel}: ${hits.join(", ")}`).toEqual([]);
    });
  }
});
