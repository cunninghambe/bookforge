// A9 one-shot token migration. Replaces raw Tailwind palette classes with the
// semantic token classes across src/app and src/components. Deterministic,
// exact-substring replacements applied in order. Run once; safe to re-run.
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const rules = [
  // Focus states first (before generic border rules).
  ["focus:border-neutral-500 focus:outline-none", "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:border-edge"],
  ["focus:border-neutral-500", "focus-visible:border-focus"],
  ["hover:bg-neutral-50", "hover:bg-inset"],

  // Accent (primary action) gets a hover state for free.
  ["bg-neutral-900", "bg-accent hover:bg-accent-hover"],
  ["bg-white", "bg-surface"],
  ["bg-neutral-50", "bg-inset"],
  ["bg-neutral-100", "bg-chip"],
  ["bg-neutral-200", "bg-chip"],

  ["text-neutral-400", "text-faint"],
  ["text-neutral-500", "text-muted"],
  ["text-neutral-600", "text-muted"],
  ["text-neutral-700", "text-ink"],
  ["text-neutral-800", "text-ink"],
  ["text-neutral-900", "text-ink"],
  ["text-white", "text-accent-ink"],

  ["divide-neutral-200", "divide-edge-soft"],
  ["border-neutral-300", "border-edge"],
  ["border-neutral-200", "border-edge-soft"],
  ["border-neutral-100", "border-edge-soft"],

  // warn (amber)
  ["bg-amber-50", "bg-warn"],
  ["bg-amber-100", "bg-warn-chip"],
  ["bg-amber-200", "bg-warn-chip"],
  ["border-amber-200", "border-warn-edge"],
  ["border-amber-300", "border-warn-edge"],
  ["border-amber-400", "border-warn-edge"],
  ["text-amber-700", "text-warn-ink"],
  ["text-amber-800", "text-warn-ink"],
  ["text-amber-900", "text-warn-ink"],

  // info (sky)
  ["bg-sky-50", "bg-info"],
  ["bg-sky-100", "bg-info-chip"],
  ["border-sky-200", "border-info-edge"],
  ["border-sky-300", "border-info-edge"],
  ["text-sky-700", "text-info-ink"],
  ["text-sky-800", "text-info-ink"],

  // danger (red)
  ["bg-red-50", "bg-danger"],
  ["bg-red-100", "bg-danger-chip"],
  ["border-red-300", "border-danger-edge"],
  ["border-red-500", "border-danger-strong"],
  ["text-red-400", "text-danger-ink"],
  ["text-red-500", "text-danger-ink"],
  ["text-red-600", "text-danger-ink"],
  ["text-red-700", "text-danger-ink"],
  ["text-red-800", "text-danger-ink"],

  // ok (green)
  ["bg-green-50", "bg-ok"],
  ["bg-green-100", "bg-ok-chip"],
  ["border-green-300", "border-ok-edge"],
  ["border-green-500", "border-ok-strong"],
  ["text-green-600", "text-ok-ink"],
  ["text-green-700", "text-ok-ink"],
  ["text-green-800", "text-ok-ink"],
];

const files = [
  ...globSync("src/app/**/*.tsx"),
  ...globSync("src/components/**/*.tsx"),
];

let changed = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of rules) after = after.split(from).join(to);
  if (after !== before) {
    writeFileSync(file, after);
    changed++;
    console.log("migrated", file);
  }
}
console.log(`\n${changed} file(s) migrated of ${files.length} scanned.`);
