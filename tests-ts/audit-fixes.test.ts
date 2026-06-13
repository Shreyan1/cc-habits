import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, appendSignal, addTombstone, isTombstoned,
  readHabitsMd, parseHabits, serialiseHabits, writeHabitsMd, tightenLegacyModes,
  appendHistory, logError, type HabitsMap, type Signal,
} from '../src/storage';
import { applyUpdates } from '../src/confidence';
import { writePreferencesFile } from '../src/sync';
import { cmdTombstone, readExtractionHealth } from '../src/cli';
import { processStop } from '../src/hook';
import * as extractor from '../src/extractor';

// Regression coverage for the v0.7.12 audit fixes: tombstone enforcement at the
// inject/reinforce paths, 0600 file modes, the lock no longer wrapping the LLM
// call, and the `cch status` extraction-health line.
vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
let tmpDir: string;

function gradHabit(rule: string): HabitsMap {
  return {
    TypeScript: [{
      rule,
      confidence: 0.6,
      reinforcing: 2,
      contradicting: 0,
      sessions_seen: 2,
      first_learned: '2026-06-01',
      last_updated: '2026-06-02',
    }],
  };
}

function sig(diff: string, session: string): Signal {
  return {
    type: 'edit',
    ts: new Date().toISOString(),
    source: 'claude-code',
    session_id: session,
    language: 'ts',
    file: 'src/x.ts',
    diff,
  };
}

const REAL_DIFFS = [
  '+export function double(x: number): number {\n+  return x * 2;\n+}',
  '+export const greet = (name: string): string => `hi ${name}`;',
  '+interface User {\n+  id: number;\n+  email: string;\n+}',
  '+export function clamp(n: number, lo: number, hi: number): number {\n+  return Math.max(lo, Math.min(hi, n));\n+}',
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-audit-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.preferencesFile = path.join(tmpDir, 'preferences.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.historyFile = path.join(tmpDir, '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, '.provenance.json');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  initHabitsMd();
  initLog();
  vi.mocked(extractor.extractRules).mockResolvedValue([]);
  vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([]);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tombstone enforcement (audit fix)', () => {
  it('does not reinforce a tombstoned rule that still exists in habits.md', () => {
    const cats = gradHabit('Use explicit return types');
    addTombstone('Use explicit return types');
    const beforeConf = cats.TypeScript[0].confidence;
    applyUpdates(cats, [{
      category: 'TypeScript', rule: 'Use explicit return types',
      decision: 'reinforce', matched_habit_id: 'Use explicit return types', reasoning: 'seen again',
    }]);
    expect(cats.TypeScript[0].confidence).toBe(beforeConf);
    expect(cats.TypeScript[0].sessions_seen).toBe(2);
  });

  it('still blocks re-creating a tombstoned rule', () => {
    const cats: HabitsMap = {};
    addTombstone('Use single quotes');
    applyUpdates(cats, [{
      category: 'Formatting', rule: 'Use single quotes',
      decision: 'create', matched_habit_id: '', reasoning: 'x',
    }]);
    expect(cats.Formatting ?? []).toHaveLength(0);
  });

  it('does not inject a tombstoned graduated habit into preferences.md', () => {
    writeHabitsMd(serialiseHabits(gradHabit('Use explicit return types')));
    addTombstone('Use explicit return types');
    writePreferencesFile();
    const prefs = fs.readFileSync(storagePaths.preferencesFile, 'utf-8');
    expect(prefs).not.toContain('Use explicit return types');
  });

  it('cmdTombstone removes the active rule from habits.md and tombstones it', () => {
    writeHabitsMd(serialiseHabits(gradHabit('Use explicit return types')));
    cmdTombstone('Use explicit return types');
    const cats = parseHabits(readHabitsMd());
    const stillThere = Object.values(cats).flat().some(h => h.rule === 'Use explicit return types');
    expect(stillThere).toBe(false);
    expect(isTombstoned('Use explicit return types')).toBe(true);
  });
});

describe('file mode hardening (audit fix)', () => {
  it.skipIf(process.platform === 'win32')('writePreferencesFile writes preferences.md owner-only (0600)', () => {
    writeHabitsMd(serialiseHabits(gradHabit('Use explicit return types')));
    writePreferencesFile();
    const mode = fs.statSync(storagePaths.preferencesFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(mode & 0o044).toBe(0); // neither group nor world readable
  });

  it.skipIf(process.platform === 'win32')('tightenLegacyModes tightens a world-readable store file', () => {
    const legacy = path.join(tmpDir, 'log.jsonl');
    fs.writeFileSync(legacy, 'x\n');
    fs.chmodSync(legacy, 0o644); // simulate a pre-0600 file regardless of umask
    expect(fs.statSync(legacy).mode & 0o077).not.toBe(0);
    tightenLegacyModes();
    expect(fs.statSync(legacy).mode & 0o777).toBe(0o600);
  });
});

describe('lock scope (audit fix)', () => {
  it('runs LLM extraction OUTSIDE the habits lock and releases it after', async () => {
    const lockFile = path.join(storagePaths.habitsDir, 'habits.lock');
    REAL_DIFFS.forEach(d => appendSignal(sig(d, 'sess-1')));

    let lockHeldDuringExtract = true;
    vi.mocked(extractor.extractRules).mockImplementationOnce(async () => {
      lockHeldDuringExtract = fs.existsSync(lockFile);
      return [];
    });

    await processStop('sess-1');

    expect(extractor.extractRules).toHaveBeenCalled();   // signals reached extraction
    expect(lockHeldDuringExtract).toBe(false);           // lock not held across the LLM call
    expect(fs.existsSync(lockFile)).toBe(false);         // released afterward
  });
});

describe('extraction health for cch status (audit fix)', () => {
  it('reports failing when the latest error is newer than the last success', () => {
    appendHistory({ ts: '2020-01-01T00:00:00.000Z', session_id: 's', habits_md: '' });
    logError('stop: fetch failed');
    const h = readExtractionHealth();
    expect(h.failing).toBe(true);
    expect(h.lastFailureMsg).toContain('fetch failed');
  });

  it('reports healthy when the last success is newer than the latest error', () => {
    logError('stop: fetch failed');
    appendHistory({ ts: new Date(Date.now() + 1000).toISOString(), session_id: 's', habits_md: '' });
    const h = readExtractionHealth();
    expect(h.failing).toBe(false);
  });

  it('ignores secondary memory/sync failures when judging extraction health', () => {
    appendHistory({ ts: '2020-01-01T00:00:00.000Z', session_id: 's', habits_md: '' });
    logError('stop: memory extraction failed: boom');
    const h = readExtractionHealth();
    expect(h.failing).toBe(false);
  });
});
