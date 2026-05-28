import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths,
  appendSignal,
  readSignals,
  initHabitsMd,
  initLog,
  initMemoriesMd,
  readHabitsMd,
  readMemoriesMd,
  writeHabitsMd,
  writeMemoriesMd,
  parseHabits,
  serialiseHabits,
  parseMemories,
  serialiseMemories,
  applyMemoryUpdates,
  addMemoryTombstone,
  isMemoryTombstoned,
  readMemoryTombstones,
} from '../src/storage';

// Save originals once
const origPaths = { ...storagePaths };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-test-'));
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
  initHabitsMd();
  initMemoriesMd();
  initLog();
});

afterEach(() => {
  Object.assign(storagePaths, origPaths);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('storage', () => {
  it('appends a signal and reads it back', () => {
    appendSignal({ ts: '2026-05-18T00:00:00Z', session_id: 'x', type: 'edit', file: 'a.py', diff: '-old\n+new' });
    const sigs = readSignals();
    expect(sigs).toHaveLength(1);
    expect(sigs[0].file).toBe('a.py');
  });

  it('filters signals by session_id', () => {
    appendSignal({ ts: '2026-05-18T00:00:00Z', session_id: 'a', type: 'edit', file: 'a.py', diff: '-x\n+y' });
    appendSignal({ ts: '2026-05-18T00:00:00Z', session_id: 'b', type: 'edit', file: 'b.py', diff: '-x\n+y' });
    expect(readSignals('a')).toHaveLength(1);
    expect(readSignals('b')).toHaveLength(1);
    expect(readSignals()).toHaveLength(2);
  });

  it('initHabitsMd creates the file with header', () => {
    expect(fs.existsSync(storagePaths.habitsFile)).toBe(true);
    const content = fs.readFileSync(storagePaths.habitsFile, 'utf-8');
    expect(content).toContain('# Coding habits');
  });

  it('writes and reads habits.md', () => {
    writeHabitsMd('# test\n\n## Python\n\n- Use type hints. Confidence: 0.75\n  - Signal: 3 reinforcing, 0 contradicting\n  - First learned: 2026-05-18\n  - Last updated: 2026-05-18\n\n');
    const md = readHabitsMd();
    expect(md).toContain('## Python');
    expect(md).toContain('Confidence: 0.75');
  });

  it('parse and serialise round-trip preserves habits', () => {
    const cats = {
      Python: [{
        rule: 'Use type hints',
        confidence: 0.75,
        reinforcing: 5,
        contradicting: 1,
        sessions_seen: 3,
        first_learned: '2026-05-18',
        last_updated: '2026-05-18',
      }],
    };
    const md = serialiseHabits(cats);
    const cats2 = parseHabits(md);
    expect(cats2['Python']).toHaveLength(1);
    expect(cats2['Python'][0].rule).toBe('Use type hints');
    expect(cats2['Python'][0].confidence).toBeCloseTo(0.75);
    expect(cats2['Python'][0].reinforcing).toBe(5);
    expect(cats2['Python'][0].contradicting).toBe(1);
    expect(cats2['Python'][0].sessions_seen).toBe(3);
  });

  it('serialise produces valid markdown with required keys', () => {
    const cats = {
      TypeScript: [{
        rule: 'Use strict mode',
        confidence: 0.75,
        reinforcing: 3,
        contradicting: 0,
        sessions_seen: 4,
        first_learned: '2026-05-18',
        last_updated: '2026-05-18',
      }],
    };
    const md = serialiseHabits(cats);
    expect(md).toContain('## TypeScript');
    expect(md).toContain('Confidence: 0.75');
    expect(md).toContain('Signal:');
    expect(md).toContain('Sessions seen: 4');
    expect(md).toContain('First learned:');
  });

  it('trims log.jsonl when it exceeds 2 MB, keeping the most recent lines', () => {
    // Write enough data to exceed the 2 MB rotation threshold.
    // Each signal is ~300 bytes; 8000 signals ≈ 2.4 MB which is > LOG_ROTATE_BYTES.
    const base: Omit<ReturnType<typeof readSignals>[0], 'ts'> = {
      session_id: 'rot', type: 'edit', file: 'app.ts',
      diff: '+' + 'x'.repeat(250),
    };
    for (let i = 0; i < 8_000; i++) {
      appendSignal({ ...base, ts: `2026-05-22T00:00:${String(i % 60).padStart(2, '0')}Z` });
    }
    const stat = fs.statSync(storagePaths.logFile);
    // After rotation the file must be well below the 2 MB trigger.
    expect(stat.size).toBeLessThan(2 * 1024 * 1024);
    // Rotation must have discarded entries: far fewer than the 8000 written.
    const lines = fs.readFileSync(storagePaths.logFile, 'utf-8')
      .split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThan(8_000);
    // The trimmed file must still be valid JSONL.
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('single-session habits land in Learning section, not active', () => {
    const cats = {
      Python: [
        { rule: 'Confirmed rule', confidence: 0.60, reinforcing: 2, contradicting: 0, sessions_seen: 2 },
        { rule: 'Learning rule', confidence: 0.50, reinforcing: 1, contradicting: 0, sessions_seen: 1 },
      ],
    };
    const md = serialiseHabits(cats);
    expect(md).toContain('## Python');
    expect(md).toContain('Confirmed rule');
    expect(md).toContain('## Learning');
    expect(md).toContain('[Python] Learning rule');
    expect(md.indexOf('Confirmed rule')).toBeLessThan(md.indexOf('Learning rule'));
  });

  it('initMemoriesMd creates the memories file with header', () => {
    expect(fs.existsSync(storagePaths.memoriesFile)).toBe(true);
    const content = readMemoriesMd();
    expect(content).toContain('<!-- cc-habits memories format v0.1 -->');
    expect(content).toContain('# Coding memories');
  });

  it('writes and reads memories.md', () => {
    writeMemoriesMd('# Coding memories\n\n## Repeated mistakes\n\n- Avoid overwriting settings.\n');
    expect(readMemoriesMd()).toContain('Avoid overwriting settings');
  });

  it('parse and serialise round-trip preserves active memories', () => {
    const memories = {
      'Repeated mistakes': [{
        text: 'When modifying Claude Code hook installation, preserve existing user settings arrays instead of overwriting them',
        trigger: ['src/install.ts', 'settings.json', 'hook installation'],
        correction: 'Merge new hooks with existing hooks and preserve unrelated entries',
        confidence: 0.80,
        seen: 3,
        sessions_seen: 2,
        languages: ['ts'],
        first_seen: '2026-05-28',
        last_seen: '2026-05-28',
      }],
    };
    const md = serialiseMemories(memories);
    expect(md).toContain('## Repeated mistakes');
    expect(md).toContain('Trigger: src/install.ts, settings.json, hook installation');
    const parsed = parseMemories(md);
    expect(parsed['Repeated mistakes']).toHaveLength(1);
    expect(parsed['Repeated mistakes'][0].text).toContain('preserve existing user settings arrays');
    expect(parsed['Repeated mistakes'][0].trigger).toEqual(['src/install.ts', 'settings.json', 'hook installation']);
    expect(parsed['Repeated mistakes'][0].correction).toContain('Merge new hooks');
    expect(parsed['Repeated mistakes'][0].confidence).toBeCloseTo(0.80);
    expect(parsed['Repeated mistakes'][0].seen).toBe(3);
    expect(parsed['Repeated mistakes'][0].sessions_seen).toBe(2);
    expect(parsed['Repeated mistakes'][0].languages).toEqual(['ts']);
  });

  it('single-session memories land in Candidates section, not active', () => {
    const memories = {
      'Repeated mistakes': [
        {
          text: 'Active memory',
          trigger: ['install'],
          correction: 'Preserve settings',
          confidence: 0.80,
          seen: 3,
          sessions_seen: 2,
        },
        {
          text: 'Candidate memory',
          trigger: ['parser'],
          correction: 'Update tests',
          confidence: 0.50,
          seen: 1,
          sessions_seen: 1,
        },
      ],
    };
    const md = serialiseMemories(memories);
    expect(md).toContain('## Repeated mistakes');
    expect(md).toContain('Active memory');
    expect(md).toContain('## Candidates (not yet active)');
    expect(md).toContain('[Repeated mistakes] Candidate memory');
    expect(md.indexOf('Active memory')).toBeLessThan(md.indexOf('Candidate memory'));
    const parsed = parseMemories(md);
    expect(parsed['Repeated mistakes']).toHaveLength(2);
    expect(parsed['Repeated mistakes'][1].sessions_seen).toBe(1);
  });

  it('applyMemoryUpdates adds new candidates', () => {
    const count = applyMemoryUpdates([{
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite arrays',
      trigger: ['settings.json'],
      correction: 'Merge arrays',
    }]);
    expect(count).toBe(1);
    const sections = parseMemories(readMemoriesMd());
    expect(sections['Repeated mistakes']).toHaveLength(1);
    expect(sections['Repeated mistakes'][0].sessions_seen).toBe(1);
    expect(sections['Repeated mistakes'][0].confidence).toBeCloseTo(0.50);
  });

  it('applyMemoryUpdates reinforces an existing memory', () => {
    const candidate = {
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite arrays',
      trigger: ['settings.json'],
      correction: 'Merge arrays',
    };
    applyMemoryUpdates([candidate]);
    const count2 = applyMemoryUpdates([candidate]);
    expect(count2).toBe(0); // reinforced, not new
    const sections = parseMemories(readMemoriesMd());
    const m = sections['Repeated mistakes'][0];
    expect(m.seen).toBe(2);
    expect(m.sessions_seen).toBe(2);
    expect(m.confidence).toBeCloseTo(0.60);
  });

  it('applyMemoryUpdates skips tombstoned memories', () => {
    addMemoryTombstone('When editing settings, do not overwrite arrays');
    const count = applyMemoryUpdates([{
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite arrays',
      trigger: ['settings.json'],
      correction: 'Merge arrays',
    }]);
    expect(count).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
  });

  it('addMemoryTombstone and isMemoryTombstoned work correctly', () => {
    expect(isMemoryTombstoned('Some memory text')).toBe(false);
    addMemoryTombstone('Some memory text');
    expect(isMemoryTombstoned('Some memory text')).toBe(true);
    expect(isMemoryTombstoned('Some memory text.')).toBe(true); // trailing period
    const list = readMemoryTombstones();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});
