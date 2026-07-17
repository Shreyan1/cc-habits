import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// spawn is a named ESM export and cannot be spied in place, so mock the
// module and keep every other export intact.
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn(), spawn: vi.fn() };
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

describe('CodexCliProvider.generate', () => {
  const spawnSpy = vi.mocked(spawn);
  let lastStdinWrite: string = '';

  beforeEach(() => {
    spawnSpy.mockReset();
    lastStdinWrite = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setSpawnMock(status: number | null, stdout: string, stderr: string, signal: string | null = null, error: Error | null = null) {
    spawnSpy.mockImplementation(((command: string, args: string[], options: any) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: vi.fn((data: string) => {
          lastStdinWrite = data;
        }),
        end: vi.fn(() => {
          process.nextTick(() => {
            if (error) {
              child.emit('error', error);
              return;
            }
            process.nextTick(() => {
              if (stdout) child.stdout.emit('data', Buffer.from(stdout));
              if (stderr) child.stderr.emit('data', Buffer.from(stderr));
              process.nextTick(() => {
                child.emit('close', status, signal);
              });
            });
          });
        })
      };
      return child;
    }) as any);
  }

  it('returns the captured final-message file on success', async () => {
    // codex writes the agent's final message to the -o file; stub that read.
    const readSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const fileSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('{"rules":[]}' as never);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    setSpawnMock(0, 'event chatter', '');

    const out = await new CodexCliProvider().generate('prompt', OPTS);

    expect(out).toBe('{"rules":[]}');
    const [bin, args] = spawnSpy.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(bin).toBe('codex');
    expect(args).toContain('exec');
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
    expect(lastStdinWrite).toBe('prompt');
    expect(unlinkSpy).toHaveBeenCalled(); // temp file cleaned up
    readSpy.mockRestore();
    fileSpy.mockRestore();
  });

  it('falls back to stdout when the capture file is empty/absent', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setSpawnMock(0, 'plain answer', '');

    const out = await new CodexCliProvider().generate('p', OPTS);
    expect(out).toBe('plain answer');
  });

  it('throws ProviderNotInstalledError when codex is not on PATH', async () => {
    setSpawnMock(null, '', '', null, Object.assign(new Error('spawn'), { code: 'ENOENT' }));
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderNotInstalledError);
  });

  it('throws ProviderTimeoutError on SIGTERM/ETIMEDOUT', async () => {
    setSpawnMock(null, '', '', 'SIGTERM');
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('classifies a not-logged-in failure as ProviderAuthError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setSpawnMock(1, '', 'Error: not logged in');
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('classifies a quota failure as ProviderQuotaError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setSpawnMock(1, '', 'quota exceeded');
    await expect(new CodexCliProvider().generate('p', OPTS)).rejects.toBeInstanceOf(ProviderQuotaError);
  });

  it('classifies a rate-limit failure as ProviderRateLimitError', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setSpawnMock(1, '', 'HTTP 429 too many requests');
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
