/**
 * Tests for the hook-registration "proof" readers.
 *
 * hookProofPaths() resolves the real on-disk file(s) where each tool's cc-habits
 * hooks actually live (Codex uses a sidecar hooks.json, Cline one file per event).
 * readRegisteredHooks() reads those files back and returns the cc-habits hook
 * commands genuinely present, across JSON (Claude/Gemini/Codex), TOML (Kimi), and
 * shell (Cline) formats. Together they let `cch init` / `cch status` show the user
 * real proof instead of an unverifiable "✓ registered" claim.
 *
 * Setup: a fresh temp dir holding seeded settings files per case.
 * Teardown: the temp dir is removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hookProofPaths, readRegisteredHooks } from '../src/install';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-proof-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hookProofPaths', () => {
  it('returns the Codex sidecar hooks.json, not config.toml', () => {
    const paths = hookProofPaths('codex', path.join('/home/u/.codex', 'config.toml'));
    expect(paths).toEqual([path.join('/home/u/.codex', 'hooks.json')]);
  });

  it('returns the detected settings path for Gemini and Kimi', () => {
    expect(hookProofPaths('gemini', '/x/.gemini/settings.json')).toEqual(['/x/.gemini/settings.json']);
    expect(hookProofPaths('kimi', '/x/.kimi/config.toml')).toEqual(['/x/.kimi/config.toml']);
  });

  it('returns one shell file per event for Cline', () => {
    expect(hookProofPaths('cline', '/x/Hooks')).toEqual([
      path.join('/x/Hooks', 'PostToolUse'),
      path.join('/x/Hooks', 'Stop'),
    ]);
  });
});

describe('readRegisteredHooks, JSON settings (Claude/Gemini/Codex)', () => {
  it('extracts cc-habits hook commands grouped by event', () => {
    const file = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '"/bin/cc-habits-hook" post-tool-use --adapter codex || true' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"/bin/cc-habits-hook" stop --adapter codex || true' }] }],
      },
    }, null, 2));

    const hooks = readRegisteredHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual({
      event: 'PostToolUse',
      command: '"/bin/cc-habits-hook" post-tool-use --adapter codex || true',
    });
    expect(hooks.find(h => h.event === 'UserPromptSubmit')?.command).toContain('stop --adapter codex');
  });

  it('ignores non-cc-habits hooks in the same file', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'some-other-tool run || true' }] }] },
    }));
    expect(readRegisteredHooks(file)).toEqual([]);
  });

  it('returns [] for a missing file', () => {
    expect(readRegisteredHooks(path.join(tmpDir, 'nope.json'))).toEqual([]);
  });

  it('returns [] for malformed JSON without throwing', () => {
    const file = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(file, '{ this is not valid json');
    expect(() => readRegisteredHooks(file)).not.toThrow();
    expect(readRegisteredHooks(file)).toEqual([]);
  });
});

describe('readRegisteredHooks, TOML (Kimi)', () => {
  it('extracts event and command from [[hooks]] blocks', () => {
    const file = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      file,
      `\n[[hooks]]\nevent = 'PostToolUse'\nmatcher = 'WriteFile|StrReplaceFile'\ncommand = '"/bin/cc-habits-hook" post-tool-use --adapter kimi || true'\n` +
        `\n[[hooks]]\nevent = 'Stop'\ncommand = '"/bin/cc-habits-hook" stop --adapter kimi || true'\n`,
    );

    const hooks = readRegisteredHooks(file);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual({ event: 'PostToolUse', command: '"/bin/cc-habits-hook" post-tool-use --adapter kimi || true' });
    expect(hooks[1]).toEqual({ event: 'Stop', command: '"/bin/cc-habits-hook" stop --adapter kimi || true' });
  });
});

describe('readRegisteredHooks, shell hook file (Cline)', () => {
  it('uses the file name as the event', () => {
    const file = path.join(tmpDir, 'PostToolUse');
    fs.writeFileSync(file, `#!/bin/sh\n"/bin/cc-habits-hook" post-tool-use --adapter cline || true\n`);

    const hooks = readRegisteredHooks(file);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].event).toBe('PostToolUse');
    expect(hooks[0].command).toContain('post-tool-use --adapter cline');
  });
});
