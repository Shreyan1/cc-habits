import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { consentGiven, recordConsent, getConfigValue } from '../src/config';

const origStorage = { ...storagePaths };
let tmpDir: string;

// Explicit setup: isolate every test in a fresh temp store with no pre-existing consent.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-consent-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.habitsDir = tmpDir;
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
});

// Explicit teardown: restore storage paths and remove the temp store.
afterEach(() => {
  Object.assign(storagePaths, origStorage);
  delete process.env['CC_HABITS_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('L5: consent tracking', () => {
  it('returns false when no config file exists', () => {
    expect(consentGiven()).toBe(false);
  });

  it('returns false when config exists but consent_given is absent', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\n');
    expect(consentGiven()).toBe(false);
  });

  it('records consent as an ISO timestamp in config.yml', () => {
    const before = Date.now();
    recordConsent();
    const after = Date.now();

    const raw = getConfigValue('consent_given') ?? '';
    expect(raw).toBeTruthy();

    const ts = Date.parse(raw);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns true after consent is recorded', () => {
    recordConsent();
    expect(consentGiven()).toBe(true);
  });

  it('preserves existing config keys when recording consent', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nmemories_enabled: true\n');
    recordConsent();
    expect(getConfigValue('provider')).toBe('ollama');
    expect(getConfigValue('memories_enabled')).toBe('true');
    expect(consentGiven()).toBe(true);
  });

  it('re-recording consent updates the timestamp, not duplicates the key', () => {
    recordConsent();
    const first = getConfigValue('consent_given') ?? '';
    recordConsent();
    const second = getConfigValue('consent_given') ?? '';

    // Both parses should be valid timestamps.
    expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));

    // Only one consent_given key should exist in the file.
    const raw = fs.readFileSync(storagePaths.configFile, 'utf-8');
    const matches = raw.match(/consent_given/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
