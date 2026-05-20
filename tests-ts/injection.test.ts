/**
 * Tests for cc-habits Patch 2 — UserPromptSubmit active-habit injection.
 *
 * Static @import decays under context compaction (claude-code #19471, #9796); the
 * UserPromptSubmit hook re-injects the strongest active habits every prompt.
 *
 * Covers:
 *   - selectInjectionHabits: active-only, confidence-sorted, topN cap, minConfidence
 *   - buildInjectionContext: wraps in <coding-habits>, excludes learning, null when empty
 *   - processUserPromptSubmit: respects CC_HABITS_INJECT toggle
 *   - registerHooks: registers UserPromptSubmit idempotently
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import {
  selectInjectionHabits, buildInjectionContext, processUserPromptSubmit,
} from '../src/hook';
import { registerHooks, installPaths } from '../src/install';

const origStorage = { ...storagePaths };
const origInstall = { ...installPaths };
let tmpDir: string;

const SEEDED = `<!-- cc-habits format v0.2 -->
# Coding habits

## TypeScript

- Use explicit return types on exported functions. Confidence: 0.80
  - Sessions seen: 3

## Naming

- Use camelCase for variables. Confidence: 0.90
  - Sessions seen: 4

## Error Handling

- Wrap external I/O in try/catch. Confidence: 0.55
  - Sessions seen: 2

## Learning (not yet active)

- [Imports] Prefer named imports. Confidence: 0.50
  - Sessions seen: 1
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-inject-'));
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  fs.writeFileSync(storagePaths.habitsFile, SEEDED);
  delete process.env['CC_HABITS_INJECT'];
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['CC_HABITS_INJECT'];
});

describe('selectInjectionHabits', () => {
  it('returns active habits sorted by confidence, excluding the learning section', () => {
    const sel = selectInjectionHabits(SEEDED);
    expect(sel.map(h => h.rule)).not.toContain('Prefer named imports');
    expect(sel[0].rule).toContain('camelCase'); // 0.90 first
    expect(sel[1].rule).toContain('explicit return types'); // 0.80
    expect(sel[2].rule).toContain('try/catch'); // 0.55
    expect(sel).toHaveLength(3);
  });

  it('honors the topN cap', () => {
    expect(selectInjectionHabits(SEEDED, 2)).toHaveLength(2);
  });

  it('honors minConfidence', () => {
    const sel = selectInjectionHabits(SEEDED, 12, 0.85);
    expect(sel).toHaveLength(1);
    expect(sel[0].rule).toContain('camelCase');
  });
});

describe('buildInjectionContext', () => {
  it('wraps active habits in a <coding-habits> block grouped by category', () => {
    const ctx = buildInjectionContext(SEEDED);
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('<coding-habits>');
    expect(ctx!).toContain('</coding-habits>');
    expect(ctx!).toContain('Naming:');
    expect(ctx!).toContain('TypeScript:');
    expect(ctx!).toContain('- Use camelCase for variables.');
    expect(ctx!).not.toContain('Prefer named imports');
    expect(ctx!).not.toContain('Confidence:');
  });

  it('returns null when there are no active habits', () => {
    expect(buildInjectionContext('<!-- cc-habits format v0.2 -->\n# Coding habits\n')).toBeNull();
  });
});

describe('processUserPromptSubmit', () => {
  it('returns context by default', () => {
    expect(processUserPromptSubmit({ prompt: 'x' })).toContain('<coding-habits>');
  });

  it('returns null when CC_HABITS_INJECT is disabled', () => {
    for (const v of ['0', 'false', 'off']) {
      process.env['CC_HABITS_INJECT'] = v;
      expect(processUserPromptSubmit({ prompt: 'x' })).toBeNull();
    }
  });
});

describe('registerHooks (UserPromptSubmit)', () => {
  it('registers the UserPromptSubmit hook and is idempotent', () => {
    installPaths.settingsFile = path.join(tmpDir, 'settings.json');
    installPaths.claudeDir = tmpDir;

    const first = registerHooks('/path/to/cc-habits-hook');
    expect(first.promptAdded).toBe(true);

    const settings = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8'));
    const ups = settings.hooks.UserPromptSubmit;
    expect(Array.isArray(ups)).toBe(true);
    expect(ups).toHaveLength(1);
    expect(ups[0].hooks[0].command).toContain('user-prompt-submit');
    expect(ups[0].matcher).toBeUndefined();

    const second = registerHooks('/path/to/cc-habits-hook');
    expect(second.promptAdded).toBe(false);
    const settings2 = JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8'));
    expect(settings2.hooks.UserPromptSubmit).toHaveLength(1);
  });
});
