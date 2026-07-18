import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, ensureDirs, logError } from './storage';
import { writePreferencesFile } from './sync';

const OLD_DIR = path.join(os.homedir(), '.claude', 'habits');
const OLD_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

export interface MigrationResult {
  migrated: boolean;
  copiedFiles: string[];
  claudeMdUpdated: boolean;
}

// Rewrite a @import line in CLAUDE.md that points at habits.md to point at
// preferences.md instead. Runs unconditionally on every startup so v0.6.x users
// (storage already at ~/.cc-habits/, no legacy dir) get the fix on first upgrade.
// Idempotent: no-op when already pointing at preferencesFile or when the file
// contains no cc-habits @import at all.
function rewriteClaudeMdImport(
  claudeMdPath: string,
  habitsFilePath: string,
  preferencesFilePath: string,
): boolean {
  const oNoFollow: number = (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(claudeMdPath, fs.constants.O_RDWR | oNoFollow);

    // Best-effort symlink check on Windows where O_NOFOLLOW is a no-op
    if (!oNoFollow && fs.lstatSync(claudeMdPath).isSymbolicLink()) {
      fs.closeSync(fd);
      return false;
    }

    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      fs.closeSync(fd);
      return false;
    }

    const buf = Buffer.alloc(st.size);
    let readBytes = 0;
    if (st.size > 0) {
      readBytes = fs.readSync(fd, buf, 0, st.size, 0);
    }
    let content = buf.subarray(0, readBytes).toString('utf-8');
    const newImport = `@import ${preferencesFilePath}`;
    // Already correct, idempotent no-op.
    if (content.includes(newImport)) {
      fs.closeSync(fd);
      return false;
    }
    let updated = false;
    // Pattern 1: legacy pre-rename install (~/.claude/habits/habits.md).
    const oldDirImport = `@import ${path.join(OLD_DIR, 'habits.md')}`;
    if (content.includes(oldDirImport)) {
      content = content.replace(oldDirImport, newImport);
      updated = true;
    }
    // Pattern 2: v0.6.x install (~/.cc-habits/habits.md, current storage, old import).
    const currentHabitsImport = `@import ${habitsFilePath}`;
    if (content.includes(currentHabitsImport)) {
      content = content.replace(currentHabitsImport, newImport);
      updated = true;
    }
    if (!updated) {
      fs.closeSync(fd);
      return false;
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, content, 0);
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (e && e.code === 'ENOENT') {
      return false;
    }
    logError(`migration: failed to update CLAUDE.md: ${String(e)}`);
    return false;
  }
}

export function runMigration(force = false, oldDirOverride?: string): MigrationResult {
  const result: MigrationResult = {
    migrated: false,
    copiedFiles: [],
    claudeMdUpdated: false,
  };

  const oldDir = oldDirOverride || OLD_DIR;
  const oldClaudeMd = oldDirOverride ? path.join(path.dirname(oldDirOverride), 'CLAUDE.md') : OLD_CLAUDE_MD;

  // Step 1: Rewrite CLAUDE.md @import unconditionally (catches v0.6.x users who
  // already have ~/.cc-habits/ but still import habits.md instead of preferences.md).
  if (rewriteClaudeMdImport(oldClaudeMd, storagePaths.habitsFile, storagePaths.preferencesFile)) {
    result.claudeMdUpdated = true;
  }

  // If the old dir doesn't exist, nothing more to migrate.
  if (!fs.existsSync(oldDir)) {
    return result;
  }

  // Step 2: Perform file migration if habits.md doesn't exist yet in target.
  const targetHabitsFile = storagePaths.habitsFile;
  const targetPreferencesFile = storagePaths.preferencesFile;
  if (!fs.existsSync(targetHabitsFile) || force) {
    ensureDirs();

    const filesToMigrate = [
      'habits.md',
      'memories.md',
      'log.jsonl',
      '.tombstones.json',
      '.memory-tombstones.json',
      'config.yml',
      '.snapshot.json',
      '.history.jsonl',
      '.provenance.json'
    ];

    for (const filename of filesToMigrate) {
      const src = path.join(oldDir, filename);
      const dest = path.join(storagePaths.habitsDir, filename);
      // Migration is additive: never clobber a file the current store already
      // has (unless an explicit force re-migration is requested). The gate above
      // only checks habits.md, but config.yml can exist on its own, e.g. right
      // after `cch init` sets a provider before any habit is learned. Copying the
      // legacy config over it silently reverts the user's chosen provider and
      // api key to a stale one. Skipping existing files keeps the user's config
      // and any other data they already have intact.
      if (fs.existsSync(src) && (force || !fs.existsSync(dest))) {
        try {
          fs.copyFileSync(src, dest);
          result.copiedFiles.push(filename);
        } catch (e) {
          logError(`migration: failed to copy ${filename}: ${String(e)}`);
        }
      }
    }

    if (result.copiedFiles.length > 0) {
      result.migrated = true;
    }
  }

  // 3. Always ensure preferences.md is populated (either on fresh migration or if missing)
  if (fs.existsSync(targetHabitsFile) && !fs.existsSync(targetPreferencesFile)) {
    try {
      writePreferencesFile();
    } catch (e) {
      logError(`migration: failed to generate preferences.md: ${String(e)}`);
    }
  }

  return result;
}
