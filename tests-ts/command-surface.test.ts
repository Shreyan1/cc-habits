import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { MENU_ITEMS } from '../src/menu';
import { nextSteps } from '../src/suggestions';

/*
 * Phase 3 of the command-surface cleanup: the interactive menu, the "Next:"
 * hints, and the static help all promote the same pipeline, init -> learn ->
 * view -> sync -> export/import, with status as an anytime health check.
 * These tests pin that ordering and regression-proof the hint renderer's
 * column-22 contract (see printNextSteps in src/index.ts) so a future hint
 * added without enough padding fails loudly instead of rendering mangled.
 */

// Every hint line the renderer treats as a colored "cch <cmd>" row must keep
// its description starting at or after column 22, the offset printNextSteps
// slices on. A gap narrower than that would chop the description mid-word.
function assertColumnContract(line: string): void {
  const gapIdx = line.search(/ {2,}/);
  expect(gapIdx, `expected a >=2-space column gap in: ${JSON.stringify(line)}`).toBeGreaterThan(-1);
  expect(gapIdx, `command text overflowed column 22 in: ${JSON.stringify(line)}`).toBeLessThanOrEqual(22);
  const gapLength = line.slice(gapIdx).match(/^ +/)![0].length;
  const descStart = gapIdx + gapLength;
  expect(descStart, `description started before column 22 in: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(22);
}

const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-cmdsurface-'));
  Object.assign(storagePaths, {
    habitsDir: tmpDir,
    habitsFile: path.join(tmpDir, 'habits.md'),
    preferencesFile: path.join(tmpDir, 'preferences.md'),
    memoriesFile: path.join(tmpDir, 'memories.md'),
    logFile: path.join(tmpDir, 'log.jsonl'),
    errorLog: path.join(tmpDir, 'error.log'),
    tombstonesFile: path.join(tmpDir, '.tombstones.json'),
    memoryTombstonesFile: path.join(tmpDir, '.memory-tombstones.json'),
    memoryIndexFile: path.join(tmpDir, '.memory-index.json'),
    snapshotFile: path.join(tmpDir, '.snapshot.json'),
    historyFile: path.join(tmpDir, '.history.jsonl'),
    provenanceFile: path.join(tmpDir, '.provenance.json'),
    updateCheckFile: path.join(tmpDir, '.update-check.json'),
    configFile: path.join(tmpDir, 'config.yml'),
  });
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('command surface: MENU_ITEMS pipeline order', () => {
  it('starts with the daily-flow pipeline in order: init, learn, view, sync, status', () => {
    const labels = MENU_ITEMS.slice(0, 5).map(item => item.label);
    expect(labels).toEqual(['init', 'learn', 'view', 'sync', 'status']);
  });

  it('contains an export entry for sharing habits', () => {
    const exportItem = MENU_ITEMS.find(item => item.label === 'export');
    expect(exportItem).toBeDefined();
    expect(exportItem?.args).toEqual(['export']);
  });

  it('keeps every original item, nothing removed', () => {
    const labels = MENU_ITEMS.map(item => item.label);
    const original = [
      'tools', 'learn', 'view', 'status', 'bootstrap', 'memories', 'sync',
      'log', 'diff', 'init', 'on', 'off', 'faq', 'help (all commands)',
    ];
    for (const label of original) {
      expect(labels).toContain(label);
    }
  });

  it('keeps the help entry last', () => {
    expect(MENU_ITEMS[MENU_ITEMS.length - 1]?.label).toBe('help (all commands)');
  });
});

describe('command surface: nextSteps hint coverage', () => {
  const pipelineCommands = ['init', 'learn', 'view', 'sync', 'capture'];

  it('returns a non-empty hint for each pipeline command', async () => {
    for (const command of pipelineCommands) {
      const steps = await nextSteps(command, []);
      expect(steps, `expected a hint for '${command}'`).toBeDefined();
      expect(steps!.length).toBeGreaterThan(0);
    }
  });

  it('export points at cch import on the receiving side', async () => {
    const steps = await nextSteps('export', []);
    expect(steps?.some(s => s.includes('cch import'))).toBe(true);
  });

  it('keeps the description column at or after 22 for every "cch " hint', async () => {
    const checked = [...pipelineCommands, 'status', 'on', 'off', 'bootstrap', 'export'];
    for (const command of checked) {
      const steps = (await nextSteps(command, [])) ?? [];
      for (const line of steps) {
        if (!line.startsWith('cch ')) continue;
        assertColumnContract(line);
      }
    }
  });
});
