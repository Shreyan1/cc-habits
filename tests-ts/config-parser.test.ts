/**
 * Parser edge-case tests for getConfigValue / setConfigValue.
 *
 * Two correctness properties are verified here:
 *
 *  1. Intra-token '#' preserved (YAML inline-comment rule)
 *     YAML (and our parser) only starts an inline comment at a '#' that is
 *     preceded by whitespace. A bare '#' inside a token like sk-test#suffix
 *     must survive verbatim. The previous regex also preserved it; this test
 *     locks the behaviour in so any future parser rewrite doesn't regress.
 *
 *  2. Read/write agree on column-0 anchoring
 *     setConfigValue always writes keys at column 0. getConfigValue must
 *     therefore also only match keys at column 0, otherwise a hand-indented
 *     line is readable but not replaceable, causing `cch memories --enable`
 *     to append a new key while reads keep returning the stale indented value.
 *     With the fix, an indented key is invisible to getConfigValue (returns
 *     undefined) and to setConfigValue (appends the canonical key at col 0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { getConfigValue, setConfigValue } from '../src/config';

const origPaths = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-config-parser-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
});

afterEach(() => {
  Object.assign(storagePaths, origPaths);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Edge case 1: intra-token '#' ──────────────────────────────────────────────

describe('getConfigValue: intra-token # is not treated as a comment', () => {
  it('preserves # when it immediately follows a non-whitespace character', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'openai_api_key: sk-test#suffix\n');
    expect(getConfigValue('openai_api_key')).toBe('sk-test#suffix');
  });

  it('still strips a trailing inline comment preceded by a space', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic # preferred\n');
    expect(getConfigValue('provider')).toBe('anthropic');
  });

  it('still strips a trailing inline comment preceded by a tab', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'provider: anthropic\t# preferred\n');
    expect(getConfigValue('provider')).toBe('anthropic');
  });

  it('preserves # inside a double-quoted value even when space precedes it', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // YAML quotes protect the value; the space+# inside quotes is not a comment.
    fs.writeFileSync(storagePaths.configFile, 'note: "sk-test #not-a-comment"\n');
    expect(getConfigValue('note')).toBe('sk-test #not-a-comment');
  });

  it('preserves # inside a single-quoted value even when space precedes it', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, "note: 'sk-test #not-a-comment'\n");
    expect(getConfigValue('note')).toBe('sk-test #not-a-comment');
  });

  it('handles value that is only a # character (adjacent, no space)', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // '#' with no preceding whitespace is part of the token, not a comment.
    fs.writeFileSync(storagePaths.configFile, 'tag: color#ff0000\n');
    expect(getConfigValue('tag')).toBe('color#ff0000');
  });

  it('multiple # in a value: only the one preceded by whitespace ends the token', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'key: a#b#c # comment\n');
    // 'a#b#c' has no space before any #, but the last # has a space before it.
    expect(getConfigValue('key')).toBe('a#b#c');
  });
});

// ── Edge case 2: column-0 anchoring keeps reads and writes consistent ─────────

describe('getConfigValue / setConfigValue: both anchored at column 0', () => {
  it('does not read a hand-indented key (returns undefined)', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Simulate a hand-edited config where the key is indented.
    fs.writeFileSync(storagePaths.configFile, '  memories_enabled: false\n');
    // The indented line must be invisible so it cannot ghost a later canonical write.
    expect(getConfigValue('memories_enabled')).toBeUndefined();
  });

  it('does not replace a hand-indented key; appends a new canonical line instead', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, '  memories_enabled: false\n');

    setConfigValue('memories_enabled', 'true');

    const raw = fs.readFileSync(storagePaths.configFile, 'utf-8');
    // The original indented line must be untouched…
    expect(raw).toContain('  memories_enabled: false');
    // …and a new canonical key must have been appended at column 0.
    expect(raw).toContain('memories_enabled: true');
  });

  it('after the canonical write, getConfigValue returns the newly written value', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, '  memories_enabled: false\n');

    setConfigValue('memories_enabled', 'true');

    // Now there is a column-0 key: it must win.
    expect(getConfigValue('memories_enabled')).toBe('true');
  });

  it('reads and replaces a normal column-0 key correctly', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(storagePaths.configFile, 'memories_enabled: false\n');

    expect(getConfigValue('memories_enabled')).toBe('false');

    setConfigValue('memories_enabled', 'true');
    expect(getConfigValue('memories_enabled')).toBe('true');

    // Confirm only one key exists in the file (upsert, not append).
    const raw = fs.readFileSync(storagePaths.configFile, 'utf-8');
    const occurrences = (raw.match(/memories_enabled/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('full-line comment lines are still skipped regardless of indentation', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      storagePaths.configFile,
      '# top-level comment\n  # indented comment\nprovider: ollama\n',
    );
    expect(getConfigValue('provider')).toBe('ollama');
  });
});
