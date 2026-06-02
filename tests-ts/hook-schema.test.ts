import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import {
  validatePayload, logSchemaWarning, logUnknownEvent,
  HANDLED_EVENTS, KNOWN_UNSUPPORTED_EVENTS,
} from '../src/hook-schema';
import { normalizeInput } from '../src/adapters';
import { buildDiffFromNormalized } from '../src/hook';

const FIXTURE_DIR = path.join(process.cwd(), 'tests-ts', 'fixtures');
const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')) as Record<string, unknown>;

const origStorage = { ...storagePaths };
let tmpDir: string;

// Explicit setup: isolate error.log writes in a fresh temp store.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-schema-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.habitsDir = tmpDir;
  storagePaths.errorLog = path.join(tmpDir, 'error.log');
});

// Explicit teardown: restore paths and remove the temp store.
afterEach(() => {
  Object.assign(storagePaths, origStorage);
  delete process.env['CC_HABITS_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('T1: validatePayload contract', () => {
  it('passes when stop payload has session_id', () => {
    expect(validatePayload('stop', { session_id: 'x' }).ok).toBe(true);
  });

  it('fails when stop payload is missing session_id', () => {
    const res = validatePayload('stop', { hook_event_name: 'Stop' });
    expect(res.ok).toBe(false);
    expect(res.missing).toContain('session_id');
  });

  it('accepts session_id aliases (sessionId, session)', () => {
    expect(validatePayload('stop', { sessionId: 'x' }).ok).toBe(true);
    expect(validatePayload('stop', { session: 'x' }).ok).toBe(true);
  });

  it('treats empty-string session_id as missing', () => {
    expect(validatePayload('stop', { session_id: '' }).ok).toBe(false);
  });

  it('requires tool_name and tool_input for post-tool-use', () => {
    expect(validatePayload('post-tool-use', { tool_name: 'Write', tool_input: {} }).ok).toBe(true);
    const missing = validatePayload('post-tool-use', { tool_name: 'Write' });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain('tool_input');
  });

  it('requires prompt for user-prompt-submit', () => {
    expect(validatePayload('user-prompt-submit', { prompt: 'hi' }).ok).toBe(true);
    expect(validatePayload('user-prompt-submit', {}).ok).toBe(false);
  });

  it('always passes for non-claude-code adapters (they normalize separately)', () => {
    expect(validatePayload('post-tool-use', {}, 'gemini').ok).toBe(true);
    expect(validatePayload('stop', {}, 'kimi').ok).toBe(true);
  });

  it('passes for an event with no declared required fields', () => {
    expect(validatePayload('some-future-event', {}).ok).toBe(true);
  });
});

describe('T1: real Claude Code fixtures satisfy the contract', () => {
  it('stop fixture passes', () => {
    expect(validatePayload('stop', loadFixture('stop-payload.json')).ok).toBe(true);
  });

  it('post-tool-use fixture passes', () => {
    expect(validatePayload('post-tool-use', loadFixture('post-tool-use-payload.json')).ok).toBe(true);
  });

  it('user-prompt-submit fixture passes', () => {
    expect(validatePayload('user-prompt-submit', loadFixture('user-prompt-submit-payload.json')).ok).toBe(true);
  });

  it('session-start fixture passes', () => {
    expect(validatePayload('session-start', loadFixture('session-start-payload.json')).ok).toBe(true);
  });

  it('post-tool-use fixture still flows through capture to a real diff', () => {
    const raw = loadFixture('post-tool-use-payload.json');
    const normalized = normalizeInput(raw, 'claude-code');
    expect(normalized.toolName).toBe('Write');
    expect(normalized.filePath).toBe('src/example.ts');
    expect(normalized.sessionId).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    const diff = buildDiffFromNormalized(normalized);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('greeting');
  });
});

describe('T1: event classification', () => {
  it('lists the four handled events', () => {
    for (const e of ['post-tool-use', 'stop', 'user-prompt-submit', 'session-start']) {
      expect(HANDLED_EVENTS.has(e)).toBe(true);
    }
  });

  it('classifies subagent-stop as known-but-unsupported, not handled', () => {
    expect(KNOWN_UNSUPPORTED_EVENTS.has('subagent-stop')).toBe(true);
    expect(HANDLED_EVENTS.has('subagent-stop')).toBe(false);
  });
});

describe('T1: drift logging is best-effort and visible in error.log', () => {
  it('logSchemaWarning writes a record mentioning the missing field', () => {
    logSchemaWarning('stop', ['session_id']);
    const log = fs.readFileSync(storagePaths.errorLog, 'utf-8');
    expect(log).toContain('schema: stop');
    expect(log).toContain('session_id');
  });

  it('logUnknownEvent writes a record naming the event', () => {
    logUnknownEvent('teammate-idle');
    const log = fs.readFileSync(storagePaths.errorLog, 'utf-8');
    expect(log).toContain('teammate-idle');
    expect(log).toContain('unrecognized hook event');
  });
});
