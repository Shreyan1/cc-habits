import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeInput } from '../src/adapters';
import { selectProvider } from '../src/providers';

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
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-antigravity-'));
  // Mock os.homedir() directly instead of setting process.env.HOME. On Windows
  // os.homedir() resolves from USERPROFILE, not HOME, so an env override would be
  // ignored and detection would inspect the real home directory. Spying on the
  // function keeps these tests deterministic on every platform.
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(() => {
    throw new Error('not found');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    homedirSpy.mockImplementation(() => {
      throw new Error('no home');
    });
    expect(() => isAntigravityMigrated()).not.toThrow();
  });
});

describe('Antigravity adapter and provider registration', () => {
  it('normalizes antigravity payloads correctly', () => {
    const raw = {
      session_id: 'test-antigravity-session',
      toolCall: {
        name: 'write_file',
        arguments: {
          path: 'src/index.ts',
          content: 'console.log("hello")',
        },
      },
    };
    const norm = normalizeInput(raw, 'antigravity');
    expect(norm.toolName).toBe('write_file');
    expect(norm.filePath).toBe('src/index.ts');
    expect(norm.newContent).toBe('console.log("hello")');
    expect(norm.sessionId).toBe('test-antigravity-session');
    expect(norm.source).toBe('antigravity');
  });

  it('registers antigravity-cli in selectProvider', () => {
    const provider = selectProvider({ provider: 'antigravity-cli' });
    expect(provider.name).toBe('antigravity-cli');
  });
});
