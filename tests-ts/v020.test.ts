/**
 * Tests for v0.2.0 features.
 *
 *   B1  diff: shows added/removed/changed habits between history snapshots
 *   B2  explain: finds a habit and renders its provenance
 *   B3  lint: structural plumbing (LLM call is mocked)
 *   C2  configurable habitsDir via CC_HABITS_DIR
 *   C3  provider abstraction: anthropic default, env-var override
 *   C4  export/import round-trip
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, readHabitsMd, parseHabits,
  appendHistory, readHistory, appendProvenance, readProvenance, lookupProvenance,
  writeHabitsMd, serialiseHabits,
} from '../src/storage';
import { computeDiff } from '../src/diff';
import { explainHabit } from '../src/explain';
import { exportHabits, importHabits } from '../src/portable';
import { processPostToolUse, processStop } from '../src/hook';
import * as extractor from '../src/extractor';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-v020-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.pendingFile = path.join(tmpDir, '.pending.json');
  storagePaths.historyFile = path.join(tmpDir, '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, '.provenance.json');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  initHabitsMd();
  initLog();
  vi.mocked(extractor.extractRules).mockResolvedValue([]);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  delete process.env['CC_HABITS_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// B1: diff ─────────────────────────────────────────────────────────────────
describe('B1: cc-habits diff', () => {
  it('returns null with fewer than 2 history entries', () => {
    appendHistory({ ts: '2026-05-19T10:00:00Z', habits_md: '# h' });
    expect(computeDiff()).toBeNull();
  });

  it('detects added habits between two snapshots', () => {
    const before = serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    });
    const after = serialiseHabits({
      TS: [
        { rule: 'Use strict mode', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 },
        { rule: 'Prefer const over let', confidence: 0.55, reinforcing: 1, contradicting: 0, sessions_seen: 2 },
      ],
    });
    appendHistory({ ts: '2026-05-19T10:00:00Z', habits_md: before });
    appendHistory({ ts: '2026-05-19T11:00:00Z', habits_md: after });

    const d = computeDiff()!;
    expect(d.added).toHaveLength(1);
    expect(d.added[0].habit.rule).toBe('Prefer const over let');
    expect(d.removed).toHaveLength(0);
  });

  it('detects confidence changes', () => {
    const before = serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.70, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    });
    const after = serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.80, reinforcing: 5, contradicting: 0, sessions_seen: 4 }],
    });
    appendHistory({ ts: '2026-05-19T10:00:00Z', habits_md: before });
    appendHistory({ ts: '2026-05-19T11:00:00Z', habits_md: after });

    const d = computeDiff()!;
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].from).toBeCloseTo(0.70);
    expect(d.changed[0].to).toBeCloseTo(0.80);
  });

  it('detects removed habits', () => {
    const before = serialiseHabits({
      TS: [
        { rule: 'Use strict mode', confidence: 0.70, reinforcing: 3, contradicting: 0, sessions_seen: 3 },
        { rule: 'Prefer const', confidence: 0.55, reinforcing: 1, contradicting: 0, sessions_seen: 2 },
      ],
    });
    const after = serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.70, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    });
    appendHistory({ ts: '2026-05-19T10:00:00Z', habits_md: before });
    appendHistory({ ts: '2026-05-19T11:00:00Z', habits_md: after });

    const d = computeDiff()!;
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].habit.rule).toBe('Prefer const');
  });

  it('processStop writes a history entry', async () => {
    for (const d of [
      { file: 'a.ts', old: 'const x = 1 here', nw: 'const x: number = 1' },
      { file: 'b.ts', old: 'const y = 2 here', nw: 'const y: number = 2' },
      { file: 'c.ts', old: 'const z = 3 here', nw: 'const z: number = 3' },
    ]) {
      processPostToolUse({ tool_name: 'Edit', session_id: 's1', tool_input: { file_path: d.file, old_string: d.old, new_string: d.nw } });
    }
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([
      { category: 'TS', rule: 'Use explicit number types', decision: 'create', matched_habit_id: '', reasoning: '' },
    ]);
    await processStop('s1');
    expect(readHistory()).toHaveLength(1);
    expect(readHistory()[0].habits_md).toContain('Use explicit number types');
  });
});

// B2: explain ──────────────────────────────────────────────────────────────
describe('B2: cc-habits explain', () => {
  it('returns null for a habit that does not exist', () => {
    expect(explainHabit('completely fictional rule')).toBeNull();
  });

  it('finds a habit by exact rule text', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    }));
    const exp = explainHabit('Use strict mode')!;
    expect(exp.rule).toBe('Use strict mode');
    expect(exp.category).toBe('TS');
  });

  it('finds a habit by substring (fuzzy)', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'Use strict mode for new files', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    }));
    const exp = explainHabit('strict mode')!;
    expect(exp.rule).toContain('strict mode');
  });

  it('returns provenance refs recorded during Stop', async () => {
    appendProvenance('Use type hints', [
      { ts: '2026-05-19T10:00:00Z', session_id: 's1', file: 'a.py', snippet: '-def f():\n+def f() -> None:', decision: 'create' },
    ]);
    writeHabitsMd(serialiseHabits({
      Python: [{ rule: 'Use type hints', confidence: 0.6, reinforcing: 2, contradicting: 0, sessions_seen: 2 }],
    }));
    const exp = explainHabit('type hints')!;
    expect(exp.refs).toHaveLength(1);
    expect(exp.refs[0].file).toBe('a.py');
  });

  it('lookupProvenance is case- and period-insensitive', () => {
    appendProvenance('Use type hints', [
      { ts: 't', session_id: 's', file: 'a.py', snippet: '', decision: 'create' },
    ]);
    expect(lookupProvenance('Use type hints.')).toHaveLength(1);
    expect(lookupProvenance('USE TYPE HINTS')).toHaveLength(1);
  });
});

// C2: configurable habitsDir ──────────────────────────────────────────────
describe('C2: CC_HABITS_DIR override', () => {
  it('storagePaths derive from CC_HABITS_DIR when set', async () => {
    process.env['CC_HABITS_DIR'] = '/tmp/custom-cc-habits';
    // Re-import the module to pick up the env var.
    vi.resetModules();
    const fresh = await import('../src/storage');
    expect(fresh.storagePaths.habitsFile).toBe('/tmp/custom-cc-habits/habits.md');
    expect(fresh.storagePaths.logFile).toBe('/tmp/custom-cc-habits/log.jsonl');
    expect(fresh.storagePaths.historyFile).toBe('/tmp/custom-cc-habits/.history.jsonl');
    delete process.env['CC_HABITS_DIR'];
    vi.resetModules();
  });
});

// C3: provider abstraction ────────────────────────────────────────────────
describe('C3: provider selection', () => {
  it('CC_HABITS_PROVIDER=ollama selects the Ollama provider', async () => {
    process.env['CC_HABITS_PROVIDER'] = 'ollama';
    const { selectProvider } = await import('../src/providers');
    const provider = selectProvider();
    expect(provider.name).toBe('ollama');
    delete process.env['CC_HABITS_PROVIDER'];
  });

  it('CC_HABITS_PROVIDER=openai requires OPENAI_API_KEY', async () => {
    process.env['CC_HABITS_PROVIDER'] = 'openai';
    delete process.env['OPENAI_API_KEY'];
    const { selectProvider } = await import('../src/providers');
    expect(() => selectProvider()).toThrow(/OPENAI_API_KEY/);
    delete process.env['CC_HABITS_PROVIDER'];
  });

  it('default is anthropic when no env override and ANTHROPIC_API_KEY is set', async () => {
    delete process.env['CC_HABITS_PROVIDER'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const { selectProvider } = await import('../src/providers');
    const provider = selectProvider();
    expect(provider.name).toBe('anthropic');
  });
});

// C4: export / import ─────────────────────────────────────────────────────
describe('C4: export and import', () => {
  it('export returns the current habits.md content', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    }));
    const md = exportHabits();
    expect(md).toContain('## TS');
    expect(md).toContain('Use strict mode');
  });

  it('export to a path writes a 0600 file', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'X', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    }));
    const outPath = path.join(tmpDir, 'exported.md');
    exportHabits(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.statSync(outPath).mode & 0o777).toBe(0o600);
  });

  it('import merges new rules', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'Local rule', confidence: 0.7, reinforcing: 3, contradicting: 0, sessions_seen: 3 }],
    }));
    const incoming = serialiseHabits({
      TS: [{ rule: 'Incoming rule', confidence: 0.8, reinforcing: 5, contradicting: 0, sessions_seen: 4 }],
    });
    const result = importHabits(incoming);
    expect(result.added).toBe(1);
    const md = readHabitsMd();
    expect(md).toContain('Local rule');
    expect(md).toContain('Incoming rule');
  });

  it('import merges existing rules taking max confidence and summed signals', () => {
    writeHabitsMd(serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.60, reinforcing: 3, contradicting: 0, sessions_seen: 2 }],
    }));
    const incoming = serialiseHabits({
      TS: [{ rule: 'Use strict mode', confidence: 0.80, reinforcing: 5, contradicting: 1, sessions_seen: 4 }],
    });
    const result = importHabits(incoming);
    expect(result.merged).toBe(1);
    expect(result.added).toBe(0);
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0].confidence).toBeCloseTo(0.80);
    expect(cats['TS']![0].reinforcing).toBe(8); // 3 + 5
    expect(cats['TS']![0].sessions_seen).toBe(4);
  });
});
