import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, writeHabitsMd, writeMemoriesMd,
  appendSignal, writeConfigFile, sanitizeFilePath
} from '../src/storage';
import { acquireLock, releaseLock } from '../src/lock';

const isWindows = process.platform === 'win32';
const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-fs-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');

  initHabitsMd();
  initLog();
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('Layer 5: Local Filesystem Integrity & Sync Tests', () => {
  describe('Symlink Write Rejection (Risk #8)', () => {
    it.skipIf(isWindows)('throws and rejects writing habits.md through a symlink', () => {
      const decoy = path.join(tmpDir, 'decoy-habits.md');
      fs.writeFileSync(decoy, 'legit content');
      fs.unlinkSync(storagePaths.habitsFile);
      fs.symlinkSync(decoy, storagePaths.habitsFile);

      expect(() => writeHabitsMd('poisoned content')).toThrow(/symlink/);
      expect(fs.readFileSync(decoy, 'utf-8')).toBe('legit content');
    });

    it.skipIf(isWindows)('throws and rejects writing memories.md through a symlink', () => {
      const decoy = path.join(tmpDir, 'decoy-memories.md');
      fs.writeFileSync(decoy, 'legit memories');
      fs.symlinkSync(decoy, storagePaths.memoriesFile);

      expect(() => writeMemoriesMd('poisoned memories')).toThrow(/symlink/);
      expect(fs.readFileSync(decoy, 'utf-8')).toBe('legit memories');
    });

    it.skipIf(isWindows)('throws and rejects appending signals through a symlink', () => {
      const decoy = path.join(tmpDir, 'decoy-log.jsonl');
      fs.writeFileSync(decoy, 'initial logs\n');
      fs.unlinkSync(storagePaths.logFile);
      fs.symlinkSync(decoy, storagePaths.logFile);

      const sig = { ts: '2026-06-07T00:00:00Z', session_id: 's1', type: 'edit', file: 'a.ts', diff: '+x' };
      expect(() => appendSignal(sig)).toThrow(/symlink/);
      expect(fs.readFileSync(decoy, 'utf-8')).toBe('initial logs\n');
    });

    it.skipIf(isWindows)('throws and rejects writing config.yml through a symlink', () => {
      const decoy = path.join(tmpDir, 'decoy-config.yml');
      fs.writeFileSync(decoy, 'provider: anthropic\n');
      fs.symlinkSync(decoy, storagePaths.configFile);

      expect(() => writeConfigFile('provider: groq\n')).toThrow(/symlink/);
      expect(fs.readFileSync(decoy, 'utf-8')).toBe('provider: anthropic\n');
    });
  });

  describe('Path Traversal & Segment Sanitization', () => {
    it('neutralizes traversal segments and control characters in file paths', () => {
      expect(sanitizeFilePath('../../etc/passwd')).toBe('_/_/etc/passwd');
      expect(sanitizeFilePath('../../../etc/shadow')).toBe('_/_/_/etc/shadow');
      expect(sanitizeFilePath('src/components/../utils/file.ts')).toBe('src/components/_/utils/file.ts');
      expect(sanitizeFilePath('evil\x00file.ts')).toBe('evilfile.ts');
      expect(sanitizeFilePath('spaces\tfile.ts')).toBe('spacesfile.ts');
    });
  });

  describe('Concurrency & File Locking', () => {
    it('mutual exclusion: blocks second process from acquiring lock simultaneously', async () => {
      const lockFile = path.join(tmpDir, 'test.lock');

      // Process 1 acquires lock
      const acquired1 = await acquireLock(lockFile);
      expect(acquired1).toBe(true);

      // Verify lock file contains current process pid
      const content = fs.readFileSync(lockFile, 'utf-8').trim();
      expect(parseInt(content, 10)).toBe(process.pid);

      // Process 2 tries to acquire lock with short timeout, should fail
      const acquired2 = await acquireLock(lockFile, 200, 50);
      expect(acquired2).toBe(false);

      // Release lock
      releaseLock(lockFile);
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it('stale lock recovery: breaks stale locks from dead PIDs', async () => {
      const lockFile = path.join(tmpDir, 'test.lock');

      // Create a stale lock from a dummy dead PID (e.g. 999999)
      fs.writeFileSync(lockFile, '999999');

      // Attempt to acquire lock. It should recognize PID 999999 is dead, break it, and succeed
      const acquired = await acquireLock(lockFile, 500, 100);
      expect(acquired).toBe(true);
      expect(fs.readFileSync(lockFile, 'utf-8').trim()).toBe(String(process.pid));

      releaseLock(lockFile);
    });

    it('ownership safety: does not release locks owned by other PIDs', () => {
      const lockFile = path.join(tmpDir, 'test.lock');

      // Mock another process holding the lock
      fs.writeFileSync(lockFile, '123456');

      // Releasing lock should be a no-op because it belongs to PID 123456 (not process.pid)
      releaseLock(lockFile);
      expect(fs.existsSync(lockFile)).toBe(true);
      expect(fs.readFileSync(lockFile, 'utf-8').trim()).toBe('123456');
    });
  });
});
