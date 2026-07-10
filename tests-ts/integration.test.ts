import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, readSignals, readHabitsMd, parseHabits,
  appendSignal, serialiseHabits, serialiseMemories, writeMemoriesMd,
  parseMemories, readMemoriesMd, readMemoryTombstones, getRuleHash,
} from '../src/storage';
import { installPaths } from '../src/install';
import { processPostToolUse, processStop, isNoise, redact } from '../src/hook';
import { cmdInit, cmdView, cmdReset, cmdMemories, cmdMemoriesDelete, cmdMemoriesTombstones, cmdUninstall } from '../src/cli';
import * as extractor from '../src/extractor';
import * as detect from '../src/detect';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
const origInstall = { ...installPaths };

let tmpDir: string;

const SESSION = 'test-session-abc';

const DIFFS = [
  { file: 'models.py', tool: 'Edit', old: 'def get_user(id):', nw: 'def get_user(id: int) -> dict:' },
  { file: 'utils.py', tool: 'Edit', old: "msg = 'Hello ' + name", nw: "msg = f'Hello {name}'" },
  { file: 'helpers.py', tool: 'Edit', old: "result = '{}'.format(value)", nw: "result = f'{value}'" },
  { file: 'api.py', tool: 'Edit', old: 'def fetch_data(url):', nw: 'def fetch_data(url: str) -> list[dict]:' },
  { file: 'report.py', tool: 'Edit', old: "output = 'Count: ' + str(n)", nw: "output = f'Count: {n}'" },
];

const FAKE_UPDATES = [
  { category: 'Python', rule: 'Use type hints on all function signatures', decision: 'create', matched_habit_id: '', reasoning: 'Observed in 2 of 5 signals.' },
  { category: 'Python', rule: 'Use f-strings instead of .format() or concatenation', decision: 'create', matched_habit_id: '', reasoning: 'Observed in 3 of 5 signals.' },
];

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
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.historyFile = path.join(tmpDir, '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, '.provenance.json');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  const claudeDir = path.join(tmpDir, 'dot_claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  installPaths.claudeDir = claudeDir;
  installPaths.settingsFile = path.join(claudeDir, 'settings.json');
  installPaths.claudeMd = path.join(claudeDir, 'CLAUDE.md');
  installPaths.habitsMdPath = storagePaths.habitsFile;
  installPaths.importLine = `@import ${storagePaths.habitsFile}`;
  initHabitsMd();
  initLog();
  vi.mocked(extractor.extractRules).mockResolvedValue([]);
  vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([]);
  vi.mocked(extractor.extractHabitsFromRepo).mockResolvedValue([]);
  vi.mocked(extractor.extractMemoriesFromDocs).mockResolvedValue([]);
  vi.spyOn(detect, 'isCliOnPath').mockReturnValue(false);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function writeSignals(sid = SESSION): Promise<void> {
  for (const d of DIFFS) {
    await processPostToolUse({ tool_name: d.tool, session_id: sid, tool_input: { file_path: d.file, old_string: d.old, new_string: d.nw } });
  }
}

// PostToolUse ──────────────────────────────────────────────────────────────
describe('PostToolUse hook', () => {
  it('Edit writes a signal', async () => {
    await processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'main.py', old_string: 'def foo(): pass', new_string: 'def foo() -> None: pass' } });
    const sigs = readSignals(SESSION);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].file).toBe('main.py');
    expect(sigs[0].diff).toContain('-def foo(): pass');
    expect(sigs[0].diff).toContain('+def foo() -> None: pass');
  });

  it('Write writes a signal', async () => {
    await processPostToolUse({ tool_name: 'Write', session_id: SESSION, tool_input: { file_path: 'new.py', content: "def hello() -> None:\n    print('hello')\n" } });
    expect(readSignals(SESSION)).toHaveLength(1);
    expect(readSignals(SESSION)[0].diff).toContain('+def hello() -> None:');
  });

  it('MultiEdit writes a signal', async () => {
    await processPostToolUse({ tool_name: 'MultiEdit', session_id: SESSION, tool_input: { file_path: 'app.py', edits: [{ old_string: 'x = 1', new_string: 'x: int = 1' }, { old_string: 'y = 2', new_string: 'y: int = 2' }] } });
    const sigs = readSignals(SESSION);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].diff).toContain('-x = 1');
    expect(sigs[0].diff).toContain('+x: int = 1');
  });

  it('non-write tools are ignored', async () => {
    for (const t of ['Bash', 'Read', 'WebFetch']) {
      await processPostToolUse({ tool_name: t, session_id: SESSION, tool_input: {} });
    }
    expect(readSignals(SESSION)).toHaveLength(0);
  });

  it('signals are isolated by session', async () => {
    await processPostToolUse({ tool_name: 'Edit', session_id: 'A', tool_input: { file_path: 'a.py', old_string: 'old code here', new_string: 'new code here' } });
    await processPostToolUse({ tool_name: 'Edit', session_id: 'B', tool_input: { file_path: 'b.py', old_string: 'old code here', new_string: 'new code here' } });
    expect(readSignals('A')).toHaveLength(1);
    expect(readSignals('B')).toHaveLength(1);
    expect(readSignals()).toHaveLength(2);
  });
});

// PHI redaction ────────────────────────────────────────────────────────────
describe('PHI redaction', () => {
  it('redacts email addresses', async () => {
    await processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'c.py', old_string: "EMAIL = 'admin@example.com'", new_string: 'EMAIL = get_email()' } });
    const diff = readSignals(SESSION)[0].diff;
    expect(diff).toContain('<REDACTED:email>');
    expect(diff).not.toContain('admin@example.com');
  });

  it('redacts Indian PAN numbers', async () => {
    await processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 't.py', old_string: "pan = 'ABCDE1234F'", new_string: 'pan = get_pan()' } });
    const diff = readSignals(SESSION)[0].diff;
    expect(diff).toContain('<REDACTED:pan>');
    expect(diff).not.toContain('ABCDE1234F');
  });

  it('extractor never receives raw PHI', async () => {
    await writeSignals();
    await processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'k.py', old_string: "pan = 'PQRST5678U'", new_string: 'pan = fetch_pan()' } });
    const captured: unknown[] = [];
    vi.mocked(extractor.extractRules).mockImplementationOnce(async (signals) => { captured.push(...signals); return []; });
    await processStop(SESSION);
    const allDiffs = (captured as Array<{ diff?: string }>).map(s => s.diff ?? '').join(' ');
    expect(allDiffs).not.toContain('PQRST5678U');
    expect(allDiffs).toContain('<REDACTED:pan>');
  });
});

// Noise gating ─────────────────────────────────────────────────────────────
describe('noise gating', () => {
  it('short diff is noise', async () => { expect(isNoise('+x')).toBe(true); });
  it('whitespace-only diff is noise', async () => { expect(isNoise('  \n+   \n-  ')).toBe(true); });
  it('comment-only python diff is noise', async () => { expect(isNoise('- # old comment line here\n+ # new comment line here')).toBe(true); });
  it('comment-only JS diff is noise', async () => { expect(isNoise('- // old JS comment\n+ // new JS comment text')).toBe(true); });
  it('real code is not noise', async () => { expect(isNoise('-def foo():\n+def foo() -> None:\n     pass')).toBe(false); });
  it('mixed comment + code is not noise', async () => { expect(isNoise('- # comment\n+ def foo() -> None: pass')).toBe(false); });
});

// Stop hook gating ─────────────────────────────────────────────────────────
describe('Stop hook gating', () => {
  it('skips with zero signals', async () => {
    expect(await processStop(SESSION)).toBeNull();
  });

  it('skips with two signals', async () => {
    for (const d of DIFFS.slice(0, 2)) {
      appendSignal({ ts: new Date().toISOString(), session_id: SESSION, type: 'edit', file: d.file, diff: `-${d.old}\n+${d.nw}` });
    }
    expect(await processStop(SESSION)).toBeNull();
  });

  it('skips when all signals are noise', async () => {
    for (let i = 0; i < 5; i++) {
      appendSignal({ ts: new Date().toISOString(), session_id: SESSION, type: 'edit', file: 'f.py', diff: '+x' });
    }
    expect(await processStop(SESSION)).toBeNull();
  });

  it('skips signals from other sessions', async () => {
    await writeSignals('other-session');
    expect(await processStop(SESSION)).toBeNull();
  });
});

// Stop hook full pipeline ──────────────────────────────────────────────────
describe('Stop hook pipeline', () => {
  it('creates habits.md with correct structure', async () => {
    await writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    const result = await processStop(SESSION);
    expect(result).not.toBeNull();
    expect(result!.newCount).toBe(2);
    expect(result!.updatedCount).toBe(0);
    const md = readHabitsMd();
    // Single-session habits go into the Learning section (A1: session gating).
    expect(md).toContain('## Learning');
    expect(md).toContain('[Python]');
    expect(md).toContain('Use type hints on all function signatures');
    expect(md).toContain('Confidence: 0.50');
  });

  it('new habits start at 0.50 confidence', async () => {
    await writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop(SESSION);
    const cats = parseHabits(readHabitsMd());
    for (const h of cats['Python'] ?? []) expect(h.confidence).toBe(0.50);
  });

  it('reinforces habit across sessions and graduates from learning', async () => {
    await writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');
    const after1 = parseHabits(readHabitsMd());
    expect(after1['Python']).toBeDefined();
    expect(after1['Python']![0].confidence).toBeCloseTo(0.50);
    expect(after1['Python']![0].sessions_seen).toBe(1);
    // After 1 session the habit lives in Learning section, not active.
    expect(readHabitsMd()).toContain('## Learning');

    await writeSignals('s2');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([{
      category: 'Python', rule: 'Use type hints on all function signatures',
      decision: 'reinforce', matched_habit_id: 'Use type hints on all function signatures', reasoning: '',
    }]);
    await processStop('s2');
    const after2 = parseHabits(readHabitsMd());
    expect(after2['Python']![0].confidence).toBeCloseTo(0.55);
    expect(after2['Python']![0].sessions_seen).toBe(2);
    // Now it should appear under the active ## Python section.
    expect(readHabitsMd()).toContain('## Python');
  });

  it('contradicts habit', async () => {
    await writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');

    await writeSignals('s2');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([{
      category: 'Python', rule: 'Use type hints on all function signatures',
      decision: 'contradict', matched_habit_id: 'Use type hints on all function signatures', reasoning: '',
    }]);
    await processStop('s2');
    const cats = parseHabits(readHabitsMd());
    expect(cats['Python']![0].confidence).toBeCloseTo(0.40);
  });

  it('prunes habit below threshold', async () => {
    await writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');

    const contradict = { category: 'Python', rule: 'Use type hints on all function signatures', decision: 'contradict', matched_habit_id: 'Use type hints on all function signatures', reasoning: '' };
    for (let i = 2; i <= 4; i++) {
      await writeSignals(`s${i}`);
      vi.mocked(extractor.extractRules).mockResolvedValueOnce([contradict]);
      await processStop(`s${i}`);
    }
    expect(readHabitsMd()).not.toContain('Use type hints on all function signatures');
  });

  it('round-trip: serialised habits parse back without loss', async () => {
    await writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop(SESSION);
    const md = readHabitsMd();
    const cats = parseHabits(md);
    const cats2 = parseHabits(serialiseHabits(cats));
    expect(Object.keys(cats).sort()).toEqual(Object.keys(cats2).sort());
    for (const cat of Object.keys(cats)) {
      expect(cats[cat].length).toBe(cats2[cat].length);
      for (let i = 0; i < cats[cat].length; i++) {
        expect(cats[cat][i].rule).toBe(cats2[cat][i].rule);
        expect(cats[cat][i].confidence).toBeCloseTo(cats2[cat][i].confidence);
      }
    }
  });

  it('no double-period when LLM returns rule with trailing period', async () => {
    await writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES.map(u => ({ ...u, rule: u.rule + '.' })));
    await processStop(SESSION);
    expect(readHabitsMd()).not.toContain('..');
  });
});

// CLI: init ───────────────────────────────────────────────────────────────
describe('CLI init', () => {
  it('creates storage files', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    expect(fs.existsSync(storagePaths.habitsFile)).toBe(true);
    expect(fs.existsSync(storagePaths.logFile)).toBe(true);
  });

  it('registers hooks in settings.json', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks['PostToolUse']).toBeDefined();
    expect(hooks['Stop']).toBeDefined();
    const postCmds = (hooks['PostToolUse'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    const stopCmds = (hooks['Stop'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes('post-tool-use') && c.includes('|| true'))).toBe(true);
    expect(stopCmds.some(c => c.includes('stop') && c.includes('|| true'))).toBe(true);
  });

  it('adds absolute @import to CLAUDE.md', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
    const importLines = claudeMd.split('\n').filter(ln => ln.startsWith('@import'));
    expect(importLines).toHaveLength(1);
    const importPath = importLines[0].replace('@import ', '').trim();
    // Absolute path, not a ~ shortcut. On Windows that is C:\..., not /..., so
    // assert via path.isAbsolute rather than a POSIX-only leading-slash check.
    expect(path.isAbsolute(importPath)).toBe(true);
    expect(importPath.startsWith('~')).toBe(false);
    expect(importLines[0]).toContain('habits.md');
  });

  it('is idempotent, running twice does not duplicate hooks', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    await cmdInit();
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    const postCmds = (hooks['PostToolUse'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    const dupes = postCmds.filter(c => c.includes('post-tool-use'));
    expect(dupes).toHaveLength(1);
    const claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
    expect(claudeMd.split('\n').filter(ln => ln.startsWith('@import'))).toHaveLength(1);
  });
});

// CLI: view ───────────────────────────────────────────────────────────────
describe('CLI view', () => {
  it('shows empty state', async () => {
    const ret = await cmdView();
    expect(ret).toBe(0);
  });

  it('shows confidence bar after learning habits', async () => {
    await writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop(SESSION);
    const ret = await cmdView();
    expect(ret).toBe(0);
  });

  it('shows recent signals', async () => {
    await writeSignals();
    const ret = await cmdView();
    expect(ret).toBe(0);
  });
});

// CLI: memories ───────────────────────────────────────────────────────────
describe('CLI memories', () => {
  it('shows empty memories state and creates memories.md', async () => {
    const ret = await cmdMemories();
    expect(ret).toBe(0);
    expect(fs.existsSync(storagePaths.memoriesFile)).toBe(true);
  });

  it('shows active and candidate memories', async () => {
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [
        {
          text: 'Preserve existing hook arrays when editing settings',
          trigger: ['settings.json', 'hooks'],
          correction: 'Merge arrays instead of overwriting them',
          confidence: 0.80,
          seen: 3,
          sessions_seen: 2,
          last_seen: '2026-05-28',
        },
        {
          text: 'Update parser tests when changing format fields',
          trigger: ['parser', 'format'],
          correction: 'Update parser, serializer, and spec together',
          confidence: 0.50,
          seen: 1,
          sessions_seen: 1,
        },
      ],
    }));
    expect(await cmdMemories()).toBe(0);
  });
});

// CLI: memories --delete ──────────────────────────────────────────────────
describe('CLI memories --delete', () => {
  it('deletes and tombstones a memory by text', async () => {
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [{
        text: 'When editing settings, do not overwrite arrays',
        trigger: ['settings.json'],
        correction: 'Merge arrays',
        confidence: 0.80,
        seen: 2,
        sessions_seen: 2,
      }],
    }));
    const ret = cmdMemoriesDelete('When editing settings, do not overwrite arrays');
    expect(ret).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
    expect(readMemoryTombstones().length).toBeGreaterThanOrEqual(1);
  });

  it('deletes and tombstones a memory by hash', async () => {
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [{
        text: 'When editing settings, do not overwrite arrays',
        trigger: ['settings.json'],
        correction: 'Merge arrays',
        confidence: 0.80,
        seen: 2,
        sessions_seen: 2,
      }],
    }));
    const hash = getRuleHash('When editing settings, do not overwrite arrays');
    const ret = cmdMemoriesDelete(hash);
    expect(ret).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
    expect(readMemoryTombstones().length).toBeGreaterThanOrEqual(1);
    expect(readMemoryTombstones()).toContain('when editing settings, do not overwrite arrays');
  });

  it('deletes by id even when the id is pasted with its surrounding brackets', async () => {
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [{
        text: 'When editing settings, do not overwrite arrays',
        trigger: ['settings.json'],
        correction: 'Merge arrays',
        confidence: 0.80,
        seen: 2,
        sessions_seen: 2,
      }],
    }));
    const hash = getRuleHash('When editing settings, do not overwrite arrays');
    const ret = cmdMemoriesDelete(`[${hash}]`);
    expect(ret).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
    expect(readMemoryTombstones()).toContain('when editing settings, do not overwrite arrays');
  });

  it('still tombstones even if memory text is not found', async () => {
    const ret = cmdMemoriesDelete('Nonexistent memory text');
    expect(ret).toBe(0);
    expect(readMemoryTombstones().length).toBeGreaterThanOrEqual(1);
  });

  it('strips " (candidate)" suffix when deleting', async () => {
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [{
        text: 'When editing settings, do not overwrite arrays',
        trigger: ['settings.json'],
        correction: 'Merge arrays',
        confidence: 0.50,
        seen: 1,
        sessions_seen: 1,
      }],
    }));
    const ret = cmdMemoriesDelete('When editing settings, do not overwrite arrays (candidate)');
    expect(ret).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
    expect(readMemoryTombstones().length).toBeGreaterThanOrEqual(1);
    expect(readMemoryTombstones()).toContain('when editing settings, do not overwrite arrays');
  });

  it('returns 1 when no text is provided', async () => {
    expect(cmdMemoriesDelete('')).toBe(1);
  });
});

describe('CLI memories --tombstones', () => {
  it('shows empty tombstones list', async () => {
    expect(cmdMemoriesTombstones()).toBe(0);
  });
});

// Stop hook: memory extraction ────────────────────────────────────────────
describe('Stop hook memory extraction', () => {
  afterEach(() => {
    delete process.env['CC_HABITS_MEMORIES'];
  });

  it('does not write memories when CC_HABITS_MEMORIES is off', async () => {
    process.env['CC_HABITS_MEMORIES'] = '0';
    await writeSignals();
    vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([{
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite arrays',
      trigger: ['settings.json'],
      correction: 'Merge arrays',
    }]);
    const result = await processStop(SESSION);
    expect(result).not.toBeNull();
    // extractMemoryCandidates should not be called when flag is off
    expect(extractor.extractMemoryCandidates).not.toHaveBeenCalled();
    expect(result!.memoryCandidatesCount).toBe(0);
  });

  it('extracts and writes memory candidates when CC_HABITS_MEMORIES=1', async () => {
    process.env['CC_HABITS_MEMORIES'] = '1';
    await writeSignals();
    vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([{
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite existing hook arrays',
      trigger: ['settings.json', 'hooks'],
      correction: 'Merge new hooks with existing hooks',
    }]);
    const result = await processStop(SESSION);
    expect(result).not.toBeNull();
    expect(extractor.extractMemoryCandidates).toHaveBeenCalled();
    expect(result!.memoryCandidatesCount).toBe(1);
    expect(fs.existsSync(storagePaths.memoriesFile)).toBe(true);
    const md = fs.readFileSync(storagePaths.memoriesFile, 'utf-8');
    expect(md).toContain('overwrite existing hook arrays');
  });

  it('reinforces an existing memory on a second session', async () => {
    process.env['CC_HABITS_MEMORIES'] = '1';
    const candidate = {
      section: 'Repeated mistakes',
      text: 'When editing settings, do not overwrite existing hook arrays',
      trigger: ['settings.json'],
      correction: 'Merge arrays',
    };
    // First session
    await writeSignals();
    vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([candidate]);
    await processStop(SESSION);
    // Second session with same mistake
    vi.mocked(extractor.extractMemoryCandidates).mockResolvedValue([candidate]);
    await writeSignals('session-2');
    const result2 = await processStop('session-2');
    expect(result2!.memoryCandidatesCount).toBe(0); // reinforced, not new
    const { parseMemories, readMemoriesMd } = await import('../src/storage');
    const sections = parseMemories(readMemoriesMd());
    const mem = sections['Repeated mistakes']?.[0];
    expect(mem?.seen).toBe(2);
    expect(mem?.sessions_seen).toBe(2);
    expect(mem?.confidence).toBeCloseTo(0.60);
  });

  it('handles extractor failure gracefully without crashing stop', async () => {
    process.env['CC_HABITS_MEMORIES'] = '1';
    await writeSignals();
    vi.mocked(extractor.extractMemoryCandidates).mockRejectedValue(new Error('provider down'));
    const result = await processStop(SESSION);
    expect(result).not.toBeNull(); // habits still extracted normally
    expect(result!.memoryCandidatesCount).toBe(0);
  });
});

// CLI: reset ──────────────────────────────────────────────────────────────
describe('CLI reset', () => {
  it('requires --yes flag', async () => { expect(cmdReset(false)).toBe(1); });
  it('deletes habits and log files', async () => {
    await writeSignals();
    writeMemoriesMd(serialiseMemories({
      'Repeated mistakes': [{
        text: 'Preserve settings arrays',
        trigger: ['settings'],
        confidence: 0.80,
        seen: 2,
        sessions_seen: 2,
      }],
    }));
    expect(cmdReset(true)).toBe(0);
    expect(fs.existsSync(storagePaths.logFile)).toBe(false);
    expect(fs.existsSync(storagePaths.habitsFile)).toBe(false);
    expect(fs.existsSync(storagePaths.memoriesFile)).toBe(false);
  });
  it('is idempotent, no error if already deleted', async () => { expect(cmdReset(true)).toBe(0); });
});

// Three uncovered scenarios ────────────────────────────────────────────────
describe('Scenario 1: nvm PATH, hook command uses absolute binary path', () => {
  it('registered command is resolvable and contains the binary name', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    const postCmds = (hooks['PostToolUse'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes('cc-habits-hook'))).toBe(true);
    expect(postCmds.some(c => c.endsWith('|| true'))).toBe(true);
  });
});

describe('Scenario 2: malformed settings.json', () => {
  it('init succeeds and overwrites malformed settings.json', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    fs.writeFileSync(installPaths.settingsFile, '{ /* comment */ "hooks": {} }', 'utf-8');
    await expect(cmdInit()).resolves.toBe(0);
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    expect(settings['hooks']).toBeDefined();
  });
});

describe('Scenario 3: large diff capping', () => {
  it('diffs larger than 4KB are truncated before being logged', async () => {
    const bigContent = 'x'.repeat(10000);
    await processPostToolUse({ tool_name: 'Write', session_id: SESSION, tool_input: { file_path: 'big.py', content: bigContent } });
    const sig = readSignals(SESSION)[0];
    expect(sig.diff.length).toBeLessThan(5000);
    expect(sig.diff).toContain('(truncated)');
  });
});

describe('CLI uninstall', () => {
  it('cleans up hooks, imports, and deletes storage directory', async () => {
    const siblingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-claude-'));
    const origClaudeDir = installPaths.claudeDir;
    const origSettingsFile = installPaths.settingsFile;
    const origClaudeMd = installPaths.claudeMd;

    installPaths.claudeDir = siblingDir;
    installPaths.settingsFile = path.join(siblingDir, 'settings.json');
    installPaths.claudeMd = path.join(siblingDir, 'CLAUDE.md');

    try {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      await cmdInit();
      
      // Assert settings have hooks
      let settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8'));
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse.length).toBeGreaterThan(0);
      
      // Assert CLAUDE.md has @import
      let claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
      expect(claudeMd).toContain('@import');
      
      // Run uninstall
      const code = await cmdUninstall(true);
      expect(code).toBe(0);
      
      // settings.json should have hooks cleaned
      settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8'));
      const postCmds = (settings.hooks.PostToolUse || []).flatMap((e: any) => (e.hooks || []).map((h: any) => h.command));
      expect(postCmds.some((c: string) => c.includes('cc-habits-hook'))).toBe(false);
      
      // CLAUDE.md should not exist or not have import
      if (fs.existsSync(installPaths.claudeMd)) {
        claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
        expect(claudeMd).not.toContain('@import');
      }
      
      // Storage directory should be deleted
      expect(fs.existsSync(storagePaths.habitsFile)).toBe(false);
      expect(fs.existsSync(storagePaths.logFile)).toBe(false);
    } finally {
      installPaths.claudeDir = origClaudeDir;
      installPaths.settingsFile = origSettingsFile;
      installPaths.claudeMd = origClaudeMd;
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });
});
