import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeInput } from '../src/adapters';
import { buildDiffFromNormalized } from '../src/hook';
import { detectInstalledTools } from '../src/detect';
import { registerJsonHooks, registerCodexHooks, registerClineHooks } from '../src/install';
import { storagePaths, serialiseHabits } from '../src/storage';
import { syncTargets, SyncTarget } from '../src/sync';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-universal-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('v0.3.0 universal: normalizeInput', () => {
  it('normalizes Claude Code format correctly', () => {
    const raw = {
      tool_name: 'Edit',
      session_id: 'sess-claude',
      tool_input: {
        file_path: 'main.py',
        old_string: 'def test(): pass',
        new_string: 'def test(): print("ok")'
      }
    };
    const res = normalizeInput(raw, 'claude-code');
    expect(res.toolName).toBe('Edit');
    expect(res.filePath).toBe('main.py');
    expect(res.oldContent).toBe('def test(): pass');
    expect(res.newContent).toBe('def test(): print("ok")');
    expect(res.sessionId).toBe('sess-claude');
    expect(res.source).toBe('claude-code');
  });

  it('normalizes Gemini format correctly', () => {
    const raw = {
      tool: 'Write',
      file: 'app.go',
      newContent: 'package main',
      sessionId: 'sess-gemini'
    };
    const res = normalizeInput(raw, 'gemini');
    expect(res.toolName).toBe('Write');
    expect(res.filePath).toBe('app.go');
    expect(res.newContent).toBe('package main');
    expect(res.sessionId).toBe('sess-gemini');
    expect(res.source).toBe('gemini');
  });

  it('normalizes Gemini AfterTool tool_input payload (write_file)', () => {
    const raw = {
      tool_name: 'write_file',
      session_id: 'sess-gemini-real',
      tool_input: {
        file_path: 'app.go',
        content: 'package main'
      }
    };
    const res = normalizeInput(raw, 'gemini');
    expect(res.toolName).toBe('write_file');
    expect(res.filePath).toBe('app.go');
    expect(res.newContent).toBe('package main');
    expect(res.sessionId).toBe('sess-gemini-real');
    expect(res.source).toBe('gemini');
  });

  it('normalizes Gemini AfterTool tool_input payload (replace)', () => {
    const raw = {
      tool_name: 'replace',
      session_id: 'sess-gemini-replace',
      tool_input: {
        file_path: 'main.py',
        old_string: 'x = 1',
        new_string: 'x = 2'
      }
    };
    const res = normalizeInput(raw, 'gemini');
    expect(res.toolName).toBe('replace');
    expect(res.filePath).toBe('main.py');
    expect(res.oldContent).toBe('x = 1');
    expect(res.newContent).toBe('x = 2');
    expect(res.sessionId).toBe('sess-gemini-replace');
    expect(res.source).toBe('gemini');
  });

  it('normalizes Codex format correctly (edit fields nested under tool_input)', () => {
    // Codex emits Claude-shaped payloads: edit fields live under tool_input.
    const raw = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'lib.rs',
        old_string: 'fn run() {}',
        new_string: 'fn run() -> bool { true }',
      },
      session_id: 'sess-codex',
      cwd: '/repo',
    };
    const res = normalizeInput(raw, 'codex');
    expect(res.toolName).toBe('Edit');
    expect(res.filePath).toBe('lib.rs');
    expect(res.oldContent).toBe('fn run() {}');
    expect(res.newContent).toBe('fn run() -> bool { true }');
    expect(res.sessionId).toBe('sess-codex');
    expect(res.source).toBe('codex');
  });

  it('normalizes Codex format with top-level fields as a fallback', () => {
    const raw = {
      tool_name: 'Edit',
      file_path: 'lib.rs',
      old_string: 'fn run() {}',
      new_string: 'fn run() -> bool { true }',
      session_id: 'sess-codex',
    };
    const res = normalizeInput(raw, 'codex');
    expect(res.filePath).toBe('lib.rs');
    expect(res.oldContent).toBe('fn run() {}');
    expect(res.newContent).toBe('fn run() -> bool { true }');
    expect(res.source).toBe('codex');
  });

  it('normalizes Codex multi-edit (tool_input.edits) correctly', () => {
    const raw = {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'a.ts',
        edits: [
          { old_string: 'let x = 1', new_string: 'const x = 1' },
          { old_string: 'var y', new_string: 'const y' },
        ],
      },
      session_id: 'sess-codex',
    };
    const res = normalizeInput(raw, 'codex');
    expect(res.filePath).toBe('a.ts');
    expect(res.edits).toHaveLength(2);
    expect(res.edits?.[0].new_string).toBe('const x = 1');
  });

  it('normalizes Cline write_to_file format correctly', () => {
    const raw = {
      hookName: 'PostToolUse',
      clineVersion: '3.36.0',
      taskId: 'task-cline-1',
      tool: 'write_to_file',
      parameters: {
        path: 'src/app.ts',
        content: 'export const x = 1'
      },
      success: true
    };
    const res = normalizeInput(raw, 'cline');
    expect(res.toolName).toBe('Write');
    expect(res.filePath).toBe('src/app.ts');
    expect(res.newContent).toBe('export const x = 1');
    expect(res.diff).toBeUndefined();
    expect(res.sessionId).toBe('task-cline-1');
    expect(res.source).toBe('cline');
  });

  it('normalizes Cline replace_in_file format correctly', () => {
    const raw = {
      hookName: 'PostToolUse',
      taskId: 'task-cline-2',
      tool: 'replace_in_file',
      parameters: {
        path: 'src/lib.ts',
        diff: '<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE'
      },
      success: true
    };
    const res = normalizeInput(raw, 'cline');
    expect(res.toolName).toBe('Edit');
    expect(res.filePath).toBe('src/lib.ts');
    expect(res.diff).toContain('const a = 2');
    expect(res.sessionId).toBe('task-cline-2');
    expect(res.source).toBe('cline');
  });

  it('defaults Cline tool name and tolerates empty payload', () => {
    const res = normalizeInput({}, 'cline');
    expect(res.toolName).toBe('Edit');
    expect(res.filePath).toBe('');
    expect(res.sessionId).toBe('');
    expect(res.source).toBe('cline');
  });

  it('rejects unsupported adapter names', () => {
    expect(() => normalizeInput({}, 'invalid-adapter')).toThrow(/Unsupported or invalid adapter/);
  });
});

describe('v0.3.0 universal: buildDiffFromNormalized', () => {
  it('preserves pre-computed diff if present', () => {
    const input = {
      toolName: 'Edit',
      filePath: 'test.py',
      diff: '+++ test.py\n+hello',
      sessionId: 'sess'
    };
    const diff = buildDiffFromNormalized(input);
    expect(diff).toBe('+++ test.py\n+hello');
  });

  it('builds Write diff correctly', () => {
    const input = {
      toolName: 'Write',
      filePath: 'test.py',
      newContent: 'a = 1\nb = 2',
      sessionId: 'sess'
    };
    const diff = buildDiffFromNormalized(input);
    expect(diff).toContain('+++ test.py');
    expect(diff).toContain('+a = 1');
    expect(diff).toContain('+b = 2');
  });

  it('builds Edit diff correctly', () => {
    const input = {
      toolName: 'Edit',
      filePath: 'test.py',
      oldContent: 'a = 1',
      newContent: 'a = 2',
      sessionId: 'sess'
    };
    const diff = buildDiffFromNormalized(input);
    expect(diff).toContain('--- test.py');
    expect(diff).toContain('-a = 1');
    expect(diff).toContain('+a = 2');
  });
});

describe('v0.3.0 universal: syncTargets paths and sync all', () => {
  it('maps all targets correctly and syncs all', () => {
    storagePaths.habitsFile = path.join(tmpDir, 'habits.md');

    const targets: SyncTarget[] = ['agents', 'cursor', 'copilot', 'gemini', 'cline', 'aider', 'continue', 'jetbrains', 'windsurf'];
    const activeHabitsMd = serialiseHabits({
      TS: [
        {
          rule: 'Prefer const over let',
          confidence: 0.8,
          reinforcing: 5,
          contradicting: 0,
          sessions_seen: 3,
        }
      ]
    });
    fs.writeFileSync(storagePaths.habitsFile, activeHabitsMd);

    const res = syncTargets(targets, { baseDir: tmpDir });
    expect(res.written).toHaveLength(9);
    
    const windsurfPath = path.join(tmpDir, '.windsurfrules');
    expect(fs.existsSync(windsurfPath)).toBe(true);
    expect(fs.readFileSync(windsurfPath, 'utf-8')).toContain('Prefer const over let');

    const aiderPath = path.join(tmpDir, 'AIDER.md');
    expect(fs.existsSync(aiderPath)).toBe(true);
  });
});

describe('v0.3.0 universal: install hooks security and interpolation', () => {
  it('registerJsonHooks writes correct command with --adapter', () => {
    const settingsFile = path.join(tmpDir, 'settings.json');
    const res = registerJsonHooks(settingsFile, 'gemini', '/bin/cc-habits-hook');
    expect(res.postAdded).toBe(true);

    const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    // Gemini CLI uses AfterTool (not Claude's PostToolUse) and its own tool names.
    const entry = data.hooks.AfterTool[0];
    expect(entry.matcher).toBe('write_file|replace|edit');
    expect(entry.hooks[0].command).toContain('post-tool-use --adapter gemini');
    expect(data.hooks.AfterAgent[0].hooks[0].command).toContain('stop --adapter gemini');
    expect(data.hooks.BeforeAgent[0].hooks[0].command).toContain('user-prompt-submit --adapter gemini');
    expect(data.hooks.PostToolUse).toBeUndefined();
  });

  it('registerCodexHooks writes PostToolUse + UserPromptSubmit (no Stop, which Codex never fires)', () => {
    const configToml = path.join(tmpDir, 'config.toml');
    const hooksJson = path.join(tmpDir, 'hooks.json');
    const res = registerCodexHooks(configToml, '/bin/cc-habits-hook');
    expect(res.postAdded).toBe(true);
    expect(res.promptAdded).toBe(true);

    const content = fs.readFileSync(hooksJson, 'utf-8');
    const data = JSON.parse(content);
    expect(data.hooks.PostToolUse[0].hooks[0].command).toContain('post-tool-use --adapter codex');
    // UserPromptSubmit drives the compile pass (Codex has no Stop event).
    expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toContain('stop --adapter codex');
    expect(data.hooks.Stop).toBeUndefined();
  });

  it('registerCodexHooks removes a stale legacy Stop hook on re-register', () => {
    const configToml = path.join(tmpDir, 'config.toml');
    const hooksJson = path.join(tmpDir, 'hooks.json');
    // Simulate an old install that registered a cc-habits Stop hook.
    fs.writeFileSync(hooksJson, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '"/bin/cc-habits-hook" stop --adapter codex || true' }] }],
      },
    }) + '\n', 'utf-8');

    registerCodexHooks(configToml, '/bin/cc-habits-hook');
    const data = JSON.parse(fs.readFileSync(hooksJson, 'utf-8'));
    expect(data.hooks.Stop).toBeUndefined();
    expect(data.hooks.UserPromptSubmit[0].hooks[0].command).toContain('stop --adapter codex');
  });

  it('registerClineHooks writes hooks shell scripts correctly', () => {
    const hooksDir = path.join(tmpDir, 'Hooks');
    const res = registerClineHooks(hooksDir, '/bin/cc-habits-hook');
    expect(res.postAdded).toBe(true);

    const postFile = path.join(hooksDir, 'PostToolUse');
    expect(fs.existsSync(postFile)).toBe(true);
    const content = fs.readFileSync(postFile, 'utf-8');
    expect(content).toContain('post-tool-use --adapter cline');
  });

  it.skipIf(process.platform === 'win32')('registerJsonHooks respects symlink protection', () => {
    const realFile = path.join(tmpDir, 'real.json');
    fs.writeFileSync(realFile, '{}');
    const symLink = path.join(tmpDir, 'sym.json');
    fs.symlinkSync(realFile, symLink);

    expect(() => registerJsonHooks(symLink, 'gemini', '/bin/cc-habits-hook')).toThrow(/refusing to write through symlink/);
  });
});
