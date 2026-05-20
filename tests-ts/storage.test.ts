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
  readHabitsMd,
  writeHabitsMd,
  parseHabits,
  serialiseHabits,
} from '../src/storage';

// Save originals once
const origPaths = { ...storagePaths };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-test-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.pendingFile = path.join(tmpDir, '.pending.json');
  initHabitsMd();
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
});
