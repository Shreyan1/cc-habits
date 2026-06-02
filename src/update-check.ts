import fs from 'fs';
import { storagePaths } from './storage';

// npm latest-version check. Queries the public registry at most once per TTL
// window (cached in .update-check.json) and, when a newer version exists, builds
// a short upgrade notice that also surfaces the top features and the website.
//
// Design rules:
//   • Never block or slow the CLI: the network call is throttled and time-boxed,
//     and every failure path is silent (returns undefined / null).
//   • Never hit the network in CI/tests: respect CC_HABITS_NO_UPDATE_CHECK and
//     the standard NO_UPDATE_NOTIFIER / CI env vars.

const REGISTRY_URL = 'https://registry.npmjs.org/cc-habits/latest';
const WEBSITE_URL = 'https://shreyan1.github.io/cc-habits/';
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 1500;            // tight: this runs in front of the user
const FILE_MODE = 0o600;

interface UpdateCache {
  lastChecked: number;   // epoch ms of the last registry query
  latestVersion: string; // last version seen on the registry
}

// Parse a semver-ish string into [major, minor, patch], ignoring any prerelease
// or build suffix. Missing/invalid parts collapse to 0 so comparison stays total.
function parseVersion(v: string): [number, number, number] {
  const core = (v ?? '').trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.').map(p => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

// Returns true when `candidate` is strictly newer than `current`.
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function updateCheckDisabled(): boolean {
  const off = (name: string): boolean => {
    const v = (process.env[name] ?? '').toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'off';
  };
  return off('CC_HABITS_NO_UPDATE_CHECK') || off('NO_UPDATE_NOTIFIER') || off('CI');
}

function readCache(): UpdateCache | null {
  try {
    const raw = fs.readFileSync(storagePaths.updateCheckFile, 'utf-8');
    const data = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof data.lastChecked === 'number' && typeof data.latestVersion === 'string') {
      return { lastChecked: data.lastChecked, latestVersion: data.latestVersion };
    }
  } catch {
    // missing or malformed cache, treat as no cache
  }
  return null;
}

function writeCache(cache: UpdateCache): void {
  try {
    fs.mkdirSync(storagePaths.habitsDir, { recursive: true });
    fs.writeFileSync(storagePaths.updateCheckFile, JSON.stringify(cache) + '\n', {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
  } catch {
    // cache write is best-effort; never crash the CLI over it
  }
}

// Fetch the latest published version from the npm registry, time-boxed. Returns
// undefined on any network/parse error so callers can fall back to cache.
async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { version?: string };
    return typeof data.version === 'string' ? data.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the latest version using the throttle cache. Only queries the registry
// when the cache is missing or older than the TTL. Returns undefined when no
// version could be determined (offline first run, etc.).
export async function getLatestVersion(now: number = Date.now()): Promise<string | undefined> {
  const cache = readCache();
  if (cache && now - cache.lastChecked < CHECK_TTL_MS) {
    return cache.latestVersion;
  }
  const fetched = await fetchLatestVersion();
  if (fetched) {
    writeCache({ lastChecked: now, latestVersion: fetched });
    return fetched;
  }
  // Network failed: stamp the cache so we don't retry every command, but keep
  // whatever version we last knew (if any) for the notice.
  if (cache) {
    writeCache({ lastChecked: now, latestVersion: cache.latestVersion });
    return cache.latestVersion;
  }
  return undefined;
}

// Strip anything that is not a plausible semver character before a version is
// printed to the terminal. latestVersion comes from the npm registry response,
// which a MITM or a compromised registry could poison with terminal escape
// sequences; printing it raw would be terminal-escape injection. This mirrors
// the term() stripping the CLI applies to every other untrusted display string.
function safeVersion(v: string): string {
  return (v ?? '').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32);
}

// Build the upgrade notice shown when a newer version is available. Returns null
// when the installed version is already current (or newer, e.g. a dev build).
export function buildUpdateNotice(currentVersion: string, latestVersion: string): string | null {
  if (!isNewerVersion(latestVersion, currentVersion)) return null;
  return [
    `cc-habits: update available ${safeVersion(currentVersion)} -> ${safeVersion(latestVersion)}`,
    '  Upgrade:  npm install -g cc-habits@latest',
    '',
    '  Top features:',
    '    - Cross-tool habit learning across Claude Code, Gemini, Codex, Kimi, Cursor, Cline, and more',
    '    - Per-prompt re-injection that keeps your habits alive through context compaction',
    '    - Coding memories that learn the AI mistakes worth not repeating',
    '    - Review queue, tombstones, and confidence decay so you stay in control',
    '    - `cch sync` writes your habits into every rules file your other agents read',
    '',
    `  Learn more: ${WEBSITE_URL}`,
  ].join('\n');
}

// Orchestrator: resolve the latest version (cache-aware, time-boxed, fail-silent)
// and return the notice to print, or null when nothing should be shown. Disabled
// entirely in CI/tests or when the user opts out.
export async function maybeUpdateNotice(currentVersion: string): Promise<string | null> {
  if (updateCheckDisabled()) return null;
  try {
    const latest = await getLatestVersion();
    if (!latest) return null;
    return buildUpdateNotice(currentVersion, latest);
  } catch {
    return null;
  }
}
