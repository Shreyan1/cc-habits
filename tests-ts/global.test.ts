import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, initHabitsMd, initLog, readSignals, readHabitsMd } from '../src/storage';
import { installPaths } from '../src/install';
import { processPostToolUse, processStop } from '../src/hook';
import { cmdInit } from '../src/cli';
import * as extractor from '../src/extractor';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
const origInstall = { ...installPaths };

let tmpDir: string;

const FAKE_UPDATES = [{
  category: 'Python',
  rule: 'Use type hints on all function signatures',
  decision: 'create',
  matched_habit_id: '',
  reasoning: 'Observed across multiple signals.',
}];

function makeEdit(file: string, old: string, nw: string, session: string): void {
  processPostToolUse({ tool_name: 'Edit', session_id: session, tool_input: { file_path: file, old_string: old, new_string: nw } });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-global-'));
  storagePaths.habitsDir = path.join(tmpDir, 'habits');
  storagePaths.habitsFile = path.join(tmpDir, 'habits', 'habits.md');
  storagePaths.logFile = path.join(tmpDir, 'habits', 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'habits', 'error.log');
  storagePaths.tombstonesFile = path.join(tmpDir, 'habits', '.tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, 'habits', '.snapshot.json');
  storagePaths.pendingFile = path.join(tmpDir, 'habits', '.pending.json');
  storagePaths.historyFile = path.join(tmpDir, 'habits', '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, 'habits', '.provenance.json');
  storagePaths.configFile = path.join(tmpDir, 'habits', 'config.yml');
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
  vi.mocked(extractor.extractHabitsFromRepo).mockResolvedValue([]);
  vi.mocked(extractor.extractMemoriesFromDocs).mockResolvedValue([]);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('Cross-project signal accumulation', () => {
  it('signals from two projects go to the same log', () => {
    makeEdit('~/project-a/models.py', 'def foo():', 'def foo() -> None:', 'session-proj-a');
    makeEdit('~/project-a/utils.py', 'x = 1', 'x: int = 1', 'session-proj-a');
    makeEdit('~/project-b/api.py', 'def bar():', 'def bar() -> str:', 'session-proj-b');
    makeEdit('~/project-b/views.py', 'y = 2', 'y: int = 2', 'session-proj-b');

    const all = readSignals();
    expect(all).toHaveLength(4);
    expect(readSignals('session-proj-a')).toHaveLength(2);
    expect(readSignals('session-proj-b')).toHaveLength(2);

    const files = new Set(all.map(s => s.file));
    expect(files.has('~/project-a/models.py')).toBe(true);
    expect(files.has('~/project-b/api.py')).toBe(true);
  });

  it('habits from project A are visible when project B session fires', async () => {
    for (const fp of ['a/m.py', 'a/u.py', 'a/h.py']) {
      makeEdit(fp, 'def f():', 'def f() -> None:', 'session-a');
    }
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop('session-a');
    expect(readHabitsMd()).toContain('Use type hints on all function signatures');

    const captured: unknown[] = [];
    vi.mocked(extractor.extractRules).mockImplementationOnce(async (_signals, habitsMd) => {
      captured.push(habitsMd);
      return [];
    });
    for (const fp of ['b/m.py', 'b/u.py', 'b/h.py']) {
      makeEdit(fp, 'def g():', 'def g() -> str:', 'session-b');
    }
    await processStop('session-b');
    expect(captured).toHaveLength(1);
    expect(captured[0] as string).toContain('Use type hints on all function signatures');
  });

  it('confidence accumulates across 5 projects: 0.50 → 0.70', async () => {
    for (const fp of ['p1/a.py', 'p1/b.py', 'p1/c.py']) {
      makeEdit(fp, 'def f():', 'def f() -> None:', 's1');
    }
    vi.mocked(extractor.extractRules).mockResolvedValueOnce(FAKE_UPDATES);
    await processStop('s1');

    const reinforce = [{ category: 'Python', rule: 'Use type hints on all function signatures', decision: 'reinforce', matched_habit_id: 'Use type hints on all function signatures', reasoning: '' }];
    for (let i = 2; i <= 5; i++) {
      for (const fp of [`p${i}/a.py`, `p${i}/b.py`, `p${i}/c.py`]) {
        makeEdit(fp, 'def f():', 'def f() -> None:', `s${i}`);
      }
      vi.mocked(extractor.extractRules).mockResolvedValueOnce(reinforce);
      await processStop(`s${i}`);
    }

    const { parseHabits } = await import('../src/storage');
    const cats = parseHabits(readHabitsMd());
    const conf = cats['Python']![0].confidence;
    expect(conf).toBeCloseTo(0.70); // 0.50 + 4 * 0.05
    expect(cats['Python']![0].reinforcing).toBe(5);
  });
});

describe('Global install: hooks in user-level settings.json', () => {
  it('hooks are registered in user-level settings file', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    expect(fs.existsSync(installPaths.settingsFile)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown>;
    expect(hooks['PostToolUse']).toBeDefined();
    expect(hooks['Stop']).toBeDefined();
  });

  it('PostToolUse hook has correct command with || true', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown>;
    const postCmds = (hooks['PostToolUse'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    const stopCmds = (hooks['Stop'] as Array<{ hooks: Array<{ command: string }> }>).flatMap(e => e.hooks.map(h => h.command));
    expect(postCmds.some(c => c.includes('post-tool-use') && c.includes('|| true'))).toBe(true);
    expect(stopCmds.some(c => c.includes('stop') && c.includes('|| true'))).toBe(true);
  });

  it('PostToolUse hook matcher covers Write|Edit|MultiEdit', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown>;
    const matchers = (hooks['PostToolUse'] as Array<{ matcher?: string }>).map(e => e.matcher ?? '');
    expect(matchers.some(m => m.includes('Write') && m.includes('Edit'))).toBe(true);
  });
});

describe('Signal cap: long sessions do not hit provider 413', () => {
  it('passes at most 50 signals to extractRules when session has more', async () => {
    // Write 60 substantive signals for the same session.
    for (let i = 0; i < 60; i++) {
      makeEdit(`file${i}.ts`, `const old${i} = 'x'.repeat(30)`, `const new${i} = 'y'.repeat(30)`, 'session-big');
    }
    const captured: unknown[][] = [];
    vi.mocked(extractor.extractRules).mockImplementationOnce(async (signals) => {
      captured.push(signals as unknown[]);
      return [];
    });
    await processStop('session-big');
    expect(captured).toHaveLength(1);
    expect((captured[0] as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it('uses the most recent signals when capping', async () => {
    for (let i = 0; i < 55; i++) {
      makeEdit(`file${i}.ts`, `const old${i} = 'x'.repeat(30)`, `const new${i} = 'y'.repeat(30)`, 'session-recent');
    }
    const captured: unknown[][] = [];
    vi.mocked(extractor.extractRules).mockImplementationOnce(async (signals) => {
      captured.push(signals as unknown[]);
      return [];
    });
    await processStop('session-recent');
    const files = (captured[0] as Array<{ file: string }>).map(s => s.file);
    // The most recent 50 signals correspond to files 5-54.
    expect(files).toContain('file54.ts');
    expect(files).not.toContain('file4.ts');
  });
});

describe('@import uses absolute path', () => {
  it('import line is absolute, not a ~ shortcut', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
    const importLines = claudeMd.split('\n').filter(ln => ln.startsWith('@import'));
    expect(importLines).toHaveLength(1);
    const importPath = importLines[0].replace('@import ', '').trim();
    // On Windows an absolute path is C:\..., not /..., so use path.isAbsolute.
    expect(path.isAbsolute(importPath)).toBe(true);
    expect(importPath.startsWith('~')).toBe(false);
    expect(importPath).toContain('habits.md');
  });

  it('@import path resolves to the same file Stop hook writes', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    const claudeMd = fs.readFileSync(installPaths.claudeMd, 'utf-8');
    const importPath = claudeMd.split('\n').filter(ln => ln.startsWith('@import'))[0].replace('@import ', '').trim();
    expect(importPath).toBe(storagePaths.habitsFile);
  });

  it('@import is in user-level CLAUDE.md, not a project file', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await cmdInit();
    expect(path.dirname(installPaths.claudeMd)).toBe(installPaths.claudeDir);
    expect(path.basename(installPaths.claudeMd)).toBe('CLAUDE.md');
    expect(fs.readFileSync(installPaths.claudeMd, 'utf-8').split('@import')).toHaveLength(2);
  });
});
