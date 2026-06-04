import fs from 'fs';
import { storagePaths, writeConfigFile } from './storage';

// Small line-based reader/writer for the YAML-ish config.yml. We deliberately
// avoid a YAML dependency: the file is flat `key: value` pairs written by
// `cch init` and by these helpers. Reads tolerate quotes and surrounding space.

function readRaw(): string {
  try {
    return fs.readFileSync(storagePaths.configFile, 'utf-8');
  } catch {
    return '';
  }
}

// Read a single config value, or undefined when absent.
export function getConfigValue(key: string): string | undefined {
  const text = readRaw();
  const m = text.match(new RegExp(`^${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`, 'm'));
  return m ? m[1] : undefined;
}

// Interpret a value as a boolean flag. Accepts 1/true/on (case-insensitive).
export function getConfigFlag(key: string): boolean {
  const v = (getConfigValue(key) ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// Upsert a single key, preserving every other line. Creates the file (0600)
// and parent dir when missing.
export function setConfigValue(key: string, value: string): void {
  const text = readRaw();
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}\\s*:.*$`, 'm');
  let next: string;
  if (re.test(text)) {
    next = text.replace(re, line);
  } else {
    next = text.length && !text.endsWith('\n') ? `${text}\n${line}\n` : `${text}${line}\n`;
  }
  // Route through writeConfigFile so the write is symlink-guarded and lands at
  // mode 0600 even if config.yml already exists with looser permissions. F2 fix.
  writeConfigFile(next);
}

// Memory extraction is opt-in. Precedence: an explicit CC_HABITS_MEMORIES env
// value (on or off) always wins for the current shell, otherwise fall back to
// the persisted `memories_enabled` flag in config.yml.
export function memoriesEnabled(): boolean {
  const env = (process.env['CC_HABITS_MEMORIES'] ?? '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  return getConfigFlag('memories_enabled');
}

export function setMemoriesEnabled(enabled: boolean): void {
  setConfigValue('memories_enabled', enabled ? 'true' : 'false');
}

export function isGloballyDisabled(): boolean {
  return getConfigFlag('disabled');
}

export function setGloballyDisabled(disabled: boolean): void {
  setConfigValue('disabled', disabled ? 'true' : 'false');
}

// Consent tracking (L5) ────────────────────────────────────────────────────
// Records explicit user consent at `cch init` time with a timestamp.
// Consent is stored in config.yml as:  consent_given: <ISO-8601 timestamp>
// The presence of a valid timestamp means the user acknowledged the data notice.

export function consentGiven(): boolean {
  const v = getConfigValue('consent_given');
  return !!v && v.length > 0;
}

export function recordConsent(): void {
  setConfigValue('consent_given', new Date().toISOString());
}
