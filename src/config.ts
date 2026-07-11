import fs from 'fs';
import { writeConfigFile, getPaths, type StorageContext } from './storage';

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

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read a single config value, or undefined when absent.
export function getConfigValue(key: string, ctx?: StorageContext): string | undefined {
  const text = readRaw(ctx);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const match = trimmed.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`));
    if (match) {
      let val = match[1].trim();
      let inDoubleQuote = false;
      let inSingleQuote = false;
      let hashIdx = -1;
      for (let i = 0; i < val.length; i++) {
        const char = val[i];
        if (char === '\\') {
          i++; // skip next char
          continue;
        }
        if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        } else if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (char === '#' && !inDoubleQuote && !inSingleQuote) {
          hashIdx = i;
          break;
        }
      }
      if (hashIdx >= 0) {
        val = val.slice(0, hashIdx).trim();
      }
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return undefined;
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
  const re = new RegExp(`^${escapeRegExp(key)}\\s*:.*$`, 'm');
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

// Persist the set of sync targets that processStop auto-refreshes after each
// learning session. cc-habits always writes preferences.md, which Claude Code
// reads via an @import in CLAUDE.md, so Claude's learn->inject loop is automatic.
// Tools that read a SYNCED file instead - Codex/Kimi via AGENTS.md, Gemini via
// GEMINI.md, Cline via .clinerules - only receive fresh habits when their target
// is listed here. init records the registered tools' targets so the loop closes
// automatically for them too, not just for Claude. Union with any existing value
// and never clobber a target the user added by hand.
export function addSyncTargets(targets: string[], ctx?: StorageContext): void {
  const clean = targets.map(t => t.trim()).filter(Boolean);
  if (clean.length === 0) return;
  // Read the existing list with the SAME comma-tolerant regex readSyncTargets
  // uses. We deliberately do NOT use getConfigValue here: its single-token regex
  // stops at the first space, so it would read "agents, gemini" back as just
  // "agents," and silently drop the rest on the next merge.
  let existing: string[] = [];
  try {
    const text = fs.readFileSync(getPaths(ctx).configFile, 'utf-8');
    const m = text.match(/^sync_targets\s*:\s*\[?([^\]\n#]+)\]?/m);
    if (m) existing = m[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
  } catch { /* no config yet */ }
  const merged = Array.from(new Set([...existing, ...clean])).sort();
  setConfigValue('sync_targets', merged.join(', '), ctx);
}

// Memory extraction is ON by default. Precedence: an explicit CC_HABITS_MEMORIES
// env value (on or off) always wins for the current shell, otherwise the
// persisted `memories_enabled` flag in config.yml, which is treated as enabled
// unless it has been explicitly set to a falsey value.
export function memoriesEnabled(ctx?: StorageContext): boolean {
  const env = (process.env['CC_HABITS_MEMORIES'] ?? '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  const v = (getConfigValue('memories_enabled', ctx) ?? '').toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
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

