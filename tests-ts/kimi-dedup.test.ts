/**
 * Tests for registerKimiHooks() de-duplication.
 *
 * The Kimi adapter writes [[hooks]] blocks into a TOML config by appending. A
 * re-init after the resolved hook-binary path changed must REPLACE the prior
 * cc-habits blocks, not append a second copy (otherwise each edit fires twice).
 * It must also leave the user's own hook blocks untouched.
 *
 * Setup: a temp dir holding the Kimi config. Teardown: the temp dir is removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerKimiHooks } from '../src/install';

let tmpDir: string;
let cfg: string;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-kimi-'));
  cfg = path.join(tmpDir, 'config.toml');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('registerKimiHooks de-duplication', () => {
  it('keeps exactly one block per event when re-run with the same path', () => {
    registerKimiHooks(cfg, '/opt/bin/cc-habits-hook');
    registerKimiHooks(cfg, '/opt/bin/cc-habits-hook');
    const content = fs.readFileSync(cfg, 'utf-8');
    // 4 events → 4 cc-habits commands, not 8.
    expect(count(content, '--adapter kimi')).toBe(4);
  });

  it('replaces stale blocks when the binary path changes (no duplicates)', () => {
    registerKimiHooks(cfg, 'cc-habits-hook');               // bare (old)
    registerKimiHooks(cfg, '/opt/homebrew/bin/cc-habits-hook'); // absolute (new)
    const content = fs.readFileSync(cfg, 'utf-8');
    expect(count(content, '--adapter kimi')).toBe(4);
    expect(count(content, '/opt/homebrew/bin/cc-habits-hook')).toBe(4);
    // The stale bare-path entries are gone (no bare command line survives).
    expect(content).not.toMatch(/command = '"cc-habits-hook"/);
  });

  it('reports already-registered (no adds) on an identical re-run', () => {
    registerKimiHooks(cfg, '/opt/bin/cc-habits-hook');
    const second = registerKimiHooks(cfg, '/opt/bin/cc-habits-hook');
    expect(second).toEqual({ postAdded: false, stopAdded: false, promptAdded: false, sessionStartAdded: false });
  });

  it("preserves the user's own [[hooks]] block", () => {
    fs.writeFileSync(cfg, `\n[[hooks]]\nevent = 'PostToolUse'\ncommand = 'my-own-linter || true'\n`);
    registerKimiHooks(cfg, '/opt/bin/cc-habits-hook');
    const content = fs.readFileSync(cfg, 'utf-8');
    expect(content).toContain('my-own-linter || true');
    expect(count(content, '--adapter kimi')).toBe(4);
  });
});
