/**
 * Tests for the Codex CLI provider and the --provider validation that lets it be
 * selected.
 *
 * CodexCliProvider.generate() shells out to `codex exec` via spawn (async);
 * we mock spawn to exercise the success path (final-message file capture) and
 * each typed-error classification without invoking the real Codex binary.
 * validateProviderFlag() is pure and gates `cch init --provider <x>`.
 *
 * Setup/teardown: spawn is mocked per-suite and restored after each case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// spawn is a named ESM export and cannot be spied in place, so mock the
// module and keep every other export intact.
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import fs from 'fs';
import { CodexCliProvider } from '../src/providers/codex-cli';
import {
  ProviderNotInstalledError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderQuotaError,
  ProviderRateLimitError,
} from '../src/providers/types';
import { validateProviderFlag, VALID_PROVIDERS } from '../src/cli-provider';

const OPTS = { maxTokens: 1024, timeoutMs: 30_000 };

/** Build a fake ChildProcess that emits events as a real spawn would. */
function makeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error;
  signal?: string;
}) {
  const child = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  setImmediate(() => {
    if (opts.error) {
      child.emit('error', opts.error);
      return;
    }
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.exitCode ?? 0, opts.signal ?? null);
  });

  return child;
}

describe('CodexCliProvider.generate', () => {
  const spawnSpy = vi.mocked(spawn);

  beforeEach(() => {
    spawnSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the captured final-message file on success', async () => {
    // codex writes the agent's final message to the -o file; stub that read.
    const readSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const fileSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('{"rules":[]}' as never);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    spawnSpy.mockReturnValue(makeChild({ stdout: 'event chatter', exitCode: 0 }) as any);

    const out = await new CodexCliProvider().generate('prompt', OPTS);

    expect(out).toBe('{"rules":[]}');
    // The prompt is piped via stdin, not argv, and the sandbox is read-only.
    const [bin, args] = spawnSpy.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(bin).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
    expect(unlinkSpy).toHaveBeenCalled(); // temp file cleaned up
    readSpy.mockRestore();
    fileSpy.mockRestore();
  });

  it('falls back to stdout when the capture file is empty/absent', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue(makeChild({ stdout: 'plain answer', exitCode: 0 }) as any);

    const out = await new CodexCliProvider().generate('p', OPTS);
    expect(out).toBe('plain answer');
  });

  it('throws ProviderNotInstalledError when codex is not on PATH', async () => {
    const err = Object.assign(new Error('spawn'), { code: 'ENOENT' });
    spawnSpy.mockReturnValue(makeChild({ error: err }) as any);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderNotInstalledError);
  });

  it('throws ProviderTimeoutError on SIGTERM/ETIMEDOUT', async () => {
    const err = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
    spawnSpy.mockReturnValue(makeChild({ error: err }) as any);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('classifies a not-logged-in failure as ProviderAuthError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue(makeChild({ stderr: 'Error: not logged in', exitCode: 1 }) as any);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies a quota failure as ProviderQuotaError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue(makeChild({ stderr: 'quota exceeded', exitCode: 1 }) as any);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderQuotaError);
  });

  it('classifies a rate-limit failure as ProviderRateLimitError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue(makeChild({ stderr: 'HTTP 429 too many requests', exitCode: 1 }) as any);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe('validateProviderFlag', () => {
  it('accepts every provider in VALID_PROVIDERS', () => {
    for (const p of VALID_PROVIDERS) expect(validateProviderFlag(p)).toBeNull();
  });

  it('rejects an unknown provider name', () => {
    expect(validateProviderFlag('banana')).not.toBeNull();
  });
});
