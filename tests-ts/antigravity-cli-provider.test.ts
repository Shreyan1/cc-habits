import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { AntigravityCliProvider } from '../src/providers/antigravity-cli';
import {
  ProviderNotInstalledError,
  ProviderTimeoutError,
  ProviderRateLimitError,
} from '../src/providers/types';

const OPTS = { maxTokens: 1024, timeoutMs: 30_000 };

function makeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: Error;
  signal?: string;
  delayMs?: number;
}) {
  const child = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  if (opts.delayMs === undefined) {
    setImmediate(() => {
      if (opts.error) {
        child.emit('error', opts.error);
        return;
      }
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      child.emit('close', opts.exitCode ?? 0, opts.signal ?? null);
    });
  }

  return child;
}

describe('AntigravityCliProvider.generate', () => {
  const spawnSpy = vi.mocked(spawn);

  beforeEach(() => {
    spawnSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns stdout output on successful completion', async () => {
    spawnSpy.mockReturnValue(makeChild({ stdout: 'hello user', exitCode: 0 }));
    const result = await new AntigravityCliProvider().generate('prompt', OPTS);
    expect(result).toBe('hello user');
    expect(spawnSpy).toHaveBeenCalledWith('agy', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('throws ProviderTimeoutError on timeout', async () => {
    vi.useFakeTimers();
    const child = makeChild({ delayMs: 1000 });
    spawnSpy.mockReturnValue(child);

    const promise = new AntigravityCliProvider().generate('prompt', { maxTokens: 100, timeoutMs: 100 });
    
    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.useRealTimers();
  });

  it('throws ProviderRateLimitError when exit code is non-zero and output matches rate limit indicators', async () => {
    spawnSpy.mockReturnValue(makeChild({ stderr: 'HTTP 429 Too Many Requests', exitCode: 429 }));
    await expect(new AntigravityCliProvider().generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('throws ProviderNotInstalledError when agy is not installed (ENOENT)', async () => {
    const error = new Error('spawn agy ENOENT');
    (error as any).code = 'ENOENT';
    spawnSpy.mockReturnValue(makeChild({ error }));
    await expect(new AntigravityCliProvider().generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderNotInstalledError);
  });
});
