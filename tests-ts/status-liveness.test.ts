/**
 * Tests for the `cch status` liveness proof helpers.
 *
 * lastFiredBySource() reduces captured signals to the most-recent timestamp and
 * total count per capture source, the data that proves a hook actually ran (vs.
 * merely being registered). formatTimeAgo() renders a signal timestamp as a
 * human "time since" string. resolveProviderLabel() names the concrete provider
 * the scan/extraction will use.
 *
 * Setup/teardown: each suite saves and restores the process env keys it mutates
 * so cases never leak provider state into one another.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lastFiredBySource, formatTimeAgo } from '../src/cli';
import { resolveProviderLabel } from '../src/providers';

describe('lastFiredBySource', () => {
  it('keeps the most recent timestamp and counts per source', () => {
    const out = lastFiredBySource([
      { ts: '2026-06-01T00:00:00.000Z', source: 'claude-code', file: 'a.ts' },
      { ts: '2026-06-08T23:00:00.000Z', source: 'claude-code', file: 'b.ts' },
      { ts: '2026-06-05T00:00:00.000Z', source: 'gemini', file: 'g.txt' },
    ]);
    expect(out['claude-code']).toEqual({ ts: '2026-06-08T23:00:00.000Z', count: 2, file: 'b.ts' });
    expect(out['gemini']).toEqual({ ts: '2026-06-05T00:00:00.000Z', count: 1, file: 'g.txt' });
  });

  it('ignores signals with no source (legacy, pre-attribution rows)', () => {
    const out = lastFiredBySource([
      { ts: '2026-05-01T00:00:00.000Z', file: 'old.ts' },
      { ts: '2026-06-08T00:00:00.000Z', source: 'kimi', file: 'k.ts' },
    ]);
    expect(Object.keys(out)).toEqual(['kimi']);
    expect(out['kimi'].count).toBe(1);
  });

  it('returns an empty map for no signals', () => {
    expect(lastFiredBySource([])).toEqual({});
  });
});

describe('formatTimeAgo', () => {
  it('renders seconds, minutes, hours, and days', () => {
    const now = Date.now();
    expect(formatTimeAgo(new Date(now - 30 * 1000).toISOString())).toContain('s ago');
    expect(formatTimeAgo(new Date(now - 5 * 60 * 1000).toISOString())).toBe('5 minutes ago');
    expect(formatTimeAgo(new Date(now - 2 * 60 * 60 * 1000).toISOString())).toBe('2 hours ago');
    expect(formatTimeAgo(new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString())).toBe('3 days ago');
  });

  it('singularizes a 1-unit interval', () => {
    const now = Date.now();
    expect(formatTimeAgo(new Date(now - 60 * 1000).toISOString())).toBe('1 minute ago');
    expect(formatTimeAgo(new Date(now - 24 * 60 * 60 * 1000).toISOString())).toBe('1 day ago');
  });

  it('returns "unknown" for an unparseable timestamp', () => {
    expect(formatTimeAgo('not-a-date')).toBe('unknown');
  });
});

describe('resolveProviderLabel', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['CC_HABITS_PROVIDER', 'ANTHROPIC_API_KEY'];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('honors the CC_HABITS_PROVIDER env override above all else', () => {
    process.env['CC_HABITS_PROVIDER'] = 'gemini-cli';
    expect(resolveProviderLabel()).toBe('gemini-cli');
  });

  it('is a non-empty string naming a concrete provider or "none"', () => {
    // With no env override, the label reflects config/env state; it must never be
    // blank, so the scan warning always names *something* the user can recognize.
    const label = resolveProviderLabel();
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});
