import fs from 'fs';
import { storagePaths, writeConfigFile, getPaths, type StorageContext } from './storage';

// Small line-based reader/writer for the YAML-ish config.yml. We deliberately
// avoid a YAML dependency: the file is flat `key: value` pairs written by
// `cch init` and by these helpers. Reads tolerate quotes and surrounding space.

function readRaw(ctx?: StorageContext): string {
  try {
    return fs.readFileSync(getPaths(ctx).configFile, 'utf-8');
  } catch {
    return '';
  }
}

// Read a single config value, or undefined when absent.
export function getConfigValue(key: string, ctx?: StorageContext): string | undefined {
  const text = readRaw(ctx);
  const m = text.match(new RegExp(`^${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`, 'm'));
  return m ? m[1] : undefined;
}

// Interpret a value as a boolean flag. Accepts 1/true/on (case-insensitive).
export function getConfigFlag(key: string, ctx?: StorageContext): boolean {
  const v = (getConfigValue(key, ctx) ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// Upsert a single key, preserving every other line. Creates the file (0600)
// and parent dir when missing.
export function setConfigValue(key: string, value: string, ctx?: StorageContext): void {
  const text = readRaw(ctx);
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
  writeConfigFile(next, ctx);
}

// Memory extraction is opt-in. Precedence: an explicit CC_HABITS_MEMORIES env
// value (on or off) always wins for the current shell, otherwise fall back to
// the persisted `memories_enabled` flag in config.yml.
export function memoriesEnabled(ctx?: StorageContext): boolean {
  const env = (process.env['CC_HABITS_MEMORIES'] ?? '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  return getConfigFlag('memories_enabled', ctx);
}

export function setMemoriesEnabled(enabled: boolean, ctx?: StorageContext): void {
  setConfigValue('memories_enabled', enabled ? 'true' : 'false', ctx);
}

export function isGloballyDisabled(ctx?: StorageContext): boolean {
  return getConfigFlag('disabled', ctx);
}

export function setGloballyDisabled(disabled: boolean, ctx?: StorageContext): void {
  setConfigValue('disabled', disabled ? 'true' : 'false', ctx);
}

// Consent tracking (L5) ────────────────────────────────────────────────────
// Records explicit user consent at `cch init` time with a timestamp.
// Consent is stored in config.yml as:  consent_given: <ISO-8601 timestamp>
// The presence of a valid timestamp means the user acknowledged the data notice.

export function consentGiven(ctx?: StorageContext): boolean {
  const v = getConfigValue('consent_given', ctx);
  return !!v && v.length > 0;
}

export function recordConsent(ctx?: StorageContext): void {
  setConfigValue('consent_given', new Date().toISOString(), ctx);
}

