/**
 * Cross-tool parity for Codex (and the other non-Claude sync-file tools).
 *
 * Claude's learn->inject loop is automatic because preferences.md is always
 * written and Claude reads it via an @import. Codex/Kimi read AGENTS.md, Gemini
 * reads GEMINI.md, Cline reads .clinerules - all written only by `syncTargets`,
 * which processStop runs only when `sync_targets` is configured. Before the fix
 * that key was never written, so those tools never got auto-refreshed habits.
 * These tests pin the fix: init records the registered tools' sync targets, and
 * the capture + inject mechanics match Claude.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { addSyncTargets } from '../src/config';
import { readSyncTargets, renderPortableBody } from '../src/sync';
import { parseHabits, storagePaths } from '../src/storage';
import { normalizeInput } from '../src/adapters';

describe('addSyncTargets: closes the auto-sync loop for non-Claude tools', () => {
  const orig = storagePaths.configFile;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-parity-'));
    storagePaths.configFile = path.join(dir, 'config.yml');
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nollama_model: x\n');
  });
  afterEach(() => {
    storagePaths.configFile = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty (the pre-fix default that left Codex stale)', () => {
    expect(readSyncTargets()).toEqual([]);
  });

  it('persists a registered tool target so processStop auto-sync fires', () => {
    addSyncTargets(['agents']); // Codex / Kimi channel
    expect(readSyncTargets()).toEqual(['agents']);
  });

  it('unions multiple tools and is idempotent on re-add', () => {
    addSyncTargets(['agents']);
    addSyncTargets(['gemini']);
    expect(readSyncTargets().sort()).toEqual(['agents', 'gemini']);
    addSyncTargets(['agents']); // re-running init must not drop gemini
    expect(readSyncTargets().sort()).toEqual(['agents', 'gemini']);
  });

  it('preserves a target the user added by hand', () => {
    fs.appendFileSync(storagePaths.configFile, 'sync_targets: cursor\n');
    addSyncTargets(['agents']);
    expect(readSyncTargets().sort()).toEqual(['agents', 'cursor']);
  });

  it('no-ops on an empty target list', () => {
    addSyncTargets([]);
    expect(readSyncTargets()).toEqual([]);
  });
});

describe('Codex capture + inject mechanics match Claude', () => {
  it('captures a Codex edit into the same normalized shape as Claude', () => {
    const payload = { tool_name: 'Edit', session_id: 's', tool_input: { file_path: 'a.ts', old_string: 'var x', new_string: 'const x: number = 1' } };
    const claude = normalizeInput(payload, 'claude-code');
    const codex = normalizeInput(payload, 'codex');
    expect(codex.filePath).toBe(claude.filePath);
    expect(codex.newContent).toBe(claude.newContent);
    expect(codex.source).toBe('codex');
    expect(claude.source).toBe('claude-code');
  });

  it('injects the identical body into AGENTS.md (Codex) and preferences.md (Claude)', () => {
    const md = `<!-- cc-habits format v0.3 -->
# Coding habits

## Typescript
- Use explicit return types. Confidence: 0.90
  - Signal: 4 reinforcing, 0 contradicting
  - Sessions seen: 3
`;
    // renderPortableBody is the single source for every sync target AND preferences.md.
    const body = renderPortableBody(parseHabits(md));
    expect(body).toContain('## Typescript');
    expect(body).toContain('- Use explicit return types.');
  });
});
