/**
 * Export bundling and attribution tests.
 *
 * `cch export` bundles habits + memories by default (the least complicated
 * share is one complete file), with --habits-only as the opt-out. Every bundle
 * carries one promo line under the envelope, and every synced project file
 * carries one attribution comment inside its managed block. preferences.md,
 * which feeds prompts directly, must stay free of both.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initMemoriesMd, writeHabitsMd, writeMemoriesMd,
  serialiseHabits, serialiseMemories, parseHabits, readHabitsMd,
} from '../src/storage';
import { buildProfile, exportHabits, importHabits } from '../src/portable';
import { mergeBlock, syncTargets, writePreferencesFile, ATTRIBUTION_LINE, BEGIN_MARKER } from '../src/sync';

const PROMO_URL = 'https://github.com/Shreyan1/cc-habits';

// Test isolation ───────────────────────────────────────────────────────────
const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-expbundle-'));
  const dir = path.join(tmpDir, 'habits');
  storagePaths.habitsDir = dir;
  storagePaths.habitsFile = path.join(dir, 'habits.md');
  storagePaths.memoriesFile = path.join(dir, 'memories.md');
  storagePaths.preferencesFile = path.join(dir, 'preferences.md');
  storagePaths.logFile = path.join(dir, 'log.jsonl');
  storagePaths.errorLog = path.join(dir, 'error.log');
  storagePaths.tombstonesFile = path.join(dir, '.tombstones.json');
  storagePaths.memoryTombstonesFile = path.join(dir, '.memory-tombstones.json');
  storagePaths.snapshotFile = path.join(dir, '.snapshot.json');
  storagePaths.machineIdFile = path.join(dir, '.machine-id');
  storagePaths.configFile = path.join(dir, 'config.yml');
  initHabitsMd();
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const habit = (rule: string, sessions = 4, confidence = 0.8) => ({
  rule, confidence, reinforcing: 5, contradicting: 0, sessions_seen: sessions,
});

const oneMemory = () => serialiseMemories({
  'Repeated mistakes': [{
    text: 'The staging database resets nightly',
    trigger: ['staging'],
    correction: 'do not test against it',
    confidence: 0.8,
    seen: 3,
    sessions_seen: 3,
  }],
});

// Bundling defaults ─────────────────────────────────────────────────────────
describe('export bundles everything by default', () => {
  it('includes memories without any flag when memories exist', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    initMemoriesMd();
    writeMemoriesMd(oneMemory());
    const bundle = buildProfile({ version: '0.0.0' });
    expect(bundle).toContain('contains: habits,memories');
    expect(bundle).toContain('<!-- BEGIN memories -->');
    expect(bundle).toContain('staging database');
  });

  it('omits the memories section when there are no memories to share', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    const bundle = buildProfile({ version: '0.0.0' });
    expect(bundle).toContain('contains: habits');
    expect(bundle).not.toContain('<!-- BEGIN memories -->');
  });

  it('--habits-only excludes memories even when they exist', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    initMemoriesMd();
    writeMemoriesMd(oneMemory());
    const bundle = buildProfile({ version: '0.0.0', habitsOnly: true });
    expect(bundle).toContain('contains: habits');
    expect(bundle).not.toContain('<!-- BEGIN memories -->');
    expect(bundle).not.toContain('staging database');
  });

  it('the legacy exportHabits stays habits-only, as its name promises', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    initMemoriesMd();
    writeMemoriesMd(oneMemory());
    expect(exportHabits()).not.toContain('<!-- BEGIN memories -->');
  });
});

// Promo line ────────────────────────────────────────────────────────────────
describe('bundle promo line', () => {
  it('every bundle carries the promo line under the envelope', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    const bundle = buildProfile({ version: '0.0.0' });
    expect(bundle).toContain(PROMO_URL);
    expect(bundle).toContain('cch import');
    // Outside the sections: before BEGIN habits, after the envelope close.
    expect(bundle.indexOf(PROMO_URL)).toBeLessThan(bundle.indexOf('<!-- BEGIN habits -->'));
  });

  it('the promo line never leaks into the imported habits', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode', 5, 0.85)] }));
    const bundle = buildProfile({ version: '0.0.0' });
    writeHabitsMd(serialiseHabits({}));
    const result = importHabits(bundle); // own bundle, auto-trusted round-trip
    expect(result.added).toBe(1);
    const md = readHabitsMd();
    expect(md).not.toContain(PROMO_URL);
    const cats = parseHabits(md);
    expect(cats['TS']![0]!.rule).toBe('Use strict mode');
  });
});

// Sync attribution ──────────────────────────────────────────────────────────
describe('sync attribution line', () => {
  it('mergeBlock places one attribution comment inside the block', () => {
    const out = mergeBlock('# My Project\n', 'BODY');
    expect(out).toContain(ATTRIBUTION_LINE);
    expect(out.indexOf(ATTRIBUTION_LINE)).toBeGreaterThan(out.indexOf(BEGIN_MARKER));
  });

  it('re-syncing replaces the attribution instead of accumulating it', () => {
    const first = mergeBlock('# Doc\n', 'BODY-1');
    const second = mergeBlock(first, 'BODY-2');
    const count = second.split(ATTRIBUTION_LINE).length - 1;
    expect(count).toBe(1);
  });

  it('the cursor .mdc target carries the attribution too', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    const proj = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const result = syncTargets(['cursor'], { baseDir: proj });
    expect(result.skipped).toBe(false);
    const mdc = fs.readFileSync(path.join(proj, '.cursor', 'rules', 'cc-habits.mdc'), 'utf-8');
    expect(mdc).toContain(ATTRIBUTION_LINE);
  });

  it('preferences.md stays free of promo and attribution (it feeds prompts)', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode')] }));
    writePreferencesFile();
    const prefs = fs.readFileSync(storagePaths.preferencesFile, 'utf-8');
    expect(prefs).toContain('Use strict mode');
    expect(prefs).not.toContain(PROMO_URL);
    expect(prefs).not.toContain(ATTRIBUTION_LINE);
  });
});
