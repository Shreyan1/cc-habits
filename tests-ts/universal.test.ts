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

  it('normalizes Codex format correctly', () => {
    const raw = {
      tool_name: 'Edit',
      file_path: 'lib.rs',
      old_string: 'fn run() {}',
      new_string: 'fn run() -> bool { true }',
      session_id: 'sess-codex'
    };
    const res = normalizeInput(raw, 'codex');
    expect(res.toolName).toBe('Edit');
    expect(res.filePath).toBe('lib.rs');
    expect(res.oldContent).toBe('fn run() {}');
    expect(res.newContent).toBe('fn run() -> bool { true }');
    expect(res.sessionId).toBe('sess-codex');
    expect(res.source).toBe('codex');
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
    const command = data.hooks.PostToolUse[0].hooks[0].command;
    expect(command).toContain('post-tool-use --adapter gemini');
  });

  it('registerCodexHooks writes correct toml hooks with --adapter', () => {
    const configToml = path.join(tmpDir, 'config.toml');
    const res = registerCodexHooks(configToml, '/bin/cc-habits-hook');
    expect(res.postAdded).toBe(true);

    const content = fs.readFileSync(configToml, 'utf-8');
    expect(content).toContain('[hooks]');
    expect(content).toContain('post-tool-use --adapter codex');
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

  it('registerJsonHooks respects symlink protection', () => {
    const realFile = path.join(tmpDir, 'real.json');
    fs.writeFileSync(realFile, '{}');
    const symLink = path.join(tmpDir, 'sym.json');
    fs.symlinkSync(realFile, symLink);

    expect(() => registerJsonHooks(symLink, 'gemini', '/bin/cc-habits-hook')).toThrow(/refusing to write through symlink/);
  });
});
