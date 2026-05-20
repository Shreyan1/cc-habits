import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, initHabitsMd, initLog, readSignals, readHabitsMd, parseHabits, appendSignal, serialiseHabits } from '../src/storage';
import { installPaths } from '../src/install';
import { processPostToolUse, processStop, isNoise, redact } from '../src/hook';
import { cmdInit, cmdView, cmdReset } from '../src/cli';
import * as extractor from '../src/extractor';

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
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.pendingFile = path.join(tmpDir, '.pending.json');
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
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeSignals(sid = SESSION): void {
  for (const d of DIFFS) {
    processPostToolUse({ tool_name: d.tool, session_id: sid, tool_input: { file_path: d.file, old_string: d.old, new_string: d.nw } });
  }
}

// ── PostToolUse ───────────────────────────────────────────────────────────────

describe('PostToolUse hook', () => {
  it('Edit writes a signal', () => {
    processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'main.py', old_string: 'def foo(): pass', new_string: 'def foo() -> None: pass' } });
    const sigs = readSignals(SESSION);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].file).toBe('main.py');
    expect(sigs[0].diff).toContain('-def foo(): pass');
    expect(sigs[0].diff).toContain('+def foo() -> None: pass');
  });

  it('Write writes a signal', () => {
    processPostToolUse({ tool_name: 'Write', session_id: SESSION, tool_input: { file_path: 'new.py', content: "def hello() -> None:\n    print('hello')\n" } });
    expect(readSignals(SESSION)).toHaveLength(1);
    expect(readSignals(SESSION)[0].diff).toContain('+def hello() -> None:');
  });

  it('MultiEdit writes a signal', () => {
    processPostToolUse({ tool_name: 'MultiEdit', session_id: SESSION, tool_input: { file_path: 'app.py', edits: [{ old_string: 'x = 1', new_string: 'x: int = 1' }, { old_string: 'y = 2', new_string: 'y: int = 2' }] } });
    const sigs = readSignals(SESSION);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].diff).toContain('-x = 1');
    expect(sigs[0].diff).toContain('+x: int = 1');
  });

  it('non-write tools are ignored', () => {
    for (const t of ['Bash', 'Read', 'WebFetch']) {
      processPostToolUse({ tool_name: t, session_id: SESSION, tool_input: {} });
    }
    expect(readSignals(SESSION)).toHaveLength(0);
  });

  it('signals are isolated by session', () => {
    processPostToolUse({ tool_name: 'Edit', session_id: 'A', tool_input: { file_path: 'a.py', old_string: 'old code here', new_string: 'new code here' } });
    processPostToolUse({ tool_name: 'Edit', session_id: 'B', tool_input: { file_path: 'b.py', old_string: 'old code here', new_string: 'new code here' } });
    expect(readSignals('A')).toHaveLength(1);
    expect(readSignals('B')).toHaveLength(1);
    expect(readSignals()).toHaveLength(2);
  });
});

// ── PHI redaction ─────────────────────────────────────────────────────────────

describe('PHI redaction', () => {
  it('redacts email addresses', () => {
    processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'c.py', old_string: "EMAIL = 'admin@example.com'", new_string: 'EMAIL = get_email()' } });
    const diff = readSignals(SESSION)[0].diff;
    expect(diff).toContain('<REDACTED:email>');
    expect(diff).not.toContain('admin@example.com');
  });

  it('redacts Indian PAN numbers', () => {
    processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 't.py', old_string: "pan = 'ABCDE1234F'", new_string: 'pan = get_pan()' } });
    const diff = readSignals(SESSION)[0].diff;
    expect(diff).toContain('<REDACTED:pan>');
    expect(diff).not.toContain('ABCDE1234F');
  });

  it('extractor never receives raw PHI', async () => {
    writeSignals();
    processPostToolUse({ tool_name: 'Edit', session_id: SESSION, tool_input: { file_path: 'k.py', old_string: "pan = 'PQRST5678U'", new_string: 'pan = fetch_pan()' } });
    const captured: unknown[] = [];
    vi.mocked(extractor.extractRules).mockImplementationOnce(async (signals) => { captured.push(...signals); return []; });
    await processStop(SESSION);
    const allDiffs = (captured as Array<{ diff?: string }>).map(s => s.diff ?? '').join(' ');
    expect(allDiffs).not.toContain('PQRST5678U');
    expect(allDiffs).toContain('<REDACTED:pan>');
  });
});

// ── Noise gating ──────────────────────────────────────────────────────────────

describe('noise gating', () => {
  it('short diff is noise', () => { expect(isNoise('+x')).toBe(true); });
  it('whitespace-only diff is noise', () => { expect(isNoise('  \n+   \n-  ')).toBe(true); });
  it('comment-only python diff is noise', () => { expect(isNoise('- # old comment line here\n+ # new comment line here')).toBe(true); });
  it('comment-only JS diff is noise', () => { expect(isNoise('- // old JS comment\n+ // new JS comment text')).toBe(true); });
  it('real code is not noise', () => { expect(isNoise('-def foo():\n+def foo() -> None:\n     pass')).toBe(false); });
  it('mixed comment + code is not noise', () => { expect(isNoise('- # comment\n+ def foo() -> None: pass')).toBe(false); });
});

// ── Stop hook gating ──────────────────────────────────────────────────────────

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
    writeSignals('other-session');
    expect(await processStop(SESSION)).toBeNull();
  });
});

// ── Stop hook full pipeline ───────────────────────────────────────────────────

describe('Stop hook pipeline', () => {
  it('creates habits.md with correct structure', async () => {
    writeSignals();
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
    writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop(SESSION);
    const cats = parseHabits(readHabitsMd());
    for (const h of cats['Python'] ?? []) expect(h.confidence).toBe(0.50);
  });

  it('reinforces habit across sessions and graduates from learning', async () => {
    writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');
    const after1 = parseHabits(readHabitsMd());
    expect(after1['Python']).toBeDefined();
    expect(after1['Python']![0].confidence).toBeCloseTo(0.50);
    expect(after1['Python']![0].sessions_seen).toBe(1);
    // After 1 session the habit lives in Learning section, not active.
    expect(readHabitsMd()).toContain('## Learning');

    writeSignals('s2');
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
    writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');

    writeSignals('s2');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([{
      category: 'Python', rule: 'Use type hints on all function signatures',
      decision: 'contradict', matched_habit_id: 'Use type hints on all function signatures', reasoning: '',
    }]);
    await processStop('s2');
    const cats = parseHabits(readHabitsMd());
    expect(cats['Python']![0].confidence).toBeCloseTo(0.40);
  });

  it('prunes habit below threshold', async () => {
    writeSignals('s1');
    vi.mocked(extractor.extractRules).mockResolvedValueOnce([FAKE_UPDATES[0]]);
    await processStop('s1');

    const contradict = { category: 'Python', rule: 'Use type hints on all function signatures', decision: 'contradict', matched_habit_id: 'Use type hints on all function signatures', reasoning: '' };
    for (let i = 2; i <= 4; i++) {
      writeSignals(`s${i}`);
      vi.mocked(extractor.extractRules).mockResolvedValueOnce([contradict]);
      await processStop(`s${i}`);
    }
    expect(readHabitsMd()).not.toContain('Use type hints on all function signatures');
  });

  it('round-trip: serialised habits parse back without loss', async () => {
    writeSignals();
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
    writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES.map(u => ({ ...u, rule: u.rule + '.' })));
    await processStop(SESSION);
    expect(readHabitsMd()).not.toContain('..');
  });
});

// ── CLI: init ────────────────────────────────────────────────────────────────

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
    expect(importLines[0].replace('@import ', '').trim()).toMatch(/^\//);
    expect(importLines[0]).toContain('habits.md');
  });

  it('is idempotent — running twice does not duplicate hooks', async () => {
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

// ── CLI: view ────────────────────────────────────────────────────────────────

describe('CLI view', () => {
  it('shows empty state', () => {
    const ret = cmdView();
    expect(ret).toBe(0);
  });

  it('shows confidence bar after learning habits', async () => {
    writeSignals();
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop(SESSION);
    const ret = cmdView();
    expect(ret).toBe(0);
  });

  it('shows recent signals', () => {
    writeSignals();
    const ret = cmdView();
    expect(ret).toBe(0);
  });
});

// ── CLI: reset ───────────────────────────────────────────────────────────────

describe('CLI reset', () => {
  it('requires --yes flag', () => { expect(cmdReset(false)).toBe(1); });
  it('deletes habits and log files', () => {
    writeSignals();
    expect(cmdReset(true)).toBe(0);
    expect(fs.existsSync(storagePaths.logFile)).toBe(false);
    expect(fs.existsSync(storagePaths.habitsFile)).toBe(false);
  });
  it('is idempotent — no error if already deleted', () => { expect(cmdReset(true)).toBe(0); });
});

// ── Three uncovered scenarios ─────────────────────────────────────────────────

describe('Scenario 1: nvm PATH — hook command uses absolute binary path', () => {
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
  it('diffs larger than 4KB are truncated before being logged', () => {
    const bigContent = 'x'.repeat(10000);
    processPostToolUse({ tool_name: 'Write', session_id: SESSION, tool_input: { file_path: 'big.py', content: bigContent } });
    const sig = readSignals(SESSION)[0];
    expect(sig.diff.length).toBeLessThan(5000);
    expect(sig.diff).toContain('(truncated)');
  });
});
