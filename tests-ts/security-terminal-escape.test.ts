/**
 * Terminal escape / ANSI injection regression suite.
 *
 * cc-habits prints learned rules, memories, file paths, and provider errors to
 * the terminal, and writes the same text into markdown files that humans and
 * other AI agents read. Untrusted input (a poisoned diff, a malicious repo file,
 * a hostile provider response) must never carry a live terminal escape sequence
 * through any of those surfaces.
 *
 * The 7-bit ESC form (\x1b[...) was already stripped. The gap this suite locks
 * down is the 8-bit C1 range (\x80-\x9f), which carries the 8-bit forms of CSI
 * (\x9b) and OSC (\x9d). Terminals that honor 8-bit controls treat these as live
 * escapes, so they are the CVE-2025-55193 / tracing-subscriber class of bug:
 *   - OSC 52  writes the system clipboard
 *   - OSC 0/2 rewrites the terminal title bar
 *   - CSI      moves the cursor / clears the screen to hide or spoof output
 *
 * Defence is layered: every untrusted write surface strips the C0+DEL+C1 set at
 * the source, and the cli-ui `term()` helper is the matching output-boundary scrub.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeRule, sanitizeCategory } from '../src/confidence';
import { sanitizeFilePath, applyMemoryUpdates, readMemoriesMd, parseMemories, storagePaths } from '../src/storage';
import { term } from '../src/cli-ui';

// The full set of control characters that must never survive into stored data or
// a value printed to the terminal: C0 controls, DEL, and the C1 range.
const DANGEROUS_CONTROL = /[\x00-\x1f\x7f-\x9f]/;

// Named escape bytes used across the vectors below.
const ESC = String.fromCharCode(0x1b);
const C1_CSI = String.fromCharCode(0x9b); // 8-bit CSI
const C1_OSC = String.fromCharCode(0x9d); // 8-bit OSC
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

describe('terminal escape injection: sanitizeRule', () => {
  const vectors: Array<[string, string]> = [
    ['7-bit CSI colour', `Use tabs ${ESC}[31mRED${ESC}[0m`],
    ['7-bit OSC 52 clipboard', `rule ${ESC}]52;c;ZXZpbA==${BEL} tail`],
    ['8-bit C1 CSI', `rule ${C1_CSI}[31mRED tail`],
    ['8-bit C1 OSC 52', `rule ${C1_OSC}52;c;ZXZpbA==${BEL} tail`],
    ['8-bit C1 title spoof', `rule ${C1_OSC}2;EVIL${BEL} tail`],
    ['DEL byte', `rule ${DEL} tail`],
  ];

  for (const [name, input] of vectors) {
    it(`strips ${name}`, () => {
      expect(DANGEROUS_CONTROL.test(sanitizeRule(input))).toBe(false);
    });
  }
});

describe('terminal escape injection: sanitizeCategory', () => {
  it('strips an 8-bit C1 escape embedded in a category label', () => {
    expect(DANGEROUS_CONTROL.test(sanitizeCategory(`Style${C1_CSI}[31m`))).toBe(false);
  });
});

describe('terminal escape injection: sanitizeFilePath', () => {
  it('strips DEL and the 8-bit C1 range from a displayed file path', () => {
    const out = sanitizeFilePath(`src/${DEL}${C1_OSC}52;c;x/evil.ts`);
    expect(DANGEROUS_CONTROL.test(out)).toBe(false);
  });

  it('still neutralises traversal segments alongside control chars', () => {
    const out = sanitizeFilePath(`..${C1_CSI}/../etc/passwd`);
    expect(DANGEROUS_CONTROL.test(out)).toBe(false);
    expect(out).not.toContain('..');
  });
});

describe('terminal escape injection: term() output-boundary scrub', () => {
  it('strips ESC, BEL, and the C1 range from untrusted error text', () => {
    expect(DANGEROUS_CONTROL.test(term(`boom ${ESC}[2J ${C1_OSC}52;c;x ${BEL}`))).toBe(false);
  });

  it('preserves newlines so legitimate multi-line messages survive', () => {
    // Newlines are kept (multi-line errors stay readable); tabs are stripped along
    // with the other C0 controls, since tab can be abused for alignment spoofing.
    expect(term('line1\nline2')).toBe('line1\nline2');
  });
});

describe('terminal escape injection: stored memories are scrubbed at write time', () => {
  const origPaths = { ...storagePaths };

  it('applyMemoryUpdates strips C1 from text, trigger, and correction', () => {
    // Setup and teardown are kept inside the test so the temp storagePaths never
    // leak into sibling suites that run serially in the same process.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-termmem-'));
    storagePaths.habitsDir = tmpDir;
    storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
    storagePaths.memoryTombstonesFile = path.join(tmpDir, '.memory-tombstones.json');
    storagePaths.memoryIndexFile = path.join(tmpDir, '.memory-index.json');
    try {
      applyMemoryUpdates([
        {
          section: 'Repeated mistakes',
          text: `Never ${C1_CSI}]52;c;ZXZpbA==${BEL} hardcode keys`,
          trigger: [`config${C1_OSC}`],
          correction: `Use env ${C1_CSI}[31m vars`,
        },
      ]);
      const sections = parseMemories(readMemoriesMd());
      const all = Object.values(sections).flat();
      expect(all.length).toBe(1);
      const m = all[0]!;
      expect(DANGEROUS_CONTROL.test(m.text)).toBe(false);
      expect(DANGEROUS_CONTROL.test(m.correction ?? '')).toBe(false);
      for (const t of m.trigger) expect(DANGEROUS_CONTROL.test(t)).toBe(false);
    } finally {
      Object.assign(storagePaths, origPaths);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
