// Tests for the session-start transparency banner and the per-repo capture opt-out.
//   - buildSessionBanner: fires exactly once (edit #1), truthful count, no rule names
//   - captureDisabled: honours CC_HABITS_DISABLE and .cc-habits-ignore
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSessionBanner, captureDisabled } from '../src/hook';

// Active habit requires sessions_seen >= 2 in the real serialized format.
const ACTIVE_HABITS_MD = `<!-- cc-habits format v0.2 -->
# Coding habits

## Error Handling

- Always wrap async I/O in try/catch blocks. Confidence: 0.80
  - Signal: 4 reinforcing, 0 contradicting
  - Sessions seen: 3

## TypeScript

- Prefer explicit return types on exported functions. Confidence: 0.70
  - Signal: 3 reinforcing, 0 contradicting
  - Sessions seen: 2
`;

describe('buildSessionBanner', () => {
  it('fires on the first edit of a session (editCount=1) with a truthful count', () => {
    const out = buildSessionBanner(ACTIVE_HABITS_MD, 1);
    expect(out).not.toBeNull();
    expect(out).toContain('2 habits active');
  });

  it('never names a specific rule, stays generic', () => {
    const out = buildSessionBanner(ACTIVE_HABITS_MD, 1);
    expect(out).not.toContain('try/catch');
    expect(out).not.toContain('return types');
    expect(out).not.toContain('Error Handling');
  });

  it('points to cch view for details', () => {
    const out = buildSessionBanner(ACTIVE_HABITS_MD, 1);
    expect(out).toContain('cch view');
  });

  it('returns null on subsequent edits (editCount != 1)', () => {
    expect(buildSessionBanner(ACTIVE_HABITS_MD, 0)).toBeNull();
    expect(buildSessionBanner(ACTIVE_HABITS_MD, 2)).toBeNull();
    expect(buildSessionBanner(ACTIVE_HABITS_MD, 99)).toBeNull();
  });

  it('returns null when no active habits exist', () => {
    expect(buildSessionBanner('# Coding habits\n', 1)).toBeNull();
  });

  it('uses singular form for exactly one habit', () => {
    const oneHabit = `<!-- cc-habits format v0.2 -->
# Coding habits

## TypeScript

- Use strict mode. Confidence: 0.80
  - Signal: 4 reinforcing, 0 contradicting
  - Sessions seen: 3
`;
    const out = buildSessionBanner(oneHabit, 1);
    expect(out).toContain('1 habit active');
    expect(out).not.toContain('habits active');
  });
});

describe('captureDisabled', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-marker-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['CC_HABITS_DISABLE'];
  });

  it('is false in a clean directory with no env override', () => {
    expect(captureDisabled()).toBe(false);
  });

  it('is true when CC_HABITS_DISABLE is truthy', () => {
    process.env['CC_HABITS_DISABLE'] = '1';
    expect(captureDisabled()).toBe(true);
  });

  it('treats CC_HABITS_DISABLE=0 / false / off as not disabled', () => {
    for (const v of ['0', 'false', 'off']) {
      process.env['CC_HABITS_DISABLE'] = v;
      expect(captureDisabled()).toBe(false);
    }
  });

  it('is true when a .cc-habits-ignore file is present in the cwd', () => {
    fs.writeFileSync(path.join(tmpDir, '.cc-habits-ignore'), '');
    expect(captureDisabled()).toBe(true);
  });
});
