import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, readHabitsMd, parseHabits, readMemoriesMd, parseMemories } from '../src/storage';
import { memoriesEnabled } from '../src/config';
import { scanRepo } from '../src/repo-scan';
import * as extractor from '../src/extractor';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
const origEnv = process.env['CC_HABITS_DIR'];

let storeDir: string;
let repoDir: string;

const FAKE_HABITS = [
  { category: 'TypeScript', rule: 'Use explicit return type annotations on exported functions', decision: 'create', matched_habit_id: '', reasoning: 'Seen across files.' },
];
const FAKE_MEMORIES = [
  { section: 'Tooling and workflow', text: 'Run npm test before committing', trigger: ['commit', 'test'], correction: 'Always run the test suite first.' },
];

function pointStorageAt(dir: string): void {
  storagePaths.habitsDir = dir;
  storagePaths.habitsFile = path.join(dir, 'habits.md');
  storagePaths.memoriesFile = path.join(dir, 'memories.md');
  storagePaths.configFile = path.join(dir, 'config.yml');
  storagePaths.errorLog = path.join(dir, 'error.log');
  storagePaths.tombstonesFile = path.join(dir, '.tombstones.json');
  storagePaths.memoryTombstonesFile = path.join(dir, '.memory-tombstones.json');
  storagePaths.memoryIndexFile = path.join(dir, '.memory-index.json');
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-reposcan-store-'));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-reposcan-repo-'));
  process.env['CC_HABITS_DIR'] = storeDir;     // guard marker + defaultRoot()
  pointStorageAt(storeDir);

  // A usable provider must exist for the scan to run (it now gates on this before
  // printing any "analyzing..." line). The extractor itself is mocked, so no real
  // API call happens; this only satisfies hasUsableProvider().
  fs.writeFileSync(path.join(storeDir, 'config.yml'), 'provider: anthropic\nanthropic_api_key: test-key\n');

  // A small non-git repo: source files + an agent-instruction doc.
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function a(): number { return 1; }\n');
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export function b(): string { return "x"; }\n');
  fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# Project\nAlways run npm test before committing.\n');

  vi.mocked(extractor.extractHabitsFromRepo).mockResolvedValue(FAKE_HABITS as any);
  vi.mocked(extractor.extractMemoriesFromDocs).mockResolvedValue(FAKE_MEMORIES as any);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  if (origEnv === undefined) delete process.env['CC_HABITS_DIR'];
  else process.env['CC_HABITS_DIR'] = origEnv;
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('scanRepo', () => {
  it('infers habits from source and memories from docs, applied directly', async () => {
    const res = await scanRepo({ cwd: repoDir });

    expect(res.scanned).toBe(true);
    expect(res.filesAnalyzed).toBeGreaterThan(0);
    expect(res.docsAnalyzed).toBe(1);
    expect(res.habitsLearned).toBe(1);
    expect(res.memoriesLearned).toBe(1);

    expect(res.details).toBeDefined();
    expect(res.details?.learnedHabits).toHaveLength(1);
    expect(res.details?.learnedHabits[0].rule).toContain('explicit return type');
    expect(res.details?.learnedMemories).toHaveLength(1);
    expect(res.details?.learnedMemories[0]).toContain('npm test');

    const habits = parseHabits(readHabitsMd());
    const allRules = Object.values(habits).flat().map(h => h.rule);
    expect(allRules.some(r => /explicit return type/i.test(r))).toBe(true);

    const mems = parseMemories(readMemoriesMd());
    const allMems = Object.values(mems).flat().map(m => m.text);
    expect(allMems.some(t => /npm test/i.test(t))).toBe(true);
  });

  it('feeds source to the habits extractor and docs to the memories extractor', async () => {
    await scanRepo({ cwd: repoDir });

    const habitFiles = vi.mocked(extractor.extractHabitsFromRepo).mock.calls[0][0];
    expect(habitFiles.map(f => f.path)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
    // Docs must NOT be fed to the habits extractor.
    expect(habitFiles.some(f => f.path === 'CLAUDE.md')).toBe(false);

    const docFiles = vi.mocked(extractor.extractMemoriesFromDocs).mock.calls[0][0];
    expect(docFiles.map(f => f.path)).toContain('CLAUDE.md');
  });

  it('is guarded: a second scan of the same repo is skipped unless forced', async () => {
    await scanRepo({ cwd: repoDir });
    vi.mocked(extractor.extractHabitsFromRepo).mockClear();

    const second = await scanRepo({ cwd: repoDir });
    expect(second.scanned).toBe(false);
    expect(second.reason).toBe('already scanned');
    expect(extractor.extractHabitsFromRepo).not.toHaveBeenCalled();

    const forced = await scanRepo({ cwd: repoDir, force: true });
    expect(forced.scanned).toBe(true);
    expect(extractor.extractHabitsFromRepo).toHaveBeenCalled();
  });

  it('skips gracefully when the provider throws an auth/credential error mid-scan', async () => {
    vi.mocked(extractor.extractHabitsFromRepo).mockRejectedValueOnce(
      new Error('ANTHROPIC_API_KEY not set and not found in config.'),
    );
    const res = await scanRepo({ cwd: repoDir });
    expect(res.scanned).toBe(false);
    expect(res.reason).toBe('no LLM provider configured');
  });

  it('skips BEFORE any analysis when no usable provider is configured', async () => {
    // Overwrite the config so no provider has a credential. The scan must bail
    // out before calling the extractor, so the user never sees "analyzing..."
    // followed by a failure.
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\n');
    const res = await scanRepo({ cwd: repoDir });
    expect(res.scanned).toBe(false);
    expect(res.reason).toBe('no LLM provider configured');
    expect(extractor.extractHabitsFromRepo).not.toHaveBeenCalled();
  });

  it('treats a parked CLI provider as not usable and skips before analysis', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: codex-cli\n');
    const res = await scanRepo({ cwd: repoDir });
    expect(res.scanned).toBe(false);
    expect(res.reason).toBe('no LLM provider configured');
    expect(extractor.extractHabitsFromRepo).not.toHaveBeenCalled();
  });

  it('reports nothing to analyze for an empty directory', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-reposcan-empty-'));
    try {
      const res = await scanRepo({ cwd: empty });
      expect(res.scanned).toBe(false);
      expect(res.reason).toMatch(/no source files/i);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('bails out early when globally disabled', async () => {
    fs.writeFileSync(storagePaths.configFile, 'disabled: true\n');
    const res = await scanRepo({ cwd: repoDir });
    expect(res.scanned).toBe(false);
    expect(res.reason).toBe('globally disabled');
    expect(extractor.extractHabitsFromRepo).not.toHaveBeenCalled();
  });

  describe('confirm callback', () => {
    function setIsTTY(val: boolean | undefined): void {
      Object.defineProperty(process.stdin, 'isTTY', { value: val, writable: true, configurable: true });
    }
    const origIsTTY = process.stdin.isTTY;
    afterEach(() => { setIsTTY(origIsTTY); });

    it('proceeds when confirm resolves true', async () => {
      setIsTTY(true);
      const confirm = vi.fn().mockResolvedValue(true);
      const res = await scanRepo({ cwd: repoDir, confirm });
      expect(confirm).toHaveBeenCalledOnce();
      expect(res.scanned).toBe(true);
    });

    it('skips scan when confirm resolves false', async () => {
      setIsTTY(true);
      const confirm = vi.fn().mockResolvedValue(false);
      const res = await scanRepo({ cwd: repoDir, confirm });
      expect(confirm).toHaveBeenCalledOnce();
      expect(res.scanned).toBe(false);
      expect(res.reason).toBe('scan skipped by user');
      expect(extractor.extractHabitsFromRepo).not.toHaveBeenCalled();
    });
  });
});

describe('memoriesEnabled default', () => {
  it('defaults to ON when unset', () => {
    expect(memoriesEnabled()).toBe(true);
  });

  it('honors an explicit disable in config', () => {
    fs.writeFileSync(storagePaths.configFile, 'memories_enabled: false\n');
    expect(memoriesEnabled()).toBe(false);
  });
});

describe('prose page sampling (writer support)', () => {
  it('includes article .md files in the source sample, excluding instruction docs and README', async () => {
    fs.mkdirSync(path.join(repoDir, 'articles'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'articles', 'getting-started.md'), '# Get started\n\nYou can set up a workspace.\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Boilerplate\n');
    await scanRepo({ cwd: repoDir });
    const files = vi.mocked(extractor.extractHabitsFromRepo).mock.calls[0][0] as { path: string }[];
    const names = files.map(f => f.path);
    expect(names).toContain(path.join('articles', 'getting-started.md'));
    expect(names).not.toContain('README.md');
    expect(names).not.toContain('CLAUDE.md'); // handled by readDocFiles, not the source sample
  });
});
