/**
 * Tests for the Codex CLI provider and the --provider validation that lets it be
 * selected.
 *
 * CodexCliProvider.generate() shells out to `codex exec` via spawnSync; we mock
 * spawnSync to exercise the success path (final-message file capture) and each
 * typed-error classification without invoking the real Codex binary.
 * validateProviderFlag() is pure and gates `cch init --provider <x>`.
 *
 * Setup/teardown: spawnSync is mocked per-suite and restored after each case; the
 * success case stubs fs so the captured-output file read is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// spawnSync is a named ESM export and cannot be spied in place, so mock the
// module and keep every other export intact.
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from 'child_process';
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

describe('CodexCliProvider.generate', () => {
  const spawnSpy = vi.mocked(spawnSync);

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
    spawnSpy.mockReturnValue({ status: 0, stdout: 'event chatter', stderr: '', signal: null } as never);

    const out = await new CodexCliProvider().generate('prompt', OPTS);

    expect(out).toBe('{"rules":[]}');
    // The prompt is piped via stdin, not argv, and the sandbox is read-only.
    const [bin, args, opts] = spawnSpy.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(bin).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
    expect(opts.input).toBe('prompt');
    expect(unlinkSpy).toHaveBeenCalled(); // temp file cleaned up
    readSpy.mockRestore();
    fileSpy.mockRestore();
  });

  it('falls back to stdout when the capture file is empty/absent', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue({ status: 0, stdout: 'plain answer', stderr: '', signal: null } as never);

    const out = await new CodexCliProvider().generate('p', OPTS);
    expect(out).toBe('plain answer');
  });

  it('throws ProviderNotInstalledError when codex is not on PATH', async () => {
    spawnSpy.mockReturnValue({ error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) } as never);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderNotInstalledError);
  });

  it('throws ProviderTimeoutError on SIGTERM/ETIMEDOUT', async () => {
    spawnSpy.mockReturnValue({ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' } as never);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('classifies a not-logged-in failure as ProviderAuthError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue({ status: 1, stdout: '', stderr: 'Error: not logged in', signal: null } as never);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies a quota failure as ProviderQuotaError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue({ status: 1, stdout: '', stderr: 'quota exceeded', signal: null } as never);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderQuotaError);
  });

  it('classifies a rate-limit failure as ProviderRateLimitError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    spawnSpy.mockReturnValue({ status: 1, stdout: '', stderr: 'HTTP 429 too many requests', signal: null } as never);
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe('validateProviderFlag', () => {
  it('accepts every provider in VALID_PROVIDERS', () => {
    for (const p of VALID_PROVIDERS) expect(validateProviderFlag(p)).toBeNull();
  });

  it('accepts codex-cli', () => {
    expect(validateProviderFlag('codex-cli')).toBeNull();
  });

  it('rejects the bare tool name `codex` with a pointer to codex-cli', () => {
    const err = validateProviderFlag('codex');
    expect(err).not.toBeNull();
    expect(err).toContain('codex-cli');
  });

  it('rejects an unknown provider and lists the valid set', () => {
    const err = validateProviderFlag('gpt5');
    expect(err).not.toBeNull();
    expect(err).toContain('claude-cli');
    expect(err).toContain('codex-cli');
  });
});
