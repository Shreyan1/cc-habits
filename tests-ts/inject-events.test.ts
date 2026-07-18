/**
 * Tests for the injection-proof pipeline (v0.9.1):
 *   - appendInjectEvent / readInjectEvents: append-only events.jsonl with a
 *     self-describing header, control-char stripping, and malformed-line skips
 *   - processUserPromptSubmit: logs one inject event per prompt that actually
 *     returned learned context, and none when nothing was injected
 *   - activityRow: bar scaling for the `cch view` activity graph
 *   - isPromptInstructionEcho path: extraction drops habit rules that quote the
 *     prompt's own instruction text (via parse-level filtering)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, appendInjectEvent, readInjectEvents, eventsFilePath,
  type InjectEvent,
} from '../src/storage';
import { processUserPromptSubmit } from '../src/hook';
import { activityRow } from '../src/cli';

const origStorage = { ...storagePaths };
const origCwd = process.cwd();
let tmpDir: string;

const ACTIVE_HABITS = `<!-- cc-habits format v0.2 -->
# Coding habits

## TypeScript

- Use explicit return types on exported functions. Confidence: 0.80
  - Sessions seen: 3

## Naming

- Use camelCase for variables. Confidence: 0.90
  - Sessions seen: 4
`;

const LEARNING_ONLY = `<!-- cc-habits format v0.2 -->
# Coding habits

## Learning (not yet active)

- [Imports] Prefer named imports. Confidence: 0.50
  - Sessions seen: 1
`;

function makeEvent(overrides: Partial<InjectEvent> = {}): InjectEvent {
  return {
    ts: new Date().toISOString(),
    type: 'inject',
    session_id: 'sess-1',
    source: 'claude-code',
    habits: 2,
    memories: 0,
    scope: 'global',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-events-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
  // Run from the temp dir so resolveRepoCtx cannot find this repository's own
  // .cch/ store and layer it into the merged injection under test.
  process.chdir(tmpDir);
  delete process.env['CC_HABITS_INJECT'];
  delete process.env['CC_HABITS_MEMORIES'];
});

afterEach(() => {
  process.chdir(origCwd);
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['CC_HABITS_INJECT'];
  delete process.env['CC_HABITS_MEMORIES'];
});

describe('appendInjectEvent / readInjectEvents', () => {
  it('appends events and reads them back in order', () => {
    appendInjectEvent(makeEvent({ session_id: 'a' }));
    appendInjectEvent(makeEvent({ session_id: 'b', habits: 5 }));
    const events = readInjectEvents();
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBe('a');
    expect(events[1].habits).toBe(5);
  });

  it('seeds a self-describing header that readers skip', () => {
    appendInjectEvent(makeEvent());
    const raw = fs.readFileSync(eventsFilePath(), 'utf-8');
    expect(raw.startsWith('// cc-habits injection log')).toBe(true);
    expect(readInjectEvents()).toHaveLength(1);
  });

  it('returns empty for a missing file and skips malformed lines', () => {
    expect(readInjectEvents()).toEqual([]);
    fs.writeFileSync(eventsFilePath(), 'not json\n{"type":"other"}\n');
    appendInjectEvent(makeEvent());
    expect(readInjectEvents()).toHaveLength(1);
  });

  it('strips control characters from session_id and source', () => {
    appendInjectEvent(makeEvent({ session_id: 's\x1b[2Jss', source: 'clau\x00de' }));
    const [ev] = readInjectEvents();
    expect(ev.session_id).toBe('s[2Jss');
    expect(ev.source).toBe('claude');
  });
});

describe('processUserPromptSubmit inject-event logging', () => {
  it('logs one event with counts when habits are injected', () => {
    fs.writeFileSync(storagePaths.habitsFile, ACTIVE_HABITS);
    const out = processUserPromptSubmit({ session_id: 'sess-9', prompt: 'refactor this' });
    expect(out).toContain('<coding-habits>');
    const events = readInjectEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-9');
    expect(events[0].source).toBe('claude-code');
    expect(events[0].habits).toBe(2);
    expect(events[0].scope).toBe('global');
  });

  it('records the adapter that fired the hook', () => {
    fs.writeFileSync(storagePaths.habitsFile, ACTIVE_HABITS);
    processUserPromptSubmit({ session_id: 's', prompt: 'x' }, undefined, 'gemini');
    expect(readInjectEvents()[0].source).toBe('gemini');
  });

  it('logs nothing when nothing was injected (learning-only store)', () => {
    fs.writeFileSync(storagePaths.habitsFile, LEARNING_ONLY);
    const out = processUserPromptSubmit({ session_id: 's', prompt: 'x' });
    expect(out).toBeNull();
    expect(fs.existsSync(eventsFilePath())).toBe(false);
    expect(readInjectEvents()).toEqual([]);
  });

  it('logs nothing when injection is disabled', () => {
    fs.writeFileSync(storagePaths.habitsFile, ACTIVE_HABITS);
    process.env['CC_HABITS_INJECT'] = '0';
    expect(processUserPromptSubmit({ session_id: 's', prompt: 'x' })).toBeNull();
    expect(readInjectEvents()).toEqual([]);
  });

  it('event count matches the number of rules in the injected block', () => {
    fs.writeFileSync(storagePaths.habitsFile, ACTIVE_HABITS);
    const out = processUserPromptSubmit({ session_id: 's', prompt: 'x' }) ?? '';
    const rendered = out.split('\n').filter(l => l.startsWith('- ')).length;
    expect(readInjectEvents()[0].habits).toBe(rendered);
  });
});

describe('activityRow', () => {
  it('renders empty days as the zero block', () => {
    expect(activityRow([0, 0, 0])).toBe('░ ░ ░');
  });

  it('scales to the row peak and never renders zero as a bar', () => {
    const row = activityRow([0, 1, 8]).split(' ');
    expect(row[0]).toBe('░');
    expect(row[2]).toBe('█');
    expect(row[1]).not.toBe('░');
  });

  it('handles a flat all-equal row', () => {
    const row = activityRow([3, 3, 3]).split(' ');
    expect(new Set(row).size).toBe(1);
    expect(row[0]).toBe('█');
  });
});
