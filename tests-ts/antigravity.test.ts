import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Control the `which agy` / `where agy` lookup so these tests are deterministic
// on any host, including a developer machine that actually has Antigravity
// installed. execFileSync throws by default here, which makes isCliOnPath('agy')
// report "not found" unless a test opts in.
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

// Imported after the mock is declared so detect.ts binds the mocked execFileSync.
import { isAntigravityMigrated } from '../src/detect';

// Google retired the consumer Gemini CLI on 2026-06-18 and moved users onto the
// Antigravity CLI. These tests pin the detection signal cc-habits uses to switch
// the Gemini setup path from "register capture hooks" to "inject only".

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-antigravity-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => {
    throw new Error('not found');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('Antigravity CLI migration detection', () => {
  it('returns true when the ~/.gemini/antigravity-cli config tree exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity-cli'), { recursive: true });
    expect(isAntigravityMigrated()).toBe(true);
  });

  it('returns true when the agy binary is on PATH even without the config tree', () => {
    execFileSyncMock.mockImplementation(() => Buffer.from('/usr/local/bin/agy'));
    expect(isAntigravityMigrated()).toBe(true);
  });

  it('returns false for a plain (un-migrated) ~/.gemini directory', () => {
    fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true });
    expect(isAntigravityMigrated()).toBe(false);
  });

  it('returns false when neither the config tree nor the agy binary is present', () => {
    expect(isAntigravityMigrated()).toBe(false);
  });

  it('is fail-open: never throws even if homedir resolution fails', () => {
    const spy = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('no home');
    });
    expect(() => isAntigravityMigrated()).not.toThrow();
    spy.mockRestore();
  });
});
