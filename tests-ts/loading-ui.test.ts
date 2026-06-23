/**
 * Tests for the live "what cc-habits is doing right now" trace: the tip pool,
 * the honest provider privacy note, and the steppedProgress driver in its
 * non-animated modes (static / silent). The animated TTY rendering is not
 * asserted here (it is timer + escape-code driven); instead we prove the
 * invariants that matter: ordered honest output, no tips in logs, the spinner
 * always restores the cursor and never leaks a SIGINT handler, and a thrown
 * task still propagates after cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TIPS, TIP_MARKERS, shuffledTips } from '../src/tips';
import { steppedProgress } from '../src/cli-ui';
import { extractionPrivacyNote } from '../src/providers';
import { storagePaths } from '../src/storage';

// ── tips pool ────────────────────────────────────────────────────────────────
describe('tips pool', () => {
  it('is non-empty and every tip is a sane, em-dash-free single line', () => {
    expect(TIPS.length).toBeGreaterThan(10);
    for (const tip of TIPS) {
      expect(tip.length).toBeGreaterThan(0);
      expect(tip.length).toBeLessThanOrEqual(100);
      expect(tip).not.toContain('\n');
      expect(tip).not.toContain('\u2014'); // house style: no em-dashes (escape, not literal)
    }
    expect(TIP_MARKERS.length).toBeGreaterThan(0);
  });

  it('shuffledTips returns a no-repeat permutation of the source', () => {
    const out = shuffledTips();
    expect(out).toHaveLength(TIPS.length);
    expect(new Set(out).size).toBe(TIPS.length);     // no dupes
    expect([...out].sort()).toEqual([...TIPS].sort()); // same members
  });

  it('does not mutate the source array', () => {
    const before = [...TIPS];
    shuffledTips();
    expect([...TIPS]).toEqual(before);
  });
});

// ── extractionPrivacyNote ────────────────────────────────────────────────────
describe('extractionPrivacyNote', () => {
  const origConfig = storagePaths.configFile;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-loadui-'));
    storagePaths.configFile = path.join(tmpDir, 'config.yml');
    // Isolate from the host: disable the home-config fallback and any real key.
    process.env['CC_HABITS_DIR'] = tmpDir;
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['CC_HABITS_OLLAMA_MODEL'];
  });

  afterEach(() => {
    storagePaths.configFile = origConfig;
    delete process.env['CC_HABITS_DIR'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no provider is usable', () => {
    expect(extractionPrivacyNote()).toBe('');
  });

  it('names a cloud provider as a send', () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: groq\n');
    expect(extractionPrivacyNote()).toBe('sending redacted diffs to groq');
  });

  it('says nothing leaves the machine for local Ollama', () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nollama_model: llama3.2\n');
    expect(extractionPrivacyNote()).toBe('nothing leaves this machine');
  });

  it('is honest that a -cloud Ollama model is remote', () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nollama_model: gpt-oss:120b-cloud\n');
    expect(extractionPrivacyNote()).toBe('sending redacted diffs to Ollama Cloud');
  });
});

// ── steppedProgress: static / silent ─────────────────────────────────────────
describe('steppedProgress (non-animated modes)', () => {
  let out: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    out = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  it('static mode prints ordered plain lines and no tips', async () => {
    const p = steppedProgress({ mode: 'static' });
    p.done('read 5 edits · redacted locally');
    const ret = await p.spin('distilling · sending redacted diffs to groq', async () => 42);
    p.done('noticed 1 new · 0 reinforced');

    const joined = out.join('');
    expect(ret).toBe(42);
    expect(joined).toContain('read 5 edits · redacted locally');
    expect(joined).toContain('distilling · sending redacted diffs to groq');
    expect(joined).toContain('noticed 1 new · 0 reinforced');
    // ordering
    expect(joined.indexOf('read 5')).toBeLessThan(joined.indexOf('distilling'));
    expect(joined.indexOf('distilling')).toBeLessThan(joined.indexOf('noticed 1'));
    // no tip markers / escape codes in piped output
    for (const m of TIP_MARKERS) expect(joined).not.toContain(`${m} ·`);
    expect(joined).not.toContain('\x1b[');
  });

  it('silent mode produces no output but still runs the task', async () => {
    const p = steppedProgress({ mode: 'silent' });
    p.done('this should not print');
    const ret = await p.spin('neither should this', async () => 'ran');
    expect(ret).toBe('ran');
    expect(out.join('')).toBe('');
  });

  it('propagates a thrown task in static mode', async () => {
    const p = steppedProgress({ mode: 'static' });
    await expect(p.spin('boom', async () => { throw new Error('kaboom'); })).rejects.toThrow('kaboom');
  });
});

// ── steppedProgress: animate cleanup invariants ──────────────────────────────
describe('steppedProgress (animate cleanup)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => spy.mockRestore());

  it('restores the cursor and leaks no SIGINT handler on success', async () => {
    const before = process.listenerCount('SIGINT');
    const p = steppedProgress({ mode: 'animate' });
    const ret = await p.spin('distilling', async () => 'ok', { motion: 'distill' });
    expect(ret).toBe('ok');
    expect(process.listenerCount('SIGINT')).toBe(before);
    const wrote = spy.mock.calls.map(c => String(c[0])).join('');
    expect(wrote).toContain('\x1b[?25h'); // cursor shown again
  });

  it('restores the cursor, leaks no handler, and rethrows on failure', async () => {
    const before = process.listenerCount('SIGINT');
    const p = steppedProgress({ mode: 'animate' });
    await expect(p.spin('boom', async () => { throw new Error('nope'); }, { motion: 'sweep' }))
      .rejects.toThrow('nope');
    expect(process.listenerCount('SIGINT')).toBe(before);
    const wrote = spy.mock.calls.map(c => String(c[0])).join('');
    expect(wrote).toContain('\x1b[?25h');
  });

  it('does not crash on a tiny terminal width (tip truncation stays in bounds)', async () => {
    const orig = process.stdout.columns;
    try {
      // A pathologically narrow terminal must not produce a negative slice.
      Object.defineProperty(process.stdout, 'columns', { value: 8, configurable: true });
      const p = steppedProgress({ mode: 'animate' });
      const ret = await p.spin('distilling', async () => 'done', { motion: 'distill' });
      expect(ret).toBe('done');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: orig, configurable: true });
    }
  });
});
