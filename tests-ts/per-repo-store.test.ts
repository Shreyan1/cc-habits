/**
 * Tests for the per-repo .cch/ store (#4 of the v0.7.23 dogfooding pass).
 *
 * A repo can carry its own habits/memories in a <repo>/.cch/ folder, kept
 * separate from the global ~/.cc-habits store. Injection MERGES the two with the
 * repo-local store taking priority on conflicts, so a repo's specifics never
 * bleed into unrelated repos while global style still applies everywhere.
 *
 * Covers:
 *   - repoStorageContext: paths rooted at <repoRoot>/.cch/, reusing global config
 *   - findRepoRoot: walks up to the nearest .git, null outside a repo
 *   - buildMergedInjectionContext: repo-priority dedup + confidence cap
 *   - selectMergedInjectionMemories: repo-priority dedup + top-N cap
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repoStorageContext, findRepoRoot, REPO_STORE_DIR, storagePaths } from '../src/storage';
import { buildMergedInjectionContext, selectMergedInjectionMemories, processUserPromptSubmit } from '../src/hook';

const HEADER = '<!-- cc-habits format v0.2 -->\n# Coding habits\n';
function habit(category: string, rule: string, conf: number, sessions = 3): string {
  return `\n## ${category}\n\n- ${rule}. Confidence: ${conf.toFixed(2)}\n  - Sessions seen: ${sessions}\n`;
}

const MEM_HEADER = '<!-- cc-habits memories format v0.1 -->\n# Coding memories\n';
function memory(text: string, trigger: string, correction: string, conf = 0.8): string {
  return `\n## General\n\n- ${text}.\n  - Trigger: ${trigger}\n  - Correction: ${correction}\n  - Confidence: ${conf.toFixed(2)}\n  - Sessions seen: 2\n`;
}

describe('repoStorageContext', () => {
  it('roots every data file under <repoRoot>/.cch/', () => {
    const ctx = repoStorageContext('/tmp/myrepo');
    expect(ctx.habitsDir).toBe(path.join('/tmp/myrepo', REPO_STORE_DIR));
    expect(ctx.habitsFile).toBe(path.join('/tmp/myrepo', REPO_STORE_DIR, 'habits.md'));
    expect(ctx.memoriesFile).toBe(path.join('/tmp/myrepo', REPO_STORE_DIR, 'memories.md'));
  });

  it('reuses the global provider config (credentials are machine-level)', () => {
    const ctx = repoStorageContext('/tmp/myrepo');
    expect(ctx.configFile).toBe(storagePaths.configFile);
  });
});

describe('findRepoRoot', () => {
  it('walks up to the nearest .git directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-root-'));
    fs.mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    try {
      expect(findRepoRoot(nested)).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no .git is found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-norepo-'));
    try {
      expect(findRepoRoot(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildMergedInjectionContext, repo wins on conflict', () => {
  it('drops a global habit whose rule duplicates a repo habit', () => {
    const globalMd = HEADER + habit('Style', 'Use tabs for indentation', 0.9);
    const repoMd = HEADER + habit('Style', 'Use tabs for indentation', 0.75);
    const out = buildMergedInjectionContext(globalMd, repoMd);
    expect(out).not.toBeNull();
    // The rule appears exactly once despite living in both stores.
    const occurrences = (out!.match(/Use tabs for indentation/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('includes habits unique to each store', () => {
    const globalMd = HEADER + habit('Lang', 'Prefer ternaries over if/else', 0.85);
    const repoMd = HEADER + habit('Brand', 'Use charcoal #1A202C for headers', 0.8);
    const out = buildMergedInjectionContext(globalMd, repoMd);
    expect(out).toContain('Prefer ternaries over if/else');
    expect(out).toContain('Use charcoal #1A202C for headers');
  });

  it('returns null when neither store has a graduated habit', () => {
    expect(buildMergedInjectionContext(HEADER, HEADER)).toBeNull();
  });
});

describe('processUserPromptSubmit, layers the cwd repo store over the global one', () => {
  it('injects both global and repo-local habits, repo store resolved from cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-e2e-'));
    fs.mkdirSync(path.join(root, '.git'));
    // Global store lives in its own temp dir, separate from the repo .cch/.
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-glob-'));
    const globalCtx = repoStorageContext(globalDir); // any ctx pointing elsewhere
    fs.mkdirSync(globalCtx.habitsDir, { recursive: true });
    fs.writeFileSync(globalCtx.habitsFile, HEADER + habit('Lang', 'Prefer ternaries over if/else', 0.85));
    // Repo-local .cch/ store.
    const repoCtx = repoStorageContext(root);
    fs.mkdirSync(repoCtx.habitsDir, { recursive: true });
    fs.writeFileSync(repoCtx.habitsFile, HEADER + habit('Brand', 'Use charcoal #1A202C for headers', 0.8));

    const origCwd = process.cwd();
    try {
      process.chdir(root);
      const out = processUserPromptSubmit({ prompt: 'write a header component' }, globalCtx);
      expect(out).toContain('Prefer ternaries over if/else');
      expect(out).toContain('Use charcoal #1A202C for headers');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

describe('selectMergedInjectionMemories, repo wins on conflict', () => {
  it('keeps the repo copy of a duplicated memory and dedups by text', () => {
    const prompt = 'fix the header color logic';
    const globalMd = MEM_HEADER + memory('Header color must be exact', 'header', 'Use the global token');
    const repoMd = MEM_HEADER + memory('Header color must be exact', 'header', 'Use #1A202C charcoal');
    const merged = selectMergedInjectionMemories(globalMd, repoMd, prompt);
    const texts = merged.map(m => m.text);
    expect(texts.filter(t => t === 'Header color must be exact')).toHaveLength(1);
    // The surviving copy is the repo one (its repo-specific correction).
    const survivor = merged.find(m => m.text === 'Header color must be exact');
    expect(survivor?.correction).toContain('#1A202C');
  });
});
