import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, initHabitsMd, initLog, readHabitsMd, readSignals, writeHabitsMd, serialiseHabits, readHistory } from '../src/storage';
import { runMigration } from '../src/migrate';
import { captureFromCli } from '../src/capture';
import { runGitCapture, shouldTriggerGitLearn } from '../src/git-collector';
import { cmdLearn } from '../src/cli';
import * as extractor from '../src/extractor';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-v040-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
  storagePaths.memoryIndexFile = path.join(tmpDir, '.memory-index.json');
  storagePaths.memoryPendingFile = path.join(tmpDir, '.memory-pending.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.pendingFile = path.join(tmpDir, '.pending.json');
  storagePaths.historyFile = path.join(tmpDir, '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, '.provenance.json');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  
  vi.mocked(extractor.extractRules).mockResolvedValue([]);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  delete process.env['CC_HABITS_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('v0.3.0: runMigration', () => {
  it('does nothing if old directory does not exist', () => {
    const res = runMigration(true, path.join(tmpDir, 'nonexistent-old-dir'));
    expect(res.migrated).toBe(false);
  });
});

describe('v0.3.0: captureFromCli', () => {
  it('appends a signal to the log and sets source field', () => {
    initLog();
    const success = captureFromCli({
      file: 'src/main.py',
      diff: '+++ src/main.py\n+def run():\n+    print("ok")',
      session: 'test-session',
      source: 'cli',
    });
    expect(success).toBe(true);

    const signals = readSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].file).toBe('src/main.py');
    expect(signals[0].source).toBe('cli');
  });

  it('rejects noisy diffs', () => {
    initLog();
    const success = captureFromCli({
      file: 'src/main.py',
      diff: ' ', // empty/noise
      session: 'test-session',
      source: 'cli',
    });
    expect(success).toBe(false);
    expect(readSignals()).toHaveLength(0);
  });
});

describe('v0.3.0: runGitCapture and shouldTriggerGitLearn', () => {
  it('shouldTriggerGitLearn handles empty history', () => {
    expect(shouldTriggerGitLearn()).toBe(false);
  });

  it('runGitCapture handles non-git directory gracefully', () => {
    const res = runGitCapture(undefined, tmpDir);
    expect(res.signalsCaptured).toBe(0);
  });
});

describe('v0.3.0: cmdLearn', () => {
  it('exits early with fewer than 3 signals', async () => {
    initHabitsMd();
    initLog();
    // 0 signals in log
    const exitCode = await cmdLearn();
    expect(exitCode).toBe(0);
  });

  it('compiles habits and writes snapshot on successful learn', async () => {
    initHabitsMd();
    initLog();

    // Seed 3 valid signals
    for (let i = 0; i < 3; i++) {
      captureFromCli({
        file: `src/file_${i}.ts`,
        diff: `+++ src/file_${i}.ts\n+const a = 1;`,
        session: 'learn-session',
        source: 'cli',
      });
    }

    vi.mocked(extractor.extractRules).mockResolvedValueOnce([
      { category: 'TS', rule: 'Prefer const', decision: 'create', matched_habit_id: '', reasoning: '' },
    ]);

    const exitCode = await cmdLearn({ session: 'learn-session' });
    expect(exitCode).toBe(0);
    expect(readHabitsMd()).toContain('Prefer const');
    expect(readHistory()).toHaveLength(1);
  });
});
