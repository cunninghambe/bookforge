// Removes the E2E test database (and its WAL/SHM sidecars) so every Playwright
// run starts from a fresh, seeded state. The E2E suites are written against a
// fresh DB; running them against a leftover one fails unpredictably. Wired in as
// the pretest:e2e npm script so `npm run test:e2e` can never hit the footgun.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const base = resolve(process.cwd(), "data", "test-e2e.db");
for (const suffix of ["", "-shm", "-wal"]) {
  try {
    rmSync(base + suffix, { force: true });
  } catch (err) {
    console.error(`Could not remove ${base + suffix}: ${err.message}`);
    console.error("Is a dev server still holding the test database open?");
    process.exit(1);
  }
}
console.log("Test database cleaned.");
