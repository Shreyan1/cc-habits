/**
 * Import and injection invariant tests.
 *
 * Covers the two "never break" invariants on the import path and their
 * defense-in-depth mirror on the per-prompt injection path:
 *   IMP-1  import never resurrects a tombstoned rule (exact match)
 *   IMP-2  import never resurrects a tombstoned rule (fuzzy reworded variant)
 *   IMP-3  untrusted import: new habits re-earn graduation (sessions_seen 1)
 *   IMP-4  untrusted import: merge never raises an existing habit's sessions_seen
 *   IMP-5  trusted import preserves the incoming habit history verbatim
 *   IMP-6  own-machine bundle round-trip is auto-trusted via the origin id
 *   IMP-7  foreign/origin-less bundles are untrusted by default
 *   IMP-8  import never resurrects a tombstoned memory
 *   INJ-1  selectInjectionHabits filters tombstoned rules even when habits.md
 *          still lists them as active (hand edit / import race)
 *   INJ-2  the tombstone read on injection is fail-open (missing file injects)
 *   MID-1  getMachineId persists a stable UUID with 0600 permissions
 *   NET-1  fetchProfile rejects past the redirect depth cap without a request
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initMemoriesMd, writeHabitsMd, readHabitsMd,
  serialiseHabits, parseHabits, serialiseMemories, readMemoriesMd,
  addTombstone, addMemoryTombstone, getMachineId,
} from '../src/storage';
import { importHabits, buildProfile, isOwnBundle, fetchProfile } from '../src/portable';
import { selectInjectionHabits } from '../src/hook';

// Test isolation ───────────────────────────────────────────────────────────
const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-impsec-'));
  const dir = path.join(tmpDir, 'habits');
  storagePaths.habitsDir = dir;
  storagePaths.habitsFile = path.join(dir, 'habits.md');
  storagePaths.memoriesFile = path.join(dir, 'memories.md');
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

// IMP-1 / IMP-2: tombstones survive imports ─────────────────────────────────
describe('import respects tombstones', () => {
  it('IMP-1: a tombstoned rule is skipped, not resurrected', () => {
    addTombstone('Always use tabs for indentation');
    const incoming = serialiseHabits({ Style: [habit('Always use tabs for indentation')] });
    const result = importHabits(incoming, { trusted: true });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(readHabitsMd()).not.toContain('Always use tabs');
  });

  it('IMP-2: a lightly reworded variant of a tombstoned rule is also skipped', () => {
    addTombstone('Always use tabs for indentation in every file');
    const incoming = serialiseHabits({
      Style: [habit('Always use tabs for indentation in every single file')],
    });
    const result = importHabits(incoming, { trusted: true });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('IMP-8: a tombstoned memory is not reimported from a full bundle', () => {
    initMemoriesMd();
    addMemoryTombstone('The staging database resets nightly');
    const memoriesMd = serialiseMemories({
      'Repeated mistakes': [{
        text: 'The staging database resets nightly',
        trigger: ['staging'],
        correction: 'do not test against it',
        confidence: 0.8,
        seen: 3,
        sessions_seen: 3,
      }],
    });
    const bundle = [
      '<!-- cc-habits profile', 'version: 0.0.0', 'contains: habits,memories', '-->',
      '<!-- BEGIN habits -->', serialiseHabits({}), '<!-- END habits -->',
      '<!-- BEGIN memories -->', memoriesMd, '<!-- END memories -->',
    ].join('\n');
    const result = importHabits(bundle, { trusted: true });
    expect(result.memoriesImported).toBe(0);
    expect(readMemoriesMd()).not.toContain('staging database');
  });
});

// IMP-3..7: graduation is earned locally unless the bundle is your own ──────
describe('import graduation trust', () => {
  it('IMP-3: untrusted new habits land with sessions_seen 1 (learning)', () => {
    const incoming = serialiseHabits({ TS: [habit('Prefer readonly arrays', 9, 0.9)] });
    const result = importHabits(incoming, { trusted: false });
    expect(result.added).toBe(1);
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0]!.sessions_seen).toBe(1);
    // And therefore it is not eligible for injection.
    expect(selectInjectionHabits(readHabitsMd()).map(h => h.rule)).not.toContain('Prefer readonly arrays');
  });

  it('IMP-4: untrusted merge never raises an existing sessions_seen', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode', 1, 0.5)] }));
    const incoming = serialiseHabits({ TS: [habit('Use strict mode', 99, 0.9)] });
    importHabits(incoming, { trusted: false });
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0]!.sessions_seen).toBe(1);
  });

  it('IMP-5: trusted import preserves incoming habit history', () => {
    const incoming = serialiseHabits({ TS: [habit('Use strict mode', 5, 0.85)] });
    importHabits(incoming, { trusted: true });
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0]!.sessions_seen).toBe(5);
  });

  it('IMP-6: an own-machine bundle round-trip is auto-trusted', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Use strict mode', 5, 0.85)] }));
    const bundle = buildProfile({ version: '0.0.0' });
    expect(isOwnBundle(bundle)).toBe(true);
    writeHabitsMd(serialiseHabits({})); // wipe, then re-import with no explicit opts
    importHabits(bundle);
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0]!.sessions_seen).toBe(5);
  });

  it('IMP-7: a bundle without an origin (or a foreign one) is untrusted', () => {
    const foreign = [
      '<!-- cc-habits profile', 'version: 0.0.0', 'contains: habits',
      'origin: 00000000-0000-4000-8000-000000000000', '-->',
      '<!-- BEGIN habits -->',
      serialiseHabits({ TS: [habit('Prefer readonly arrays', 9, 0.9)] }),
      '<!-- END habits -->',
    ].join('\n');
    expect(isOwnBundle(foreign)).toBe(false);
    importHabits(foreign);
    const cats = parseHabits(readHabitsMd());
    expect(cats['TS']![0]!.sessions_seen).toBe(1);
  });
});

// INJ: injection-side defense in depth ──────────────────────────────────────
describe('injection tombstone defense in depth', () => {
  it('INJ-1: a tombstoned rule still listed as active in habits.md is not injected', () => {
    const md = serialiseHabits({
      TS: [habit('Never use any', 5, 0.9), habit('Prefer const', 5, 0.9)],
    });
    writeHabitsMd(md);
    addTombstone('Never use any');
    const rules = selectInjectionHabits(readHabitsMd()).map(h => h.rule);
    expect(rules).not.toContain('Never use any');
    expect(rules).toContain('Prefer const');
  });

  it('INJ-2: fail-open, a missing tombstones file never blocks injection', () => {
    writeHabitsMd(serialiseHabits({ TS: [habit('Prefer const', 5, 0.9)] }));
    fs.rmSync(storagePaths.tombstonesFile, { force: true });
    expect(selectInjectionHabits(readHabitsMd()).map(h => h.rule)).toContain('Prefer const');
  });
});

// MID: machine id ───────────────────────────────────────────────────────────
describe('getMachineId', () => {
  it('MID-1: generates once, persists, and stays stable', () => {
    const first = getMachineId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getMachineId()).toBe(first);
    expect(fs.readFileSync(storagePaths.machineIdFile, 'utf-8').trim()).toBe(first);
  });

  it.skipIf(process.platform === 'win32')('MID-1b: the id file is written 0600', () => {
    getMachineId();
    expect(fs.statSync(storagePaths.machineIdFile).mode & 0o777).toBe(0o600);
  });
});

// NET: fetch guards ─────────────────────────────────────────────────────────
describe('fetchProfile guards', () => {
  it('NET-1: rejects past the redirect cap without touching the network', async () => {
    await expect(fetchProfile('https://example.invalid/profile.md', 4))
      .rejects.toThrow(/too many redirects/);
  });

  it('NET-2: still rejects non-https URLs', async () => {
    await expect(fetchProfile('http://example.invalid/profile.md'))
      .rejects.toThrow(/only https/);
  });
});
