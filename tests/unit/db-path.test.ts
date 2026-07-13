import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { openRawDb, resolveDbPath } from "@/lib/db/raw";

// Scratch paths live inside the repo (tests/unit/.tmp-db-path), never outside
// the working directory, and are removed after each test.
const SCRATCH_DIR = join(process.cwd(), "tests", "unit", ".tmp-db-path");
const ORIGINAL_DATABASE_PATH = process.env.DATABASE_PATH;

function cleanup(): void {
  if (existsSync(SCRATCH_DIR)) rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

describe("resolveDbPath", () => {
  afterEach(() => {
    if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH;
    cleanup();
  });

  it("defaults to ./data/bookforge.db resolved against cwd", () => {
    delete process.env.DATABASE_PATH;
    expect(resolveDbPath()).toBe(resolve(process.cwd(), "./data/bookforge.db"));
  });

  it("honors a relative DATABASE_PATH, resolved against cwd", () => {
    process.env.DATABASE_PATH = "./tests/unit/.tmp-db-path/relative.db";
    expect(resolveDbPath()).toBe(
      resolve(process.cwd(), "./tests/unit/.tmp-db-path/relative.db"),
    );
  });

  it("honors an absolute DATABASE_PATH unchanged", () => {
    const absolute = join(SCRATCH_DIR, "absolute.db");
    process.env.DATABASE_PATH = absolute;
    expect(isAbsolute(absolute)).toBe(true);
    expect(resolveDbPath()).toBe(absolute);
  });
});

describe("openRawDb", () => {
  afterEach(() => {
    if (ORIGINAL_DATABASE_PATH === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = ORIGINAL_DATABASE_PATH;
    cleanup();
  });

  it("creates the parent directory when it does not exist, for a relative path", () => {
    const target = join(SCRATCH_DIR, "nested", "relative", "bookforge.db");
    expect(existsSync(target)).toBe(false);
    const db = openRawDb(target);
    expect(existsSync(target)).toBe(true);
    db.close();
  });

  it("creates the parent directory when it does not exist, for an absolute path", () => {
    const target = resolve(SCRATCH_DIR, "nested", "absolute", "bookforge.db");
    expect(isAbsolute(target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    const db = openRawDb(target);
    expect(existsSync(target)).toBe(true);
    db.close();
  });

  it("does not fail when the parent directory already exists", () => {
    const target = join(SCRATCH_DIR, "existing", "bookforge.db");
    const db1 = openRawDb(target);
    db1.close();
    expect(() => {
      const db2 = openRawDb(target);
      db2.close();
    }).not.toThrow();
  });

  it("falls back to resolveDbPath (DATABASE_PATH) when no path is given", () => {
    const target = join(SCRATCH_DIR, "env-driven", "bookforge.db");
    process.env.DATABASE_PATH = target;
    const db = openRawDb();
    expect(existsSync(target)).toBe(true);
    db.close();
  });
});
