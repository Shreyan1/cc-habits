/**
 * Phase 1 language surfacing: the normaliseLanguages / langTag helpers and the
 * `cch view habits [--lang]` rendering. Covers the happy path plus the unhappy
 * and broken inputs: missing/blank/duplicate/control-char languages, an
 * unmatched filter, and case-insensitive matching.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normaliseLanguages, langTag } from '../src/cli-ui';
import { renderHabitsView } from '../src/cli';
import { storagePaths } from '../src/storage';

// ── pure helpers ─────────────────────────────────────────────────────────────
describe('normaliseLanguages', () => {
  it('returns empty for undefined or empty', () => {
    expect(normaliseLanguages(undefined)).toEqual([]);
    expect(normaliseLanguages([])).toEqual([]);
  });

  it('lower-cases, trims, dedupes, and drops blanks', () => {
    expect(normaliseLanguages(['TS', ' ts ', 'Py', '', '   '])).toEqual(['ts', 'py']);
  });

  it('strips control characters from untrusted tokens', () => {
    expect(normaliseLanguages(['t\x07s', 'p\x1by'])).toEqual(['ts', 'py']);
  });

  it('caps each token length so a noisy signal cannot blow up the line', () => {
    const out = normaliseLanguages(['x'.repeat(50)]);
    expect(out[0]!.length).toBe(12);
  });
});

describe('langTag', () => {
  it('is empty when there are no languages', () => {
    expect(langTag(undefined)).toBe('');
    expect(langTag([])).toBe('');
    expect(langTag(['', '  '])).toBe('');
  });

  it('renders a dim middle-dot list', () => {
    expect(langTag(['ts', 'py'])).toContain('· ts, py');
  });

  it('caps the visible list at 4 and shows the overflow as +N', () => {
    const tag = langTag(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(tag).toContain('a, b, c, d');
    expect(tag).toContain('+2');
  });
});

// ── renderHabitsView --lang ──────────────────────────────────────────────────
describe('renderHabitsView language surfacing', () => {
  const orig = { ...storagePaths };
  let tmpDir: string;
  let out: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  const HABITS = `<!-- cc-habits format v0.3 -->
# Coding habits

## TypeScript

- [TypeScript] Use explicit return type annotations. Confidence: 0.80
  - Signal: 4 reinforcing, 0 contradicting
  - Sessions seen: 3
  - Languages: ts

## Python

- [Python] Prefer f-strings. Confidence: 0.75
  - Signal: 3 reinforcing, 0 contradicting
  - Sessions seen: 2
  - Languages: py
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-lang-'));
    storagePaths.habitsFile      = path.join(tmpDir, 'habits.md');
    storagePaths.memoriesFile    = path.join(tmpDir, 'memories.md');
    storagePaths.logFile         = path.join(tmpDir, 'log.jsonl');
    storagePaths.configFile      = path.join(tmpDir, 'config.yml');
    storagePaths.preferencesFile = path.join(tmpDir, 'preferences.md');
    fs.writeFileSync(storagePaths.habitsFile, HABITS);
    out = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });
  afterEach(() => {
    spy.mockRestore();
    Object.assign(storagePaths, orig);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows the observed-languages summary and per-habit tags with no filter', () => {
    expect(renderHabitsView()).toBe(0);
    const joined = out.join('');
    expect(joined).toContain('languages: py, ts');
    expect(joined).toContain('· ts');
    expect(joined).toContain('· py');
  });

  it('filters to a single language and hides the others', () => {
    renderHabitsView('ts');
    const joined = out.join('');
    expect(joined).toContain('explicit return type');
    expect(joined).not.toContain('f-strings');
    expect(joined).toContain('showing habits tagged');
  });

  it('matches case-insensitively', () => {
    renderHabitsView('TS');
    expect(out.join('')).toContain('explicit return type');
  });

  it('shows a friendly message and the observed list when nothing matches', () => {
    expect(renderHabitsView('go')).toBe(0);
    const joined = out.join('');
    expect(joined).toContain('No habits tagged');
    expect(joined).toContain('Observed: py, ts');
    expect(joined).not.toContain('explicit return type');
  });

  it('treats a blank --lang as no filter', () => {
    renderHabitsView('   ');
    const joined = out.join('');
    expect(joined).toContain('explicit return type');
    expect(joined).toContain('f-strings');
  });
});
