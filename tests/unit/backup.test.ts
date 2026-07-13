import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupDbFile, formatTimestamp } from "../../scripts/backup-core.mjs";

// Scratch directory lives inside the repo and is removed after every test.
const SCRATCH_DIR = join(process.cwd(), "tests", "unit", ".tmp-backup");

function cleanup(): void {
  if (existsSync(SCRATCH_DIR)) rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

describe("formatTimestamp", () => {
  it("formats as YYYYMMDD-HHmmss, zero padded", () => {
    const date = new Date(2026, 6, 3, 4, 5, 6); // 2026-07-03 04:05:06 local
    expect(formatTimestamp(date)).toBe("20260703-040506");
  });
});

describe("backupDbFile", () => {
  afterEach(cleanup);

  it("refuses cleanly when the database file does not exist", () => {
    const dbPath = join(SCRATCH_DIR, "missing", "bookforge.db");
    const backupDir = join(SCRATCH_DIR, "missing", "backups");
    expect(() => backupDbFile({ dbPath, backupDir })).toThrow(/not found/i);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("creates the backup directory and copies the file with a timestamp suffix", () => {
    const dbDir = join(SCRATCH_DIR, "basic");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "bookforge.db");
    writeFileSync(dbPath, "fake sqlite bytes");
    const backupDir = join(dbDir, "backups");

    expect(existsSync(backupDir)).toBe(false);
    const now = new Date(2026, 0, 15, 9, 30, 0);
    const result = backupDbFile({ dbPath, backupDir, now });

    expect(existsSync(backupDir)).toBe(true);
    expect(result.targetPath).toBe(join(backupDir, "bookforge-20260115-093000.db"));
    expect(existsSync(result.targetPath)).toBe(true);
    expect(result.copiedSidecars).toEqual([]);
  });

  it("copies -wal and -shm sidecars when present", () => {
    const dbDir = join(SCRATCH_DIR, "wal");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "bookforge.db");
    writeFileSync(dbPath, "main file bytes");
    writeFileSync(`${dbPath}-wal`, "wal bytes");
    writeFileSync(`${dbPath}-shm`, "shm bytes");
    const backupDir = join(dbDir, "backups");

    const now = new Date(2026, 0, 15, 9, 30, 0);
    const result = backupDbFile({ dbPath, backupDir, now });

    expect(result.copiedSidecars).toHaveLength(2);
    for (const sidecar of result.copiedSidecars) {
      expect(existsSync(sidecar)).toBe(true);
    }
    expect(existsSync(`${result.targetPath}-wal`)).toBe(true);
    expect(existsSync(`${result.targetPath}-shm`)).toBe(true);
  });

  it("skips sidecar copy when only one of -wal/-shm exists", () => {
    const dbDir = join(SCRATCH_DIR, "partial-wal");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "bookforge.db");
    writeFileSync(dbPath, "main file bytes");
    writeFileSync(`${dbPath}-wal`, "wal bytes");
    const backupDir = join(dbDir, "backups");

    const result = backupDbFile({ dbPath, backupDir, now: new Date() });
    expect(result.copiedSidecars).toHaveLength(1);
    expect(result.copiedSidecars[0].endsWith("-wal")).toBe(true);
  });

  it("does not fail when the backup directory already exists", () => {
    const dbDir = join(SCRATCH_DIR, "existing-dir");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "bookforge.db");
    writeFileSync(dbPath, "bytes");
    const backupDir = join(dbDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    expect(() => backupDbFile({ dbPath, backupDir, now: new Date() })).not.toThrow();
  });
});
