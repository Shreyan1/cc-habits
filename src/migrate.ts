import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, ensureDirs, logError } from './storage';

const OLD_DIR = path.join(os.homedir(), '.claude', 'habits');
const OLD_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

export interface MigrationResult {
  migrated: boolean;
  copiedFiles: string[];
  claudeMdUpdated: boolean;
}

export function runMigration(force = false, oldDirOverride?: string): MigrationResult {
  const result: MigrationResult = {
    migrated: false,
    copiedFiles: [],
    claudeMdUpdated: false,
  };

  const oldDir = oldDirOverride || OLD_DIR;
  const oldClaudeMd = oldDirOverride ? path.join(path.dirname(oldDirOverride), 'CLAUDE.md') : OLD_CLAUDE_MD;

  // If the old dir doesn't exist, nothing to migrate
  if (!fs.existsSync(oldDir)) {
    return result;
  }

  // Check if target habits.md already exists
  const targetHabitsFile = storagePaths.habitsFile;
  if (fs.existsSync(targetHabitsFile) && !force) {
    // Already migrated or initialized
    return result;
  }

  ensureDirs();

  const filesToMigrate = [
    'habits.md',
    'memories.md',
    'log.jsonl',
    '.tombstones.json',
    '.memory-tombstones.json',
    'config.yml',
    '.pending.json',
    '.memory-pending.json',
    '.snapshot.json',
    '.history.jsonl',
    '.provenance.json'
  ];

  for (const filename of filesToMigrate) {
    const src = path.join(oldDir, filename);
    const dest = path.join(storagePaths.habitsDir, filename);
    if (fs.existsSync(src)) {
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

  // Update CLAUDE.md import line
  if (fs.existsSync(oldClaudeMd)) {
    try {
      const oldImportStr = `@import ${path.join(oldDir, 'habits.md')}`;
      const newImportStr = `@import ${targetHabitsFile}`;
      let content = fs.readFileSync(oldClaudeMd, 'utf-8');
      if (content.includes(oldImportStr)) {
        content = content.replace(oldImportStr, newImportStr);
        fs.writeFileSync(oldClaudeMd, content, 'utf-8');
        result.claudeMdUpdated = true;
      }
    } catch (e) {
      logError(`migration: failed to update CLAUDE.md: ${String(e)}`);
    }
  }

  return result;
}
