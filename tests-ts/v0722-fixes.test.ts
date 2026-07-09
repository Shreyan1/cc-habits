/**
 * Tests for the v0.7.22 dogfooding fixes:
 *   #12  cch init wires the preferences.md @import whenever Claude Code is
 *        present, independent of the capture-hooks Y/n choice.
 *   #6   Ctrl+C / q / Esc out of `cch help` exits cleanly instead of bouncing
 *        back to the folded main menu.
 *   #5   `status` is present in the full-command (`cch help`) reference.
 *   #3   checkProviderReady() is a real network-aware pre-flight: it passes
 *        non-Ollama providers through and reports an unreachable Ollama with an
 *        actionable suggestion BEFORE any scan announces work.
 *
 * cmdInit and the interactive menus are too TTY-bound for a full integration
 * test, so #12/#6/#5 are asserted as source-level invariants (the same style as
 * init.test.ts). #3 is exercised behaviorally against a dead Ollama URL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { checkProviderReady } from '../src/providers';
import { renderHabitLine, renderMemoryLine } from '../src/cli-ui';

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
  return chunks.join('');
}

const CLI_SRC = path.resolve(__dirname, '../src/cli.ts');
const INDEX_SRC = path.resolve(__dirname, '../src/index.ts');
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

describe('#12, init wires the @import independent of the capture-hooks choice', () => {
  it('addImportToClaudeMd is no longer nested inside the `if (register)` block', () => {
    const src = read(CLI_SRC);
    const branch = src.slice(
      src.indexOf('tool.id === "claude-code"'),
      src.indexOf('tool.id === "gemini"'),
    );
    const proofIdx = branch.indexOf('printHookProof("claude-code"');
    const importIdx = branch.indexOf('addImportToClaudeMd()');
    expect(proofIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(proofIdx);
    // A closing brace between the hook-proof line (last line of the register
    // block) and the import call proves the import sits OUTSIDE `if (register)`.
    expect(branch.slice(proofIdx, importIdx)).toContain('}');
  });

  it('documents why injection runs regardless of the hooks answer', () => {
    expect(read(CLI_SRC)).toContain('Injection is independent of capture');
  });
});

describe('#6 / #5, the full-command (cch help) menu', () => {
  it('cancelling (null) exits cleanly instead of returning to the main menu', () => {
    const src = read(INDEX_SRC);
    expect(src).toMatch(/if \(!selectedHelp\)\s*\{\s*process\.exit\(0\)/);
    // "Back to main menu" is the only path that returns to the folded menu.
    expect(src).toContain("if (selectedHelp.value === 'back')");
  });

  it('lists `status` in the full command reference', () => {
    expect(read(INDEX_SRC)).toContain("Show setup health and current activity', args: ['status']");
  });
});

describe('#8, compact one-line renderers', () => {
  it('renders a habit on a single line with %, rule, downvote, and id', () => {
    const out = captureStdout(() => renderHabitLine(
      { rule: 'Use ternaries over if/else', confidence: 0.8, reinforcing: 4, contradicting: 1, sessions_seen: 3, languages: ['ts'] },
      false,
    ));
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    expect(out).toContain('80%');
    expect(out).toContain('Use ternaries over if/else');
    expect(out).toContain('↓1');
    expect(out).toMatch(/\[cch[a-f0-9]{8}\]/);
  });

  it('renders a memory on a single line with the correction arrow', () => {
    const out = captureStdout(() => renderMemoryLine(
      { text: 'Avoid em-dashes', trigger: ['dash'], correction: 'Use commas', confidence: 0.6, seen: 2, sessions_seen: 2, last_seen: '2026-06-23' } as never,
      false,
    ));
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    expect(out).toContain('Avoid em-dashes');
    expect(out).toContain('→ Use commas');
  });
});

describe('#3, checkProviderReady pre-flight', () => {
  const origDir = process.env['CC_HABITS_DIR'];
  const origProvider = process.env['CC_HABITS_PROVIDER'];
  const origUrl = process.env['CC_HABITS_OLLAMA_URL'];
  const origModel = process.env['CC_HABITS_OLLAMA_MODEL'];
  const origConfigFile = storagePaths.configFile;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-readiness-'));
    process.env['CC_HABITS_DIR'] = dir;
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['CC_HABITS_OLLAMA_URL'];
    delete process.env['CC_HABITS_OLLAMA_MODEL'];
    storagePaths.configFile = path.join(dir, 'config.yml');
  });

  afterEach(() => {
    storagePaths.configFile = origConfigFile;
    if (origDir === undefined) delete process.env['CC_HABITS_DIR']; else process.env['CC_HABITS_DIR'] = origDir;
    if (origProvider === undefined) delete process.env['CC_HABITS_PROVIDER']; else process.env['CC_HABITS_PROVIDER'] = origProvider;
    if (origUrl === undefined) delete process.env['CC_HABITS_OLLAMA_URL']; else process.env['CC_HABITS_OLLAMA_URL'] = origUrl;
    if (origModel === undefined) delete process.env['CC_HABITS_OLLAMA_MODEL']; else process.env['CC_HABITS_OLLAMA_MODEL'] = origModel;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a non-Ollama provider through without touching the network', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\nanthropic_api_key: test-key\n');
    const r = await checkProviderReady();
    expect(r.ok).toBe(true);
  });

  it('reports an unreachable Ollama daemon with an actionable suggestion', async () => {
    // 127.0.0.1:1 is a privileged, unused port: the connection is refused fast.
    fs.writeFileSync(
      storagePaths.configFile,
      'provider: ollama\nollama_url: http://127.0.0.1:1\nollama_model: llama3.2\n',
    );
    const r = await checkProviderReady();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not reachable/i);
    expect(r.suggestion).toMatch(/ollama serve/i);
  });
});
