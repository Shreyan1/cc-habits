/**
 * Tests for the v0.7.x init UX fixes:
 *   Q1  Cursor line no longer claims a (nonexistent) VS Code extension, and frames
 *       Git capture as an action to enable, not an automatic promise.
 *   Q2  An already-present provider is offered as a choice, not silently assumed,
 *       and no "experimental" jargon leaks into the front-door flow. A PARKED CLI
 *       provider is never offered as a "keep" option.
 *   Q3  The flow never announces work it cannot do: the repo scan only runs (and
 *       only prints its warning / "analyzing..." line) when a provider can
 *       actually run it. No "analyzing with codex-cli" followed by "no provider".
 *   Q4  The no-provider scan-skip message points at a real configure command.
 *   Q5  The global Git hook prompt is skipped when it is already installed.
 *
 * cmdInit is too interactive (TTY prompts, LLM bootstrap) for a full integration
 * test, so the wiring fixes are asserted as source-level invariants (the same
 * approach as init.test.ts). The pure provider-verification gate and the
 * non-TTY reconfigureProviderMenu branch are exercised functionally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reconfigureProviderMenu, configureProvider, interactiveOllamaSetup } from '../src/cli-provider';
import { hasUsableProvider, isParkedProvider, resolveProviderLabel } from '../src/providers';
import { storagePaths } from '../src/storage';

const CLI_SRC = path.resolve(__dirname, '../src/cli.ts');
const SCAN_SRC = path.resolve(__dirname, '../src/repo-scan.ts');

function read(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

describe('Q1, Cursor capture line is honest', () => {
  it('does not claim a VS Code extension exists', () => {
    expect(read(CLI_SRC)).not.toContain('VS Code extension');
  });

  it('frames Git capture as an action to enable, not an automatic promise', () => {
    const line = read(CLI_SRC)
      .split('\n')
      .find(l => l.includes('Cursor has no hooks'));
    expect(line).toBeDefined();
    expect(line).toContain('Git capture');
    expect(line).toContain('below');
    // No present-tense claim that edits are already being captured.
    expect(line).not.toContain('are captured');
  });
});

describe('Q2, existing provider is a choice, not an assumption', () => {
  it('only offers "keep" for a genuinely usable provider', () => {
    const src = read(CLI_SRC);
    // The reconfigure menu is gated on hasUsableProvider(), so a parked CLI
    // provider falls through to setup rather than appearing as "Keep codex-cli".
    expect(src).toContain('} else if (hasUsableProvider()) {');
    expect(src).toContain('reconfigureProviderMenu(resolveProviderLabel()');
  });

  it('does not leak "experimental" jargon into the front-door init flow', () => {
    expect(read(CLI_SRC)).not.toContain('experimental, repo scan may not work');
  });
});

describe('Q3, nothing is announced before the provider is verified', () => {
  it('cmdInit derives providerReady from hasUsableProvider', () => {
    expect(read(CLI_SRC)).toContain('const providerReady = hasUsableProvider();');
  });

  it('the repo scan section only runs when a provider can run it', () => {
    const src = read(CLI_SRC);
    const scanIdx = src.indexOf('Scanning this repository for habits');
    expect(scanIdx).toBeGreaterThan(0);
    // The "Scanning..." line lives inside an `if (providerReady)` block.
    const before = src.slice(Math.max(0, scanIdx - 400), scanIdx);
    expect(before).toContain('if (providerReady)');
  });

  it('scanRepo verifies a usable provider BEFORE printing its warning', () => {
    const src = read(SCAN_SRC);
    const gateIdx = src.indexOf('if (!hasUsableProvider())');
    const warnIdx = src.indexOf('cc-habits repository scan warning');
    expect(gateIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(warnIdx);
  });
});

describe('hasUsableProvider / isParkedProvider, the verification gate', () => {
  const origStorage = { ...storagePaths };
  const origEnvDir = process.env['CC_HABITS_DIR'];
  const origAnthropic = process.env['ANTHROPIC_API_KEY'];
  const origForced = process.env['CC_HABITS_PROVIDER'];
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-usable-'));
    process.env['CC_HABITS_DIR'] = dir;
    storagePaths.configFile = path.join(dir, 'config.yml');
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CC_HABITS_PROVIDER'];
  });

  afterEach(() => {
    Object.assign(storagePaths, origStorage);
    if (origEnvDir === undefined) delete process.env['CC_HABITS_DIR']; else process.env['CC_HABITS_DIR'] = origEnvDir;
    if (origAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = origAnthropic;
    if (origForced === undefined) delete process.env['CC_HABITS_PROVIDER']; else process.env['CC_HABITS_PROVIDER'] = origForced;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags the parked CLI providers and treats them as not usable', () => {
    expect(isParkedProvider('codex-cli')).toBe(true);
    expect(isParkedProvider('claude-cli')).toBe(true);
    expect(isParkedProvider('gemini-cli')).toBe(true);
    expect(isParkedProvider('anthropic')).toBe(false);
    fs.writeFileSync(storagePaths.configFile, 'provider: codex-cli\n');
    expect(hasUsableProvider()).toBe(false);
    // A parked provider in config must resolve to 'none', never be named as if it
    // were the active provider, so status and the scan warning stay honest.
    expect(resolveProviderLabel()).toBe('none');
  });

  it('anthropic is usable only with a key', () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\n');
    expect(hasUsableProvider()).toBe(false);
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\nanthropic_api_key: sk-test\n');
    expect(hasUsableProvider()).toBe(true);
  });

  it('a configured Ollama counts as usable', () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nollama_model: llama3.2\n');
    expect(hasUsableProvider()).toBe(true);
  });
});

describe('configureProvider, writing a provider preserves unrelated config', () => {
  const origStorage = { ...storagePaths };
  const origEnvDir = process.env['CC_HABITS_DIR'];
  const origForced = process.env['CC_HABITS_PROVIDER'];
  const origAnthropic = process.env['ANTHROPIC_API_KEY'];
  let dir: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-cfgsave-'));
    process.env['CC_HABITS_DIR'] = dir;
    storagePaths.configFile = path.join(dir, 'config.yml');
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
    // configureProvider prints progress; silence it so test output stays clean.
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.assign(storagePaths, origStorage);
    if (origEnvDir === undefined) delete process.env['CC_HABITS_DIR']; else process.env['CC_HABITS_DIR'] = origEnvDir;
    if (origForced === undefined) delete process.env['CC_HABITS_PROVIDER']; else process.env['CC_HABITS_PROVIDER'] = origForced;
    if (origAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = origAnthropic;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a stale parked provider with the new one and keeps consent/memories', async () => {
    // A leftover parked provider, prior consent, and the memories flag all coexist.
    fs.writeFileSync(
      storagePaths.configFile,
      'provider: codex-cli\nconsent_given: 2026-01-01T00:00:00.000Z\nmemories_enabled: true\n',
    );

    // vitest stdin is not a TTY, so the ollama branch writes the default-model
    // config via key upserts rather than overwriting the whole file.
    await configureProvider('ollama', '✓', '~');

    const cfg = fs.readFileSync(storagePaths.configFile, 'utf-8');
    expect(cfg).toContain('provider: ollama');
    expect(cfg).not.toContain('codex-cli');             // stale parked value is gone
    expect(cfg).toContain('consent_given: 2026-01-01');  // unrelated keys preserved
    expect(cfg).toContain('memories_enabled: true');
    expect(hasUsableProvider()).toBe(true);
    expect(resolveProviderLabel()).toContain('ollama');
  });
});

describe('interactiveOllamaSetup, unreachable Ollama offers a retry', () => {
  const origFetch = global.fetch;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('bails once (no infinite loop) when unreachable in a non-TTY shell', async () => {
    // The retry prompt is TTY-gated; vitest stdin is not a TTY, so the loop must
    // exit once rather than spin forever on the default-yes retry answer.
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const result = await interactiveOllamaSetup('✓', '~');
    expect(result).toBeNull();
  });

  it('source: retries the connection in place instead of re-running init', () => {
    const src = read(path.resolve(__dirname, '../src/cli-provider.ts'));
    expect(src).toContain('Retry connecting to Ollama?');
    expect(src).toContain('if (ollamaOk) break;');
  });
});

describe('Q4, no-provider scan-skip points at a real command', () => {
  it('does not tell the user to "run `cch init`" from inside init', () => {
    const src = read(CLI_SRC);
    const line = src
      .split('\n')
      .find(l => l.includes('Repo scan skipped: no AI provider configured'));
    expect(line).toBeDefined();
    expect(line).toContain('cch init --provider anthropic');
    expect(line).not.toContain('(run `cch init`)');
  });
});

describe('Q3, repo scan shows progress before the LLM call', () => {
  it('prints an "Analyzing ... files" progress line', () => {
    const src = read(SCAN_SRC);
    expect(src).toContain('Analyzing ');
    // The line is emitted inside the interactive block, before extraction.
    const analyzingIdx = src.indexOf('Analyzing ');
    const extractIdx = src.indexOf('extractHabitsFromRepo(files');
    expect(analyzingIdx).toBeGreaterThan(0);
    expect(analyzingIdx).toBeLessThan(extractIdx);
  });
});

describe('Q5, global Git hook prompt is skipped when already installed', () => {
  it('checks the template hook file before prompting', () => {
    const src = read(CLI_SRC);
    expect(src).toContain('globalHookAlready');
    expect(src).toContain('Global Git template post-commit hook already installed');
  });
});

describe('reconfigureProviderMenu, non-interactive keeps the existing provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the provider and never blocks when stdin is not a TTY', async () => {
    // In vitest stdin is not a TTY, so promptChoice resolves null immediately
    // and the menu must fall through to keeping the existing provider.
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array): boolean => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write);

    await reconfigureProviderMenu('anthropic', '✓', '~');

    const out = writes.join('');
    expect(out).toContain('already has an AI provider configured');
    expect(out).toContain('Keep anthropic');
    expect(out).toContain('Switch to Ollama');
    expect(out).toContain('Keeping anthropic.');
  });

  it('keeps the provider and hides the redundant switch option if the current provider is Ollama', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array): boolean => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write);

    await reconfigureProviderMenu('ollama (gemma4:31b-cloud)', '✓', '~');

    const out = writes.join('');
    expect(out).toContain('already has an AI provider configured');
    expect(out).toContain('Keep ollama (gemma4:31b-cloud)');
    expect(out).not.toContain('Switch to Ollama');
    expect(out).toContain('Keeping ollama (gemma4:31b-cloud).');
  });
});
