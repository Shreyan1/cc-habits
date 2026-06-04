import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, initHabitsMd, initLog, readHabitsMd, readSignals, writeHabitsMd, serialiseHabits, readHistory, writePending, type PendingUpdate } from '../src/storage';
import { runMigration } from '../src/migrate';
import { captureFromCli } from '../src/capture';
import { runGitCapture, shouldTriggerGitLearn } from '../src/git-collector';
import { cmdLearn, cmdShellInit, cmdSessionBanner, cmdTools } from '../src/cli';
import { processSessionStart } from '../src/hook';
import { registerJsonHooks, registerKimiHooks } from '../src/install';
import { normalizeInput, ALLOWED_ADAPTERS } from '../src/adapters';
import { SUPPORTED_TOOLS, HOOK_ADAPTERS } from '../src/supported';
import { nextIndex, renderMenu, MENU_ITEMS } from '../src/menu';
import * as extractor from '../src/extractor';
import * as detect from '../src/detect';

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
  vi.spyOn(detect, 'isCliOnPath').mockReturnValue(false);
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

const makePending = (n: number): PendingUpdate[] =>
  Array.from({ length: n }, (_, i) => ({
    category: 'style',
    rule: `rule number ${i + 1}`,
    decision: 'create',
    ts: new Date().toISOString(),
  }));

describe('v0.4.0: processSessionStart (auto-prompt pending reminder)', () => {
  it('returns null when there are no pending suggestions', () => {
    expect(processSessionStart()).toBeNull();
  });

  it('summarizes pending suggestions when present', () => {
    writePending(makePending(2));
    const out = processSessionStart();
    expect(out).toContain('2 pending habit suggestions');
    expect(out).toContain('rule number 1');
    expect(out).toContain('cch pending');
  });

  it('caps the list at 5 and notes how many more remain', () => {
    writePending(makePending(8));
    const out = processSessionStart() ?? '';
    expect(out).toContain('8 pending');
    expect(out).toContain('...and 3 more');
    expect(out).toContain('rule number 5');
    expect(out).not.toContain('rule number 6');
  });
});

describe('v0.4.0: cmdSessionBanner', () => {
  it('stays silent and exits 0 when nothing is pending', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = cmdSessionBanner();
    expect(code).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes a banner to stderr when suggestions are pending', () => {
    writePending(makePending(1));
    let captured = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      captured += String(chunk);
      return true;
    });
    const code = cmdSessionBanner();
    expect(code).toBe(0);
    expect(captured).toContain('1 pending habit suggestion');
    expect(captured).toContain('cch pending');
    spy.mockRestore();
  });
});

describe('v0.4.0: cmdShellInit (claude/gemini wrapper)', () => {
  it('emits non-recursive wrapper functions for claude and gemini', () => {
    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      captured += String(chunk);
      return true;
    });
    const code = cmdShellInit();
    expect(code).toBe(0);
    expect(captured).toContain('claude() {');
    expect(captured).toContain('gemini() {');
    // Wrapper must defer to the real binary via `command`, never recurse.
    expect(captured).toContain('command claude "$@"');
    expect(captured).toContain('command gemini "$@"');
    expect(captured).toContain('session-banner');
    spy.mockRestore();
  });
});

describe('v0.4.0: Gemini SessionStart hook registration', () => {
  it('registers SessionStart under the session-start command', () => {
    const settingsFile = path.join(tmpDir, 'gemini-settings.json');
    const res = registerJsonHooks(settingsFile, 'gemini', '/bin/cc-habits-hook');
    expect(res.sessionStartAdded).toBe(true);

    const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(data.hooks.SessionStart[0].hooks[0].command).toContain('session-start --adapter gemini');
    // Confirm the AfterTool/AfterAgent/BeforeAgent fix is also in place.
    expect(data.hooks.AfterTool[0].matcher).toBe('write_file|replace|edit');
    expect(data.hooks.PostToolUse).toBeUndefined();
  });
});

describe('v0.4.0: Kimi CLI adapter normalization', () => {
  it('is an allowed adapter', () => {
    expect(ALLOWED_ADAPTERS.has('kimi')).toBe(true);
  });

  it('normalizes a WriteFile payload to a Write signal', () => {
    const raw = {
      tool_name: 'WriteFile',
      session_id: 'k1',
      tool_input: { file_path: 'a.py', content: 'x = 1' },
    };
    const res = normalizeInput(raw, 'kimi');
    expect(res.toolName).toBe('Write');
    expect(res.filePath).toBe('a.py');
    expect(res.newContent).toBe('x = 1');
    expect(res.sessionId).toBe('k1');
    expect(res.source).toBe('kimi');
  });

  it('normalizes a StrReplaceFile payload to an Edit signal', () => {
    const raw = {
      tool_name: 'StrReplaceFile',
      session_id: 'k2',
      tool_input: { file_path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' },
    };
    const res = normalizeInput(raw, 'kimi');
    expect(res.toolName).toBe('Edit');
    expect(res.oldContent).toBe('x = 1');
    expect(res.newContent).toBe('x = 2');
    expect(res.source).toBe('kimi');
  });
});

describe('v0.4.0: registerKimiHooks (TOML [[hooks]])', () => {
  it('writes all four events with the correct matcher and adapter, idempotently', () => {
    const configFile = path.join(tmpDir, 'kimi-config.toml');
    const first = registerKimiHooks(configFile, '/bin/cc-habits-hook');
    expect(first.postAdded).toBe(true);
    expect(first.sessionStartAdded).toBe(true);

    const toml = fs.readFileSync(configFile, 'utf-8');
    expect(toml).toContain('[[hooks]]');
    // F4: values use TOML literal (single-quote) strings so Windows backslash
    // paths are not misread as escape sequences.
    expect(toml).toContain("event = 'PostToolUse'");
    expect(toml).toContain("matcher = 'WriteFile|StrReplaceFile'");
    expect(toml).toContain('post-tool-use --adapter kimi');
    expect(toml).toContain("event = 'SessionStart'");
    expect(toml).toContain('session-start --adapter kimi');

    // Re-running must not duplicate the entries.
    const second = registerKimiHooks(configFile, '/bin/cc-habits-hook');
    expect(second.postAdded).toBe(false);
    const reread = fs.readFileSync(configFile, 'utf-8');
    expect(reread.match(/event = 'PostToolUse'/g)?.length).toBe(1);
  });

  it('writes a Windows backslash path as a valid TOML literal string', () => {
    const configFile = path.join(tmpDir, 'kimi-win.toml');
    registerKimiHooks(configFile, 'C:\\Users\\dev\\cc-habits-hook');
    const toml = fs.readFileSync(configFile, 'utf-8');
    // Literal string preserves backslashes verbatim, no invalid \U escape.
    expect(toml).toContain("command = '\"C:\\Users\\dev\\cc-habits-hook\"");
    expect(toml).not.toContain('\\\\U');
  });
});

describe('v0.4.0: cmdTools', () => {
  it('lists every supported tool and exits 0', () => {
    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      captured += String(chunk);
      return true;
    });
    const code = cmdTools();
    spy.mockRestore();
    expect(code).toBe(0);
    for (const tool of SUPPORTED_TOOLS) {
      expect(captured).toContain(tool.name);
    }
    expect(captured).toContain('Kimi Code CLI');
  });

  it('keeps the hook-adapter list in sync with ALLOWED_ADAPTERS', () => {
    for (const id of HOOK_ADAPTERS) {
      expect(ALLOWED_ADAPTERS.has(id)).toBe(true);
    }
    expect(HOOK_ADAPTERS.length).toBe(ALLOWED_ADAPTERS.size);
  });
});

describe('v0.4.0: interactive menu helpers', () => {
  it('wraps around with up/down', () => {
    expect(nextIndex(0, 'up', 3)).toBe(2);
    expect(nextIndex(2, 'down', 3)).toBe(0);
    expect(nextIndex(1, 'down', 3)).toBe(2);
    expect(nextIndex(0, 'up', 0)).toBe(0); // empty list edge case
  });

  it('marks the selected row with a pointer', () => {
    const out = renderMenu(MENU_ITEMS, 0);
    expect(out).toContain('❯');
    expect(out).toContain(MENU_ITEMS[0].label);
    // The first item is selected, so its pointer precedes its label.
    const firstLine = out.split('\n')[0];
    expect(firstLine).toContain('❯');
  });
});
