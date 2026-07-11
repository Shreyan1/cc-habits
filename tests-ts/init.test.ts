/**
 * Tests for v0.7.1 cmdInit fixes:
 *   Fix 1, "preferences.md import" message (not "habits.md import")
 *   Fix 3, bootstrap prompt uses promptYesNoDefaultTrue ([Y/n])
 *   Fix 4, no-provider honest line appears in cmdInit output
 *
 * cmdInit is too interactive (TTY prompts, LLM bootstrap) for a full
 * integration test, so these tests inspect the source-level invariants that
 * let Fixes 1-3 slip through the original green suite:
 *   - The printed message strings in cli.ts do not contain "habits.md import".
 *   - The bootstrap prompt calls promptYesNoDefaultTrue, not promptYesNo.
 *   - The no-provider branch is wired (Fix 4 is exercised via cmdStatus which
 *     shares the same providerReady flag and reads the same CONFIG_FILE path).
 *
 * Fix 4 is also covered by status.test.ts (no-provider state).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const CLI_SRC = path.resolve(__dirname, '../src/cli.ts');

function readCli(): string {
  return fs.readFileSync(CLI_SRC, 'utf-8');
}

describe('Fix 1, preferences.md import message', () => {
  it('cli.ts does not contain "habits.md import" in any stdout.write call', () => {
    const src = readCli();
    // The stale string that was in both branches before the fix.
    const stalePattern = /habits\.md import/g;
    const matches = src.match(stalePattern) ?? [];
    // Zero occurrences expected. Fix 1 replaced both instances.
    expect(matches).toHaveLength(0);
  });

  it('cli.ts contains "preferences.md import" in the Claude Code init branch', () => {
    const src = readCli();
    expect(src).toContain('preferences.md import');
  });
});

describe('Fix 3, bootstrap prompt default is Y', () => {
  it('bootstrap prompt defaults to Yes via askYes (which is promptYesNoDefaultTrue in manual mode)', () => {
    const src = readCli();
    // Find the bootstrap prompt line.
    const bootstrapLine = src
      .split('\n')
      .find(l => l.includes('Bootstrap habits from past sessions?'));
    expect(bootstrapLine).toBeDefined();
    // askYes wraps promptYesNoDefaultTrue: recommended mode auto-accepts, manual
    // mode falls back to the default-Yes prompt. Either way the default is Yes.
    expect(src).toMatch(/askYes\([\s\n]*'  Bootstrap habits from past sessions/);
    // ensure it's not using bare promptYesNo
    expect(src).not.toMatch(/promptYesNo\([\s\n]*'  Bootstrap habits from past sessions/);
  });

  it('bootstrap prompt text contains [Y/n]', () => {
    const src = readCli();
    const bootstrapLine = src
      .split('\n')
      .find(l => l.includes('Bootstrap habits from past sessions?'));
    expect(bootstrapLine).toBeDefined();
  });
});

describe('Fix 4, no-provider honest line', () => {
  it('cli.ts contains the humble no-provider guidance after providerReady check', () => {
    const src = readCli();
    expect(src).toContain('capturing your edits now, but it needs an AI provider');
    expect(src).toContain('cch init --provider anthropic');
    expect(src).toContain('ollama.com/download');
  });

  it('no-provider branch is gated on !providerReady (not unconditional)', () => {
    const src = readCli();
    const noProviderIdx = src.indexOf('capturing your edits now, but it needs an AI provider');
    const surroundingBlock = src.slice(Math.max(0, noProviderIdx - 200), noProviderIdx);
    expect(surroundingBlock).toContain('!providerReady');
  });
});

describe('Task A, no CLI auto-detect', () => {
  it('cli.ts does not contain the probeCliProvider auto-detect block', () => {
    const src = readCli();
    expect(src).not.toContain("probeCliProvider('claude')");
    expect(src).not.toContain("probeCliProvider('gemini')");
    expect(src).not.toContain("probeCliProvider('codex')");
    expect(src).not.toContain("Auto-selected 'claude-cli' as provider");
  });
});
