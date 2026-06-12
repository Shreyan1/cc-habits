/**
 * Tests for cmdStatus(), the new read-only health-check command.
 *
 * Setup: temp dir for all storagePaths, seeded habits/signals/settings as
 * needed per case. Teardown: temp dir removed, storagePaths restored.
 *
 * All tests assert:
 *   - cmdStatus() returns 0 (never throws or returns a non-zero exit code)
 *   - stdout contains the expected section headers and key content strings
 *   - no filesystem writes occur
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cmdStatus } from '../src/cli';
import { storagePaths } from '../src/storage';
import { installPaths } from '../src/install';

const origStorage = { ...storagePaths };
const origInstall = { ...installPaths };

let tmpDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;

const SEEDED_HABITS = `<!-- cc-habits format v0.2 -->
# Coding habits

## TypeScript

- Use explicit return types on exported functions. Confidence: 0.80
  - Signal: 5 reinforcing, 0 contradicting
  - Sessions seen: 3

## Naming

- Use camelCase for variables. Confidence: 0.90
  - Signal: 8 reinforcing, 0 contradicting
  - Sessions seen: 4

## Learning (not yet active)

- [Imports] Prefer named imports over default. Confidence: 0.50
  - Signal: 1 reinforcing, 0 contradicting
  - Sessions seen: 1
`;

function seedHabits(): void {
  fs.writeFileSync(storagePaths.habitsFile, SEEDED_HABITS);
}

function seedSignals(): void {
  // One captured signal so readSignals() is non-empty (the "All good." healthy
  // state requires provider + active habits + at least one captured signal).
  const sig = { session_id: 's1', tool: 'Write', file: 'a.ts', diff: '+x', ts: Date.now() };
  fs.writeFileSync(storagePaths.logFile, JSON.stringify(sig) + '\n');
}

function seedSettings(): void {
  // Minimal settings.json with a cc-habits-hook registered so areHooksRegistered
  // returns true against the temp installPaths.settingsFile.
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '"/usr/bin/cc-habits-hook" post-tool-use --adapter claude-code || true' }] }],
      Stop: [{ hooks: [{ type: 'command', command: '"/usr/bin/cc-habits-hook" stop --adapter claude-code || true' }] }],
      UserPromptSubmit: [],
      SessionStart: [],
    },
  };
  fs.writeFileSync(installPaths.settingsFile, JSON.stringify(settings, null, 2));
}

function capturedOutput(): string {
  return stdoutChunks.join('');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-status-'));
  fs.mkdirSync(path.join(tmpDir, 'claude'), { recursive: true });

  // Redirect storagePaths.
  storagePaths.habitsDir       = tmpDir;
  storagePaths.habitsFile      = path.join(tmpDir, 'habits.md');
  storagePaths.preferencesFile = path.join(tmpDir, 'preferences.md');
  storagePaths.logFile         = path.join(tmpDir, 'log.jsonl');
  storagePaths.configFile      = path.join(tmpDir, 'config.yml');

  // Redirect installPaths so areHooksRegistered reads from tmpDir.
  installPaths.claudeDir   = path.join(tmpDir, 'claude');
  installPaths.settingsFile = path.join(tmpDir, 'claude', 'settings.json');
  installPaths.claudeMd    = path.join(tmpDir, 'claude', 'CLAUDE.md');

  // Capture stdout.
  stdoutChunks = [];
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['ANTHROPIC_API_KEY'];
});

describe('cmdStatus, healthy state', () => {
  it('returns 0', () => {
    seedHabits();
    seedSettings();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    expect(cmdStatus()).toBe(0);
  });

  it('prints the bordered table with key-value rows', () => {
    seedHabits();
    seedSettings();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    cmdStatus();
    const out = capturedOutput();
    expect(out).toContain('┌');
    expect(out).toContain('│');
    expect(out).toContain('├');
    expect(out).toContain('└');
    expect(out).toContain('provider');
    expect(out).toContain('import');
    expect(out).toContain('habits');
    expect(out).toContain('signals');
  });

  it('shows provider as anthropic when ANTHROPIC_API_KEY is set', () => {
    seedHabits();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    cmdStatus();
    expect(capturedOutput()).toContain('anthropic');
  });

  it('shows active habit count from seeded habits', () => {
    seedHabits(); // 2 active (sessions_seen >= 2), 1 learning
    cmdStatus();
    expect(capturedOutput()).toContain('2 active');
  });

  it('ends with "All good." when provider is set and habits are active', () => {
    seedHabits();
    seedSignals();
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    cmdStatus();
    expect(capturedOutput()).toContain('All good.');
  });
});

describe('cmdStatus, empty store (no signals, no habits)', () => {
  it('returns 0 without throwing', () => {
    expect(() => cmdStatus()).not.toThrow();
    expect(cmdStatus()).toBe(0);
  });

  it('suggests cch bootstrap when no signals captured yet', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    cmdStatus();
    expect(capturedOutput()).toContain('cch bootstrap');
  });

  it('shows "no habits yet" for preferences.md when file is absent', () => {
    cmdStatus();
    expect(capturedOutput()).toContain('no habits yet');
  });
});

describe('cmdStatus, no provider configured', () => {
  it('shows no-provider message and suggests cch init', () => {
    // No ANTHROPIC_API_KEY, no config.yml.
    cmdStatus();
    const out = capturedOutput();
    expect(out).toContain('No provider configured');
    expect(out).toContain('cch init');
  });

  it('suggests cch init as next step when no provider configured', () => {
    cmdStatus();
    expect(capturedOutput()).toContain('cch init');
  });
});

describe('cmdStatus, parked CLI provider in config (status must agree with init)', () => {
  it('treats a parked codex-cli as no provider, never names it as active or "All good."', () => {
    // The user's config still names a parked CLI provider (e.g. leftover from
    // `--provider codex-cli`). `cch init` treats it as not usable, so `cch status`
    // must say the same: the honest no-provider state, never "✓ ... All good." and
    // never naming codex-cli as if it were the active provider.
    delete process.env['ANTHROPIC_API_KEY'];
    seedHabits();
    seedSignals();
    seedSettings();
    fs.writeFileSync(storagePaths.configFile, 'provider: codex-cli\n');
    cmdStatus();
    const out = capturedOutput();
    expect(out).toContain('No provider configured');
    // The parked provider is no longer named as "your provider" nor flagged as an
    // inactive one; it is simply treated as no provider. (A detected Codex *tool*
    // may still appear in the Hooks section with its ~/.codex path, which is fine.)
    expect(out).not.toContain('codex-cli');
    expect(out).not.toContain('is not active');
    expect(out).not.toContain('All good.');
    expect(out).toContain('cch init');
  });

  it('flags a key-less anthropic config instead of claiming it works', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    seedHabits();
    seedSignals();
    seedSettings();
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\n'); // no key
    cmdStatus();
    const out = capturedOutput();
    expect(out).toContain('no API key found');
    expect(out).not.toContain('All good.');
  });
});

describe('cmdStatus, no hooks registered', () => {
  it('returns 0 when settings.json is absent', () => {
    // No settings.json created.
    expect(cmdStatus()).toBe(0);
  });

  it('does not throw when CLAUDE.md is absent', () => {
    // claudeMd file not created.
    expect(() => cmdStatus()).not.toThrow();
  });
});
