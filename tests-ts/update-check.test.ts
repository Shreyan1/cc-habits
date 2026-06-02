import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import {
  isNewerVersion, buildUpdateNotice, getLatestVersion, maybeUpdateNotice,
} from '../src/update-check';

const origStorage = { ...storagePaths };
const origFetch = globalThis.fetch;
let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

// Explicit setup: isolate the cache file and clear all opt-out env vars so the
// check is "enabled" by default for these tests.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-update-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.updateCheckFile = path.join(tmpDir, '.update-check.json');
  savedEnv = {
    CC_HABITS_NO_UPDATE_CHECK: process.env['CC_HABITS_NO_UPDATE_CHECK'],
    NO_UPDATE_NOTIFIER: process.env['NO_UPDATE_NOTIFIER'],
    CI: process.env['CI'],
  };
  delete process.env['CC_HABITS_NO_UPDATE_CHECK'];
  delete process.env['NO_UPDATE_NOTIFIER'];
  delete process.env['CI'];
});

// Explicit teardown: restore storage paths, fetch, and env.
afterEach(() => {
  Object.assign(storagePaths, origStorage);
  globalThis.fetch = origFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const mockFetchVersion = (version: string, ok = true): typeof fetch =>
  (async () => new Response(JSON.stringify({ version }), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

const mockFetchThrows = (): typeof fetch =>
  (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

describe('isNewerVersion', () => {
  it('detects a strictly newer version across each semver field', () => {
    expect(isNewerVersion('0.5.0', '0.4.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.4.2', '0.4.1')).toBe(true);
  });

  it('returns false for equal or older versions', () => {
    expect(isNewerVersion('0.4.1', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(false);
    expect(isNewerVersion('0.3.9', '0.4.0')).toBe(false);
  });

  it('tolerates a v prefix and ignores prerelease/build suffixes', () => {
    expect(isNewerVersion('v0.5.0', '0.4.1')).toBe(true);
    expect(isNewerVersion('0.5.0-beta.1', '0.5.0')).toBe(false); // core equal
    expect(isNewerVersion('0.5.0+build7', '0.4.9')).toBe(true);
  });
});

describe('buildUpdateNotice', () => {
  it('builds a notice with upgrade command, top features, and website when newer', () => {
    const notice = buildUpdateNotice('0.4.1', '0.5.0');
    expect(notice).not.toBeNull();
    expect(notice).toContain('0.4.1 -> 0.5.0');
    expect(notice).toContain('npm install -g cc-habits@latest');
    expect(notice).toContain('Top features:');
    expect(notice).toContain('Cross-tool habit learning');
    expect(notice).toContain('Coding memories');
    expect(notice).toContain('https://shreyan1.github.io/cc-habits/');
  });

  it('returns null when already current or ahead', () => {
    expect(buildUpdateNotice('0.5.0', '0.5.0')).toBeNull();
    expect(buildUpdateNotice('0.6.0', '0.5.0')).toBeNull();
  });

  // Security: a MITM or compromised npm registry could return a "latest"
  // version string carrying terminal escape sequences. buildUpdateNotice prints
  // it to stderr, so it must be stripped to plausible version characters first.
  it('strips terminal escape sequences from a malicious latest version', () => {
    const esc = String.fromCharCode(27); // ESC
    const bel = String.fromCharCode(7);  // BEL
    const evil = `9.9.9${esc}]0;pwned${bel}${esc}[2J`;
    const notice = buildUpdateNotice('0.5.0', evil) ?? '';
    // The security property: the escape-sequence machinery is gone. No ESC/BEL
    // control bytes, and no CSI/OSC structural brackets, so nothing can drive
    // the terminal. Inert letters surviving as plain text is harmless (real
    // versions contain letters like "beta"/"rc").
    expect(notice.includes(esc)).toBe(false);
    expect(notice.includes(bel)).toBe(false);
    expect(notice).not.toContain('[');
    expect(notice).not.toContain(']');
    expect(notice).toContain('9.9.9');
  });

  it('strips control chars and bounds the length of a hostile version string', () => {
    const evil = '1.0.0' + String.fromCharCode(10, 13, 9) + 'rm -rf ~' + 'A'.repeat(200);
    const notice = buildUpdateNotice('0.5.0', evil) ?? '';
    expect(notice).not.toContain('rm -rf');
    // The version token shown is capped (<= 32 chars), so the 200-char tail cannot flood the line.
    const firstLine = notice.split('\n')[0];
    expect(firstLine.length).toBeLessThan(80);
  });
});

describe('getLatestVersion (throttle cache)', () => {
  it('uses a fresh cache without hitting the network', async () => {
    fs.writeFileSync(storagePaths.updateCheckFile,
      JSON.stringify({ lastChecked: 1_000_000, latestVersion: '0.9.9' }));
    const fetchSpy = vi.fn(mockFetchVersion('1.2.3'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const v = await getLatestVersion(1_000_000 + 60_000); // 1 min later, within TTL
    expect(v).toBe('0.9.9');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes from the registry when the cache is stale and rewrites the cache', async () => {
    fs.writeFileSync(storagePaths.updateCheckFile,
      JSON.stringify({ lastChecked: 0, latestVersion: '0.1.0' }));
    const fetchSpy = vi.fn(mockFetchVersion('0.5.0'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const now = 48 * 60 * 60 * 1000; // 2 days later, past TTL
    const v = await getLatestVersion(now);
    expect(v).toBe('0.5.0');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(fs.readFileSync(storagePaths.updateCheckFile, 'utf-8'));
    expect(cache.latestVersion).toBe('0.5.0');
    expect(cache.lastChecked).toBe(now);
  });

  it('fetches on first run when no cache exists', async () => {
    globalThis.fetch = mockFetchVersion('0.4.2');
    const v = await getLatestVersion();
    expect(v).toBe('0.4.2');
  });

  it('returns undefined when offline on first run', async () => {
    globalThis.fetch = mockFetchThrows();
    const v = await getLatestVersion();
    expect(v).toBeUndefined();
  });

  it('falls back to the stale cached version when the refresh fails', async () => {
    fs.writeFileSync(storagePaths.updateCheckFile,
      JSON.stringify({ lastChecked: 0, latestVersion: '0.4.0' }));
    globalThis.fetch = mockFetchThrows();
    const now = 48 * 60 * 60 * 1000;
    const v = await getLatestVersion(now);
    expect(v).toBe('0.4.0'); // last known version preserved
    const cache = JSON.parse(fs.readFileSync(storagePaths.updateCheckFile, 'utf-8'));
    expect(cache.lastChecked).toBe(now); // stamped so we don't retry every command
  });

  it('ignores a non-version garbage registry response gracefully', async () => {
    // A compromised/garbage registry payload must never crash or be trusted.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: { nested: 'object' } }), { status: 200 })) as unknown as typeof fetch;
    const v = await getLatestVersion();
    expect(v).toBeUndefined();
  });
});

describe('maybeUpdateNotice', () => {
  it('returns a notice when a newer version is published', async () => {
    globalThis.fetch = mockFetchVersion('0.9.0');
    const notice = await maybeUpdateNotice('0.5.0');
    expect(notice).toContain('0.5.0 -> 0.9.0');
  });

  it('returns null when the installed version is current', async () => {
    globalThis.fetch = mockFetchVersion('0.5.0');
    expect(await maybeUpdateNotice('0.5.0')).toBeNull();
  });

  it('is disabled (no network) when CC_HABITS_NO_UPDATE_CHECK is set', async () => {
    process.env['CC_HABITS_NO_UPDATE_CHECK'] = '1';
    const fetchSpy = vi.fn(mockFetchVersion('9.9.9'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await maybeUpdateNotice('0.5.0')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is disabled under CI', async () => {
    process.env['CI'] = 'true';
    const fetchSpy = vi.fn(mockFetchVersion('9.9.9'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await maybeUpdateNotice('0.5.0')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
