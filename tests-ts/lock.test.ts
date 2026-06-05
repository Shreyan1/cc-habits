import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireLock, releaseLock } from '../src/lock';

describe('lock', () => {
  let tmpDir: string;
  let lockFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-lock-test-'));
    lockFile = path.join(tmpDir, 'habits.lock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('can acquire and release a lock successfully', async () => {
    const ok = await acquireLock(lockFile, 100, 10);
    expect(ok).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf-8')).toBe(String(process.pid));

    releaseLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('blocks concurrent acquisition and times out', async () => {
    // Acquire first lock
    const ok1 = await acquireLock(lockFile, 100, 10);
    expect(ok1).toBe(true);

    // Try acquiring second lock in parallel/subsequently, should fail (timeout)
    const ok2 = await acquireLock(lockFile, 150, 20);
    expect(ok2).toBe(false);

    releaseLock(lockFile);
  });

  it('breaks a stale lock if the PID is dead', async () => {
    // Write a mock stale PID
    fs.writeFileSync(lockFile, '999999');

    // Mock process.kill to return false (throwing ESRCH) for 999999
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 999999) {
        const err = new Error('ESRCH') as any;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    const ok = await acquireLock(lockFile, 100, 10);
    expect(ok).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf-8')).toBe(String(process.pid));
    releaseLock(lockFile);
  });

  it('breaks a stale lock if the lock file is empty/invalid', async () => {
    fs.writeFileSync(lockFile, 'not-a-pid');

    const ok = await acquireLock(lockFile, 100, 10);
    expect(ok).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf-8')).toBe(String(process.pid));
    releaseLock(lockFile);
  });
});
