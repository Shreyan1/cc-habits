import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initMemoriesMd, readMemoriesMd, parseMemories, applyMemoryUpdates,
  addMemoryTombstone, isMemoryTombstoned, type MemoryCandidate,
} from '../src/storage';
import { selectInjectionMemories, buildMemoryInjectionContext, scoreMemoryRelevance } from '../src/hook';

const origStorage = { ...storagePaths };
let tmpDir: string;

// Explicit setup: isolate every run in a fresh temp store.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-mem-e2e-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.habitsDir = tmpDir;
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
  initMemoriesMd();
});

// Explicit teardown: restore paths and remove the temp store.
afterEach(() => {
  Object.assign(storagePaths, origStorage);
  delete process.env['CC_HABITS_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const candidate = (over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  section: 'Repeated mistakes',
  text: 'When fetching user data in api.ts, do not read properties without a null check',
  trigger: ['api.ts', 'fetch', 'user'],
  correction: 'Guard with if (!user) return before property access',
  ...over,
});

describe('memory feature end-to-end parity with habits', () => {
  it('new candidate lands in the Candidates quarantine, not active', () => {
    const added = applyMemoryUpdates([candidate()]);
    expect(added).toBe(1);
    const md = readMemoriesMd();
    expect(md).toContain('Candidates (not yet active)');
    const sections = parseMemories(md);
    const all = Object.values(sections).flat();
    expect(all).toHaveLength(1);
    expect(all[0].sessions_seen).toBe(1);
    expect(all[0].confidence).toBeCloseTo(0.5);
  });

  it('a second sighting reinforces and graduates the memory to active', () => {
    applyMemoryUpdates([candidate()]);
    const addedAgain = applyMemoryUpdates([candidate()]); // same text, second session
    expect(addedAgain).toBe(0); // reinforced, not newly created
    const sections = parseMemories(readMemoriesMd());
    const mem = Object.values(sections).flat()[0];
    expect(mem.sessions_seen).toBeGreaterThanOrEqual(2);
    expect(mem.seen).toBe(2);
    expect(mem.confidence).toBeCloseTo(0.6);
  });

  it('a second sighting reinforces and registers in updatedMemories', () => {
    const added: string[] = [];
    const updated: string[] = [];
    applyMemoryUpdates([candidate()], undefined, added, updated);
    expect(added).toHaveLength(1);
    expect(updated).toHaveLength(0);

    const added2: string[] = [];
    const updated2: string[] = [];
    applyMemoryUpdates([candidate()], undefined, added2, updated2);
    expect(added2).toHaveLength(0);
    expect(updated2).toHaveLength(1);
    expect(updated2[0]).toBe(candidate().text);
  });

  it('a graduated, relevant memory is injected; an irrelevant prompt is not matched', () => {
    applyMemoryUpdates([candidate()]);
    applyMemoryUpdates([candidate()]); // graduate it
    const md = readMemoriesMd();

    const relevant = selectInjectionMemories(md, 'please fetch the user from api.ts');
    expect(relevant).toHaveLength(1);
    const ctx = buildMemoryInjectionContext(relevant);
    expect(ctx).toContain('<coding-memories>');
    expect(ctx).toContain('null check');

    const irrelevant = selectInjectionMemories(md, 'update the CSS grid layout spacing');
    expect(irrelevant).toHaveLength(0);
  });

  it('a candidate (single session) is never injected even if relevant', () => {
    applyMemoryUpdates([candidate()]); // only one session -> stays candidate
    const relevant = selectInjectionMemories(readMemoriesMd(), 'fetch the user from api.ts');
    expect(relevant).toHaveLength(0);
  });

  it('a tombstoned memory is never re-learned and never injected', () => {
    const c = candidate();
    addMemoryTombstone(c.text);
    expect(isMemoryTombstoned(c.text)).toBe(true);
    const added = applyMemoryUpdates([c]);
    expect(added).toBe(0);
    const sections = parseMemories(readMemoriesMd());
    expect(Object.values(sections).flat()).toHaveLength(0);
  });

  it('keyword scoring respects word boundaries and ignores generic short verbs', () => {
    const mem = { text: 'x', trigger: ['api', 'use'], correction: '', confidence: 0.7, seen: 2, sessions_seen: 2 };
    expect(scoreMemoryRelevance(mem, 'call the api endpoint')).toBe(1); // 'api' matches, 'use' ignored
    expect(scoreMemoryRelevance(mem, 'rewrite the therapist module')).toBe(0); // no false 'api' substring hit
  });
});
