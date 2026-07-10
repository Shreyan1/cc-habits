/**
 * Tests for cc-habits Patch 2, UserPromptSubmit active-habit injection.
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
import { storagePaths, serialiseMemories } from '../src/storage';
import {
  selectInjectionHabits, buildInjectionContext, processUserPromptSubmit,
  scoreMemoryRelevance, selectInjectionMemories, buildMemoryInjectionContext, tokenise,
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

const SEEDED_WITH_LANGS = `<!-- cc-habits format v0.2 -->
# Coding habits

## TypeScript
- Use explicit return types. Confidence: 0.80
  - Sessions seen: 3
  - Languages: ts

## Python  
- Use type hints on all functions. Confidence: 0.75
  - Sessions seen: 2
  - Languages: py

## Error Handling
- Wrap external I/O in try/catch. Confidence: 0.55
  - Sessions seen: 2
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-inject-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  fs.writeFileSync(storagePaths.habitsFile, SEEDED);
  delete process.env['CC_HABITS_INJECT'];
  delete process.env['CC_HABITS_MEMORIES'];
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  Object.assign(installPaths, origInstall);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['CC_HABITS_INJECT'];
  delete process.env['CC_HABITS_MEMORIES'];
});

describe('selectInjectionHabits', () => {
  it('returns active habits sorted by confidence, excluding the learning section', async () => {
    const sel = selectInjectionHabits(SEEDED);
    expect(sel.map(h => h.rule)).not.toContain('Prefer named imports');
    expect(sel[0].rule).toContain('camelCase'); // 0.90 first
    expect(sel[1].rule).toContain('explicit return types'); // 0.80
    expect(sel[2].rule).toContain('try/catch'); // 0.55
    expect(sel).toHaveLength(3);
  });

  it('honors the topN cap', async () => {
    expect(selectInjectionHabits(SEEDED, 2)).toHaveLength(2);
  });

  it('honors minConfidence', async () => {
    const sel = selectInjectionHabits(SEEDED, 12, 0.85);
    expect(sel).toHaveLength(1);
    expect(sel[0].rule).toContain('camelCase');
  });

  it('activeLanguages=["ts"] includes ts habits + language-agnostic, excludes py-only', async () => {
    const sel = selectInjectionHabits(SEEDED_WITH_LANGS, 12, 0.3, ['ts']);
    const rules = sel.map(h => h.rule);
    expect(rules).toContain('Use explicit return types');
    expect(rules).toContain('Wrap external I/O in try/catch');
    expect(rules).not.toContain('Use type hints on all functions');
  });

  it('activeLanguages=[] returns all habits (no filter)', async () => {
    const sel = selectInjectionHabits(SEEDED_WITH_LANGS, 12, 0.3, []);
    expect(sel).toHaveLength(3);
  });

  it('activeLanguages=undefined returns all habits (no filter)', async () => {
    const sel = selectInjectionHabits(SEEDED_WITH_LANGS, 12, 0.3, undefined);
    expect(sel).toHaveLength(3);
  });

  it('activeLanguages=["ts","py"] includes both ts and py habits', async () => {
    const sel = selectInjectionHabits(SEEDED_WITH_LANGS, 12, 0.3, ['ts', 'py']);
    expect(sel).toHaveLength(3);
  });
});

describe('buildInjectionContext', () => {
  it('wraps active habits in a <coding-habits> block grouped by category', async () => {
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

  it('returns null when there are no active habits', async () => {
    expect(buildInjectionContext('<!-- cc-habits format v0.2 -->\n# Coding habits\n')).toBeNull();
  });
});

describe('processUserPromptSubmit', () => {
  it('returns context by default', async () => {
    expect(await processUserPromptSubmit({ prompt: 'x' })).toContain('<coding-habits>');
  });

  it('returns null when CC_HABITS_INJECT is disabled', async () => {
    for (const v of ['0', 'false', 'off']) {
      process.env['CC_HABITS_INJECT'] = v;
      expect(await processUserPromptSubmit({ prompt: 'x' })).toBeNull();
    }
  });

  it('with ts signals in log, injects ts habits but not py-only habits', async () => {
    fs.writeFileSync(storagePaths.habitsFile!, SEEDED_WITH_LANGS);
    const signal = {
      ts: new Date().toISOString(),
      session_id: 'session-ts-1',
      type: 'edit',
      file: 'src/main.ts',
      diff: '+++ src/main.ts\n+const x: number = 1;',
      language: 'ts',
    };
    fs.appendFileSync(storagePaths.logFile!, JSON.stringify(signal) + '\n');

    const ctx = await processUserPromptSubmit({ prompt: 'hello', session_id: 'session-ts-1' });
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('TypeScript:');
    expect(ctx!).toContain('- Use explicit return types.');
    expect(ctx!).toContain('Error Handling:');
    expect(ctx!).toContain('- Wrap external I/O in try/catch.');
    expect(ctx!).not.toContain('Python:');
    expect(ctx!).not.toContain('Use type hints on all functions');
  });

  it('with no session_id, injects all habits (safe fallback)', async () => {
    fs.writeFileSync(storagePaths.habitsFile!, SEEDED_WITH_LANGS);
    const ctx = await processUserPromptSubmit({ prompt: 'hello' });
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('TypeScript:');
    expect(ctx!).toContain('Python:');
    expect(ctx!).toContain('Error Handling:');
  });
});

const SEEDED_MEMORIES = serialiseMemories({
  'Repeated mistakes': [
    {
      text: 'When editing settings.json, do not overwrite existing hook arrays',
      trigger: ['settings.json', 'hooks', 'install'],
      correction: 'Merge new hooks with existing hooks',
      confidence: 0.80,
      seen: 3,
      sessions_seen: 2,
    },
    {
      text: 'When updating parser fields, also update format spec and tests',
      trigger: ['parser', 'format', 'storage'],
      correction: 'Keep parser, spec, and tests in lockstep',
      confidence: 0.70,
      seen: 2,
      sessions_seen: 2,
    },
  ],
});

describe('scoreMemoryRelevance', () => {
  const memory = {
    text: 'test',
    trigger: ['settings.json', 'hooks'],
    confidence: 0.80,
    seen: 2,
    sessions_seen: 2,
  };

  it('returns 0 when no trigger terms match the prompt', async () => {
    expect(scoreMemoryRelevance(memory, 'refactor the parser module')).toBe(0);
  });

  it('returns positive score when trigger terms appear in prompt', async () => {
    expect(scoreMemoryRelevance(memory, 'edit the settings.json hooks array')).toBe(2);
  });

  it('returns 0 for a memory with no trigger terms', async () => {
    expect(scoreMemoryRelevance({ ...memory, trigger: [] }, 'anything')).toBe(0);
  });

  it('a shared regex cache reused across calls yields stable scores (no lastIndex state)', async () => {
    // The perf optimisation reuses one compiled RegExp across memories via a shared
    // cache. Because the matcher uses only the case-insensitive flag (no global /
    // sticky), .test() is stateless and reuse must never alter results. Score the
    // same term repeatedly through one cache and assert every call agrees.
    const cache = new Map<string, RegExp>();
    const mem = { ...memory, trigger: ['hooks'] };
    const hit = 'we need to install hooks today';
    const miss = 'refactor the parser module';
    expect(scoreMemoryRelevance(mem, hit, undefined, cache)).toBe(1);
    expect(scoreMemoryRelevance(mem, hit, undefined, cache)).toBe(1); // cache hit, same result
    expect(scoreMemoryRelevance(mem, miss, undefined, cache)).toBe(0);
    expect(scoreMemoryRelevance(mem, hit, undefined, cache)).toBe(1); // still correct after a miss
    // Cache matches the uncached path exactly.
    expect(scoreMemoryRelevance(mem, hit, undefined, cache)).toBe(scoreMemoryRelevance(mem, hit));
  });

  it('precomputed prompt tokens yield identical scores to the lazy path', async () => {
    // The perf optimisation passes a shared, prompt-level token set as the 3rd arg.
    // It must never change the score vs. the 2-arg lazy compute, including for the
    // Tier-3 multi-word (>= 2 token) trigger path that actually consumes the set.
    const multiWord = { ...memory, trigger: ['install hooks', 'parser module'] };
    const prompts = [
      'edit the settings.json hooks array',
      'we need to install hooks for the parser module today',
      'refactor the parser module carefully',
      'nothing relevant here at all',
    ];
    for (const p of prompts) {
      const lazy = scoreMemoryRelevance(multiWord, p);
      const shared = scoreMemoryRelevance(multiWord, p, tokenise(p));
      expect(shared).toBe(lazy);
    }
  });

  it('enforces word boundary matches and allows plural s', async () => {
    const mem1 = { ...memory, trigger: ['hook'] };
    expect(scoreMemoryRelevance(mem1, 'we are hooked')).toBe(0);
    expect(scoreMemoryRelevance(mem1, 'we need to install hooks')).toBe(1);
    expect(scoreMemoryRelevance(mem1, 'we need to install hook')).toBe(1);
  });

  it('ignores generic short verbs', async () => {
    const mem2 = { ...memory, trigger: ['get', 'use', 'install', 'settings.json'] };
    expect(scoreMemoryRelevance(mem2, 'get the settings.json and use it to install')).toBe(2);
  });

  it('synonym: db trigger matches database in prompt', async () => {
    const mem = { ...memory, trigger: ['db'] };
    expect(scoreMemoryRelevance(mem, 'configure the local database')).toBe(1);
  });

  it('synonym: database trigger matches db in prompt', async () => {
    const mem = { ...memory, trigger: ['database'] };
    expect(scoreMemoryRelevance(mem, 'configure the local db')).toBe(1);
  });

  it('synonym: err trigger matches error in prompt', async () => {
    const mem = { ...memory, trigger: ['err'] };
    expect(scoreMemoryRelevance(mem, 'an unexpected error occurred')).toBe(1);
  });

  it('token overlap: "null check" trigger matches "null-checking" in prompt', async () => {
    const mem = { ...memory, trigger: ['null check'] };
    expect(scoreMemoryRelevance(mem, 'ensure proper null-checking in the model')).toBe(1);
  });

  it('token overlap: "null check" trigger matches "null checking" in prompt', async () => {
    const mem = { ...memory, trigger: ['null check'] };
    expect(scoreMemoryRelevance(mem, 'ensure proper null checking in the model')).toBe(1);
  });

  it('token overlap: "error handling" trigger matches "error-handling" in prompt', async () => {
    const mem = { ...memory, trigger: ['error handling'] };
    expect(scoreMemoryRelevance(mem, 'review the error-handling patterns')).toBe(1);
  });

  it('no tier 3 for single-word trigger: "hook" does not match "hooked"', async () => {
    const mem = { ...memory, trigger: ['hook'] };
    expect(scoreMemoryRelevance(mem, 'we are hooked on this')).toBe(0);
  });
});

describe('selectInjectionMemories', () => {
  it('returns memories whose trigger terms match the prompt', async () => {
    const memories = selectInjectionMemories(SEEDED_MEMORIES, 'update settings.json hooks');
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories[0].trigger).toContain('settings.json');
  });

  it('returns at most 3 memories', async () => {
    const many = serialiseMemories({
      'Repeated mistakes': Array.from({ length: 6 }, (_, i) => ({
        text: `Mistake ${i}`,
        trigger: ['keyword'],
        correction: `Fix ${i}`,
        confidence: 0.70,
        seen: 2,
        sessions_seen: 2,
      })),
    });
    const result = selectInjectionMemories(many, 'use keyword everywhere');
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when no trigger terms match', async () => {
    const memories = selectInjectionMemories(SEEDED_MEMORIES, 'write a new React component');
    expect(memories).toHaveLength(0);
  });

  it('excludes candidate memories (sessions_seen < 2)', async () => {
    const withCandidate = serialiseMemories({
      'Repeated mistakes': [{
        text: 'Candidate mistake about settings.json',
        trigger: ['settings.json'],
        correction: 'Fix it',
        confidence: 0.50,
        seen: 1,
        sessions_seen: 1,
      }],
    });
    const memories = selectInjectionMemories(withCandidate, 'edit settings.json');
    expect(memories).toHaveLength(0);
  });
});

describe('buildMemoryInjectionContext', () => {
  it('wraps memories in a <coding-memories> block', async () => {
    const memories = selectInjectionMemories(SEEDED_MEMORIES, 'edit settings.json hooks');
    const ctx = buildMemoryInjectionContext(memories);
    expect(ctx).not.toBeNull();
    expect(ctx!).toContain('<coding-memories>');
    expect(ctx!).toContain('</coding-memories>');
    expect(ctx!).toContain('Merge new hooks');
  });

  it('returns null when memory list is empty', async () => {
    expect(buildMemoryInjectionContext([])).toBeNull();
  });
});

describe('processUserPromptSubmit with memories', () => {
  it('does not include memories context when CC_HABITS_MEMORIES is off', async () => {
    process.env['CC_HABITS_MEMORIES'] = '0';
    fs.writeFileSync(storagePaths.memoriesFile!, SEEDED_MEMORIES);
    const ctx = await processUserPromptSubmit({ prompt: 'edit settings.json hooks' });
    expect(ctx).not.toContain('<coding-memories>');
  });

  it('includes relevant memories when CC_HABITS_MEMORIES=1', async () => {
    process.env['CC_HABITS_MEMORIES'] = '1';
    fs.writeFileSync(storagePaths.memoriesFile!, SEEDED_MEMORIES);
    const ctx = await processUserPromptSubmit({ prompt: 'edit settings.json hooks' });
    expect(ctx).toContain('<coding-memories>');
    expect(ctx).toContain('overwrite existing hook arrays');
  });

  it('still returns habits context even when no memories match', async () => {
    process.env['CC_HABITS_MEMORIES'] = '1';
    fs.writeFileSync(storagePaths.memoriesFile!, SEEDED_MEMORIES);
    const ctx = await processUserPromptSubmit({ prompt: 'write a new React component' });
    expect(ctx).toContain('<coding-habits>');
    expect(ctx).not.toContain('<coding-memories>');
  });
});

describe('registerHooks (UserPromptSubmit)', () => {
  it('registers the UserPromptSubmit hook and is idempotent', async () => {
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
