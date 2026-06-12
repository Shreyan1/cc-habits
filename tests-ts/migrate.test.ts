/**
 * Tests for runMigration unconditional CLAUDE.md @import rewrite (Fix 2).
 * Verifies that v0.6.x users (no legacy dir, storage already at ~/.cc-habits/)
 * get their @import …/habits.md rewritten to …/preferences.md on startup.
 *
 * Setup: temp dir via CC_HABITS_DIR; all storagePaths redirected so no real
 * user files are touched.
 * Teardown: temp dir removed, storagePaths restored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigration } from '../src/migrate';
import { storagePaths } from '../src/storage';

const origStorage = { ...storagePaths };

let tmpDir: string;
let claudeMd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-migrate-'));
  // Redirect storagePaths so migrate.ts operates entirely in tmpDir.
  storagePaths.habitsDir       = tmpDir;
  storagePaths.habitsFile      = path.join(tmpDir, 'habits.md');
  storagePaths.preferencesFile = path.join(tmpDir, 'preferences.md');
  // Place CLAUDE.md in tmpDir (same pattern as install.ts uses ~/. claude/).
  claudeMd = path.join(tmpDir, 'CLAUDE.md');
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// oldDirOverride must be a non-existent path within tmpDir so the legacy-dir
// gate fails (no copy step) while the CLAUDE.md derivation (path.dirname) still
// resolves to tmpDir where our test CLAUDE.md lives.
function nonExistentOldDir(): string {
  return path.join(tmpDir, 'legacy-habits');
}

describe('runMigration, CLAUDE.md @import rewrite (Fix 2)', () => {
  it('rewrites @import <habitsFile> to preferences.md when no legacy dir exists (v0.6.x user)', () => {
    // Seed CLAUDE.md with the exact string that would have been written by v0.6.x install.
    const oldImport = `@import ${storagePaths.habitsFile}`;
    fs.writeFileSync(claudeMd, `# My project\n\n${oldImport}\n`);

    const result = runMigration(false, nonExistentOldDir());

    expect(result.claudeMdUpdated).toBe(true);
    expect(result.migrated).toBe(false); // no file copy, legacy dir absent

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain(`@import ${storagePaths.preferencesFile}`);
    expect(content).not.toContain(`@import ${storagePaths.habitsFile}`);
    // Surrounding user content preserved.
    expect(content).toContain('# My project');
  });

  it('is idempotent: second runMigration is a no-op when already pointing at preferences.md', () => {
    const newImport = `@import ${storagePaths.preferencesFile}`;
    fs.writeFileSync(claudeMd, `${newImport}\n`);

    const result = runMigration(false, nonExistentOldDir());

    expect(result.claudeMdUpdated).toBe(false);
    // File must be byte-for-byte identical.
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(`${newImport}\n`);
  });

  it('leaves a CLAUDE.md that has no cc-habits @import completely untouched', () => {
    const original = '# Project\n\nSome user content here.\n';
    fs.writeFileSync(claudeMd, original);

    const result = runMigration(false, nonExistentOldDir());

    expect(result.claudeMdUpdated).toBe(false);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(original);
  });

  it('is a no-op when CLAUDE.md does not exist', () => {
    // Do not create claudeMd.
    expect(() => runMigration(false, nonExistentOldDir())).not.toThrow();
  });
});
