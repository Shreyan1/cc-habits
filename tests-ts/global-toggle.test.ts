import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Override storagePaths before importing modules so they write to a temporary sandbox
import { storagePaths, getRuleHash, serialiseHabits, writeHabitsMd } from '../src/storage';

let tmpDir: string;
const origPaths = { ...storagePaths };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-toggle-test-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  storagePaths.tombstonesFile = path.join(tmpDir, '.tombstones.json');
  storagePaths.snapshotFile = path.join(tmpDir, '.snapshot.json');
  storagePaths.historyFile = path.join(tmpDir, '.history.jsonl');
  storagePaths.provenanceFile = path.join(tmpDir, '.provenance.json');
});

afterEach(() => {
  Object.assign(storagePaths, origPaths);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

import { isGloballyDisabled, setGloballyDisabled } from '../src/config';
import { captureDisabled, processSessionStart, processUserPromptSubmit } from '../src/hook';
import { cmdOn, cmdOff, cmdTombstone } from '../src/cli';
import { nextSteps } from '../src/suggestions';
import { addTombstone } from '../src/storage';

describe('Global Enable/Disable Toggle', () => {
  it('toggles disabled flag in config.yml correctly', async () => {
    expect(isGloballyDisabled()).toBe(false);

    await setGloballyDisabled(true);
    expect(isGloballyDisabled()).toBe(true);

    const configContent = fs.readFileSync(storagePaths.configFile, 'utf-8');
    expect(configContent).toContain('disabled: true');

    await setGloballyDisabled(false);
    expect(isGloballyDisabled()).toBe(false);
  });

  it('runs cmdOn and cmdOff CLI commands successfully', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const resOff = await cmdOff();
    expect(resOff).toBe(0);
    expect(isGloballyDisabled()).toBe(true);
    expect(stdoutSpy.mock.calls.some(args => args[0].toString().includes('disabled'))).toBe(true);

    stdoutSpy.mockClear();
    const resOn = await cmdOn();
    expect(resOn).toBe(0);
    expect(isGloballyDisabled()).toBe(false);
    expect(stdoutSpy.mock.calls.some(args => args[0].toString().includes('enabled'))).toBe(true);
  });

  it('respects global disabled state across capture and injection hooks', async () => {
    // When enabled (default)
    expect(await captureDisabled()).toBe(false);

    const fakePromptPayload = { prompt: 'write some code' };
    // Should return habits-context XML tag or null depending on if habits exist
    const resPromptEnabled = await processUserPromptSubmit(fakePromptPayload);

    // Disable globally
    await setGloballyDisabled(true);

    // Capture should be blocked
    expect(await captureDisabled()).toBe(true);

    // Prompt injection should be blocked (return null immediately)
    const resPromptDisabled = await processUserPromptSubmit(fakePromptPayload);
    expect(resPromptDisabled).toBeNull();

    // Session Start check should be blocked (return null immediately)
    const resStartDisabled = processSessionStart();
    expect(resStartDisabled).toBeNull();
  });
});

describe('Simplified cmdTombstone', () => {
  it('delegates to cmdTombstones to list rules when no arguments are provided', async () => {
    addTombstone('Block rule A');
    addTombstone('Block rule B');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    
    // Call cmdTombstone with empty string
    const res = cmdTombstone('');
    expect(res).toBe(0);

    const output = stdoutSpy.mock.calls.map(args => args[0].toString()).join('');
    expect(output).toContain('block rule a');
    expect(output).toContain('block rule b');
  });

  it('adds tombstone when rule argument is provided', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    
    const res = cmdTombstone('Block rule C');
    expect(res).toBe(0);
    
    const configContent = fs.readFileSync(storagePaths.tombstonesFile, 'utf-8');
    expect(configContent).toContain('block rule c');
  });

  it('adds tombstone by resolving hash if hash argument is provided', async () => {
    // Write some habits first
    writeHabitsMd(serialiseHabits({
      TS: [{
        rule: 'Use strict mode',
        confidence: 0.8,
        reinforcing: 1,
        contradicting: 0,
        sessions_seen: 1,
      }]
    }));

    const hash = getRuleHash('Use strict mode');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const res = cmdTombstone(hash);
    expect(res).toBe(0);

    const configContent = fs.readFileSync(storagePaths.tombstonesFile, 'utf-8');
    expect(configContent).toContain('use strict mode');
  });
});

describe('Smart suggestions', () => {
  it('suggests cch on for all commands when globally disabled', async () => {
    await setGloballyDisabled(true);
    const steps = nextSteps('view', []);
    expect(steps).toEqual(['cch on                enable cc-habits (resume capture and prompt injection)']);
  });

  it('suggests cch sync when globally enabled', async () => {
    await setGloballyDisabled(false);
    
    const steps = nextSteps('view', []);
    expect(steps).toContain('cch sync              share habits with your other tools');
  });
});
