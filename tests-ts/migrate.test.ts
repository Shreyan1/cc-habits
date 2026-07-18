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
    const habitsNormalized = storagePaths.habitsFile.replace(/\\/g, '/');
    const prefsNormalized = storagePaths.preferencesFile.replace(/\\/g, '/');
    const oldImport = `@import ${habitsNormalized}`;
    fs.writeFileSync(claudeMd, `# My project\n\n${oldImport}\n`);

    const result = runMigration(false, nonExistentOldDir());

    expect(result.claudeMdUpdated).toBe(true);
    expect(result.migrated).toBe(false); // no file copy, legacy dir absent

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content).toContain(`@import ${prefsNormalized}`);
    expect(content).not.toContain(`@import ${habitsNormalized}`);
    // Surrounding user content preserved.
    expect(content).toContain('# My project');
  });

  it('is idempotent: second runMigration is a no-op when already pointing at preferences.md', () => {
    const prefsNormalized = storagePaths.preferencesFile.replace(/\\/g, '/');
    const newImport = `@import ${prefsNormalized}`;
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

// Migration must be additive: it copies legacy data into a store that has none,
// but must never clobber a file the store already has. The regression this
// guards: a user runs `cch init` (writing config.yml with their provider) before
// any habit exists, so habits.md is absent and the copy step runs; copying the
// legacy config.yml over the fresh one silently reverted their provider/api key
// to a stale one (e.g. a leftover `provider: groq`).
describe('runMigration, does not overwrite an existing config.yml', () => {
  // Build a legacy dir with a habits.md (so the copy step has something to do)
  // and a config.yml carrying a different, stale provider.
  function seedLegacyDir(providerLine: string): string {
    const legacy = path.join(tmpDir, 'legacy-habits');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'habits.md'), '# habits\n');
    fs.writeFileSync(path.join(legacy, 'config.yml'), `${providerLine}\n`);
    return legacy;
  }

  it('preserves the current config.yml while still migrating other files', () => {
    // Current store: a config the user just wrote, but no habits.md yet.
    fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'provider: ollama\n');
    const legacy = seedLegacyDir('provider: groq');

    const result = runMigration(false, legacy);

    // config.yml is left untouched: the user keeps ollama, not the legacy groq.
    const cfg = fs.readFileSync(path.join(tmpDir, 'config.yml'), 'utf-8');
    expect(cfg).toContain('provider: ollama');
    expect(cfg).not.toContain('groq');
    expect(result.copiedFiles).not.toContain('config.yml');
    // But the migration still ran for files the store did not already have.
    expect(fs.existsSync(storagePaths.habitsFile)).toBe(true);
    expect(result.copiedFiles).toContain('habits.md');
  });

  it('still overwrites on an explicit force re-migration', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yml'), 'provider: ollama\n');
    const legacy = seedLegacyDir('provider: groq');

    runMigration(true, legacy);

    const cfg = fs.readFileSync(path.join(tmpDir, 'config.yml'), 'utf-8');
    expect(cfg).toContain('provider: groq');
  });
});
