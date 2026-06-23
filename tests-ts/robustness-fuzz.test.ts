/**
 * Broken-path / adversarial-input robustness for the capture and parse surfaces.
 * Real hook payloads are always JSON.parse'd, so the fuzz corpus is restricted to
 * JSON-reachable shapes (no toString-throwing objects). These lock in fixes for:
 *   - adapter edits arrays containing null / non-object elements (would throw)
 *   - storage parsers fed corrupt / half-written markdown (must not throw or leak NaN)
 *   - the lock TOCTOU race where an empty just-created lock was misread as stale
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeInput } from '../src/adapters';
import { parseHabits, parseMemories, serialiseHabits } from '../src/storage';
import { acquireLock, releaseLock } from '../src/lock';

const ADAPTERS = ['claude-code', 'gemini', 'codex', 'cline', 'kimi'];

describe('adapter fuzz: JSON-reachable garbage never throws', () => {
  const garbage: unknown[] = [
    null, 0, '', 'string', true, [], [1, 2, 3],
    { tool_input: null }, { tool_input: [] }, { tool_input: 'x' },
    { tool_input: { edits: [null] } },
    { tool_input: { edits: [5, 'x', {}, true] } },
    { tool_input: { edits: 'notarray' } },
    { tool_input: { edits: [{ old_string: null }] } },
    { tool_name: {}, session_id: [] },
    { tool_input: { file_path: ['a', 'b'], edits: [[]] } },
  ];
  for (const a of ADAPTERS) {
    for (let i = 0; i < garbage.length; i++) {
      it(`${a} #${i}`, () => {
        const json = JSON.parse(JSON.stringify(garbage[i] ?? null));
        expect(() => normalizeInput(json, a)).not.toThrow();
      });
    }
  }

  it('captures valid edits even when the array also holds junk elements', () => {
    const n = normalizeInput(
      { tool_input: { edits: [null, { old_string: 'a', new_string: 'b' }, 5] } },
      'claude-code',
    );
    expect(n.edits?.length).toBe(3);
    expect(n.edits?.[1]).toEqual({ old_string: 'a', new_string: 'b' });
  });
});

describe('storage parser fuzz: corrupt markdown round-trips cleanly', () => {
  const corrupt: string[] = [
    '', '\n\n\n', '## ', '## \n- ', '- orphan rule. Confidence: 0.5',
    '## Cat\n- rule. Confidence: ..',
    '## Cat\n- rule. Confidence: 0.5\n  - Signal: abc reinforcing',
    '## Cat\n- rule. Confidence: 0.5\n  - Sessions seen: notanumber',
    '## Learning (', '## Learning\n- [unclosed rule. Confidence: 0.5',
    '## Learning\n- [Cat] rule. Confidence: 0.5',
    '\x00\x01\x02 garbage ﻿',
    '## C\n- r. Confidence: 0.5\n  - Languages: ',
    '## C\n- r. Confidence: 99999999999999999999.5',
  ];
  for (let i = 0; i < corrupt.length; i++) {
    it(`#${i} parse + serialise + reparse, no throw, no NaN survives`, () => {
      const cats = parseHabits(corrupt[i]);
      const round = serialiseHabits(cats);
      const re = parseHabits(round);
      for (const list of Object.values(re)) {
        for (const h of list) expect(Number.isNaN(h.confidence)).toBe(false);
      }
      expect(typeof round).toBe('string');
    });
  }

  it('parseMemories tolerates corrupt input', () => {
    for (const m of ['', '## ', '- Trigger:', '## M\n- Correction:', '\x00x', 'Score: nan']) {
      expect(() => parseMemories(m)).not.toThrow();
    }
  });
});

describe('lock: concurrent acquirers serialise (no lost updates)', () => {
  it('16 interleaved critical sections each increment exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-lock-'));
    const lockFile = path.join(dir, 'work.lock');
    const counterFile = path.join(dir, 'counter');
    fs.writeFileSync(counterFile, '0');

    // Same-process concurrency: every task shares this pid, so a racing acquirer
    // that finds the lock held reads its own (live) pid and waits rather than
    // breaking it. The await between read and write widens the race window.
    const worker = async (): Promise<void> => {
      const ok = await acquireLock(lockFile, 8000, 5);
      expect(ok).toBe(true);
      const cur = parseInt(fs.readFileSync(counterFile, 'utf-8').trim() || '0', 10);
      await new Promise(r => setTimeout(r, 3));
      fs.writeFileSync(counterFile, String(cur + 1));
      releaseLock(lockFile);
    };

    await Promise.all(Array.from({ length: 16 }, () => worker()));
    expect(parseInt(fs.readFileSync(counterFile, 'utf-8').trim(), 10)).toBe(16);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('breaks a stale lock held by a dead pid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-lock-'));
    const lockFile = path.join(dir, 'stale.lock');
    fs.writeFileSync(lockFile, '999999'); // pid that does not exist
    expect(await acquireLock(lockFile, 3000, 50)).toBe(true);
    releaseLock(lockFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('breaks a corrupt (non-numeric) lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-lock-'));
    const lockFile = path.join(dir, 'corrupt.lock');
    fs.writeFileSync(lockFile, 'not-a-pid');
    expect(await acquireLock(lockFile, 3000, 50)).toBe(true);
    releaseLock(lockFile);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
