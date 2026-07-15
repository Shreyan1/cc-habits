import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Read guard: if a log file somehow exceeds this we skip the read entirely.
const MAX_LOG_READ_BYTES = 50 * 1024 * 1024; // 50 MB

// Rotation: trim append-only files before they reach the read guard.
// Checked after every append so the file never silently fills the disk.
const LOG_ROTATE_BYTES = 2 * 1024 * 1024; // 2 MB, trim trigger
const LOG_ROTATE_LINES = 5_000;            // signals kept after trim
const HISTORY_ROTATE_LINES = 100;          // history snapshots kept after trim

export const FORMAT_VERSION = 'v0.3';

export interface Signal {
  ts: string;
  session_id: string;
  type: string;
  file: string;
  diff: string;
  language?: string;
  source?: 'claude-code' | 'git' | 'vscode' | 'cli' | 'gemini' | 'codex' | 'cline' | 'kimi' | 'antigravity';
}

export interface Habit {
  rule: string;
  confidence: number;
  reinforcing: number;
  contradicting: number;
  sessions_seen: number;
  last_session_id?: string;
  languages?: string[];
  first_learned?: string;
  last_updated?: string;
}

export type HabitsMap = Record<string, Habit[]>;

export function defaultRoot(): string {
  if (process.env['CC_HABITS_DIR']) {
    return process.env['CC_HABITS_DIR'];
  }
  try {
    let dir = process.cwd();
    while (true) {
      const candidate = path.join(dir, '.cc-habits');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fallback
  }
  return path.join(os.homedir(), '.cc-habits');
}


export const storagePaths = {
  habitsDir: defaultRoot(),
  habitsFile: path.join(defaultRoot(), 'habits.md'),
  preferencesFile: path.join(defaultRoot(), 'preferences.md'),
  memoriesFile: path.join(defaultRoot(), 'memories.md'),
  logFile: path.join(defaultRoot(), 'log.jsonl'),
  errorLog: path.join(defaultRoot(), 'error.log'),
  tombstonesFile: path.join(defaultRoot(), '.tombstones.json'),
  memoryTombstonesFile: path.join(defaultRoot(), '.memory-tombstones.json'),
  memoryIndexFile: path.join(defaultRoot(), '.memory-index.json'),
  snapshotFile: path.join(defaultRoot(), '.snapshot.json'),
  historyFile: path.join(defaultRoot(), '.history.jsonl'),
  provenanceFile: path.join(defaultRoot(), '.provenance.json'),
  // Throttle cache for the npm latest-version check, so we hit the registry at
  // most once per TTL window rather than on every CLI invocation.
  updateCheckFile: path.join(defaultRoot(), '.update-check.json'),
  // Random per-store id, used to recognise this machine's own exported profile
  // bundles on import. Carries no PII: it is a random UUID, not derived from
  // the hostname or username.
  machineIdFile: path.join(defaultRoot(), '.machine-id'),
  // config.yml lives in the same directory as habits.md so that CC_HABITS_DIR
  // overrides both the data files AND the provider config in one env var.
  configFile: path.join(defaultRoot(), 'config.yml'),
};

export interface StorageContext {
  habitsDir: string;
  habitsFile: string;
  preferencesFile: string;
  memoriesFile: string;
  logFile: string;
  errorLog: string;
  tombstonesFile: string;
  memoryTombstonesFile: string;
  memoryIndexFile: string;
  snapshotFile: string;
  historyFile: string;
  provenanceFile: string;
  updateCheckFile: string;
  machineIdFile: string;
  configFile: string;
}

export function getPaths(ctx?: StorageContext): StorageContext {
  return ctx || storagePaths;
}

// The per-repo store directory name. A `.cch/` folder at a repo root holds that
// repo's own habits, preferences, and memories, separate from the global
// ~/.cc-habits store. This stops one repo's specifics (e.g. a finance app's
// brand colors) from bleeding into unrelated repos via the global @import.
export const REPO_STORE_DIR = '.cch';

// Build a StorageContext rooted at <repoRoot>/.cch/. Every read/write that is
// passed this context operates on the repo-local store instead of the global
// one. Mirrors the shape of `storagePaths` exactly so it is a drop-in ctx.
export function repoStorageContext(repoRoot: string): StorageContext {
  const dir = path.join(repoRoot, REPO_STORE_DIR);
  return {
    habitsDir: dir,
    habitsFile: path.join(dir, 'habits.md'),
    preferencesFile: path.join(dir, 'preferences.md'),
    memoriesFile: path.join(dir, 'memories.md'),
    logFile: path.join(dir, 'log.jsonl'),
    errorLog: path.join(dir, 'error.log'),
    tombstonesFile: path.join(dir, '.tombstones.json'),
    memoryTombstonesFile: path.join(dir, '.memory-tombstones.json'),
    memoryIndexFile: path.join(dir, '.memory-index.json'),
    snapshotFile: path.join(dir, '.snapshot.json'),
    historyFile: path.join(dir, '.history.jsonl'),
    provenanceFile: path.join(dir, '.provenance.json'),
    updateCheckFile: path.join(dir, '.update-check.json'),
    // The repo store reuses the global machine id and provider config: both are
    // machine-level concerns, not per-repo ones.
    machineIdFile: storagePaths.machineIdFile,
    configFile: storagePaths.configFile,
  };
}

// Walk up from `start` looking for a repo root marker (.git). Returns the
// directory that contains it, or null if none is found before the filesystem
// root. Used to resolve where a `.cch/` store should live. Fail-safe: any error
// yields null so callers fall back to the global store.
export function findRepoRoot(start?: string): string | null {
  try {
    let dir = start || process.cwd();
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to null
  }
  return null;
}

const FILE_MODE = 0o600;

const HABITS_HEADER =
  `<!-- cc-habits format ${FORMAT_VERSION} -->\n` +
  '# Coding habits\n\n' +
  'Auto-generated by cc-habits. You may edit this file; rules you delete will not be recreated.\n';

const LEARNING_SECTION_HEADER =
  '\n## Learning (not yet active)\n\n' +
  '> These habits have been observed in only one session. They are quarantined ' +
  'here until reinforced in a second distinct session. Claude should not apply ' +
  'rules in this section.\n';

export const MEMORIES_FORMAT_VERSION = 'v0.1';

export interface Memory {
  text: string;
  trigger: string[];
  correction?: string;
  confidence: number;
  seen: number;
  sessions_seen: number;
  languages?: string[];
  first_seen?: string;
  last_seen?: string;
}

export type MemoriesMap = Record<string, Memory[]>;

const MEMORIES_HEADER =
  `<!-- cc-habits memories format ${MEMORIES_FORMAT_VERSION} -->\n` +
  '# Coding memories\n\n' +
  'Auto-generated by cc-habits. You may edit this file; memories you delete will not be recreated.\n';

const CANDIDATE_MEMORIES_SECTION_HEADER =
  '\n## Candidates (not yet active)\n\n' +
  '> These memories have not been observed enough times or approved by the user. ' +
  'Agents should not apply memories in this section.\n';

// Comment header seeded into a fresh log.jsonl so the file explains itself. Each
// line is prefixed with `//`, which every cc-habits reader skips (lines that fail
// JSON.parse are ignored), so it never interferes with signal parsing. It states
// the file's purpose and, crucially, why it can sit empty, since a brand-new repo
// store or a tool whose hook has not fired yet looks identical to a broken setup.
// No secrets here: this is static text, and the signals appended below are always
// redacted before they are written.
export const LOG_HEADER =
  '// cc-habits capture log (log.jsonl): append-only, redacted audit trail.\n' +
  '// Each line below is one edit signal (file path plus a trimmed, PII-redacted diff),\n' +
  '// captured when a registered AI tool runs its cc-habits hook. This is the exact record\n' +
  '// of what was stored and what would be sent to your extraction provider. Nothing else\n' +
  '// leaves your machine, and secrets are redacted before any line is written here.\n' +
  '// Empty? That is normal in two cases: (1) no edits have been captured yet because no\n' +
  '// registered hook has fired; make an edit in a linked tool and run cch status to confirm\n' +
  '// the hook is wired. (2) this is a per-repo .cch/ store, where repo scans (cch learn --repo)\n' +
  '// write to habits.md/memories.md, not here; only hook-captured edit signals land in this\n' +
  '// log, and the hook always writes to the global ~/.cc-habits/log.jsonl first.\n';

// Control characters that must never survive into a stored data file or a value
// later printed to the terminal: C0 controls and DEL (\x00-\x1f, \x7f) PLUS the
// C1 range (\x80-\x9f). C1 includes the 8-bit forms of CSI (\x9b) and OSC (\x9d),
// which terminals that honor 8-bit controls interpret as live ANSI escapes, so a
// crafted file path, session id, or memory could spoof terminal output or write
// the clipboard (the CVE-2025-55193 / tracing-subscriber class of bug). Stripping
// the whole C0+DEL+C1 set at every untrusted write surface closes that off at the
// source; the cli-ui `term()` helper is the matching defence at the output boundary.
// eslint-disable-next-line no-control-regex
const STORAGE_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export function ensureDirs(ctx?: StorageContext): void {
  fs.mkdirSync(getPaths(ctx).habitsDir, { recursive: true });
}

// Securely (re)write config.yml. Routes through safeWrite so the file is
// symlink-guarded and written atomically at mode 0600, even when config.yml
// already exists with looser permissions (writeFileSync would not retighten an
// existing file, leaving an API key potentially group/world readable). F2 fix.
export function writeConfigFile(content: string, ctx?: StorageContext): void {
  ensureDirs(ctx);
  safeWrite(getPaths(ctx).configFile, content);
}

function safeWrite(filePath: string, content: string): void {
  // Symlink guard: refuse to write if the target is already a symlink.  An attacker
  // who pre-creates ~/.claude/habits/habits.md → /etc/passwd before cc-habits runs
  // would otherwise cause us to overwrite arbitrary files.
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`refusing to write through symlink: ${filePath}`);
    }
  }
  // Atomic write: write to a hidden temp file in the SAME directory, then rename.
  // This guarantees (a) no partial write is visible to concurrent readers, and
  // (b) even if a symlink is created between our lstat and the rename, renameSync
  // replaces the directory entry itself, it does NOT follow symlinks on the target.
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.cc-habits-tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

function safeAppend(filePath: string, content: string): void {
  // O_NOFOLLOW (POSIX) makes open() fail atomically if the final path component is
  // a symlink, closing the TOCTOU window between our old lstat check and the write.
  const oNoFollow: number = (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
  if (oNoFollow) {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | oNoFollow;
    const fd = fs.openSync(filePath, flags, FILE_MODE);
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    // Windows fallback: lstat guard is best-effort (TOCTOU race still possible there).
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new Error(`refusing to append through symlink: ${filePath}`);
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    fs.appendFileSync(filePath, content, { encoding: 'utf-8', mode: FILE_MODE });
  }
}

// Trim an append-only JSONL file to its most-recent `maxLines` entries when the
// file exceeds LOG_ROTATE_BYTES. Called after every append so the file never
// silently grows past the 50 MB read guard. Best-effort: errors are swallowed
// so a rotation failure never blocks the caller.
function trimIfNeeded(filePath: string, maxLines: number): void {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= LOG_ROTATE_BYTES) return;
    const all = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(l => l.trim());
    // Preserve any leading `//` comment header (the self-describing log preamble)
    // so rotation trims only signal lines, never the explanation of the file.
    const header: string[] = [];
    let i = 0;
    while (i < all.length && all[i]!.startsWith('//')) { header.push(all[i]!); i++; }
    const records = all.slice(i);
    if (records.length <= maxLines) return;
    safeWrite(filePath, [...header, ...records.slice(-maxLines)].join('\n') + '\n');
  } catch {
    // trim is best-effort; never crash the caller
  }
}

export function initHabitsMd(ctx?: StorageContext): void {
  ensureDirs(ctx);
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.habitsFile)) {
    safeWrite(paths.habitsFile, HABITS_HEADER);
  }
}

export function initMemoriesMd(ctx?: StorageContext): void {
  ensureDirs(ctx);
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.memoriesFile)) {
    safeWrite(paths.memoriesFile, MEMORIES_HEADER);
  }
}

export function initLog(ctx?: StorageContext): void {
  ensureDirs(ctx);
  const paths = getPaths(ctx);
  // Write the header to new files AND to files that already exist but are empty,
  // so stores created before the LOG_HEADER was introduced get the self-describing
  // preamble the next time something calls initLog.
  const missing = !fs.existsSync(paths.logFile);
  if (missing) {
    safeWrite(paths.logFile, LOG_HEADER);
  } else {
    try {
      if (fs.statSync(paths.logFile).size === 0) safeWrite(paths.logFile, LOG_HEADER);
    } catch { /* leave the file as-is if we cannot stat it */ }
  }
}

export function appendSignal(signal: Signal, ctx?: StorageContext): void {
  ensureDirs(ctx);
  const paths = getPaths(ctx);
  // Seed the self-describing header if this append is the first thing to touch
  // the log. Passive capture is designed to run before `cch init` ever does, so
  // the hook can create the global log.jsonl on its own; without this the global
  // log, the one that actually fills with signals, would be the only store
  // missing the header. Mirrors initLog's missing/empty seeding.
  try {
    if (!fs.existsSync(paths.logFile) || fs.statSync(paths.logFile).size === 0) {
      safeWrite(paths.logFile, LOG_HEADER);
    }
  } catch { /* seeding is best-effort; never block a capture */ }
  // Strip control characters from session_id before writing to JSONL.
  // JSON.stringify escapes them anyway, but defence-in-depth: a crafted session_id
  // with null bytes or other controls could confuse downstream parsers or logging.
  const safe: Signal = { ...signal, session_id: signal.session_id.replace(STORAGE_CONTROL_CHARS, '') };
  safeAppend(paths.logFile, JSON.stringify(safe) + '\n');
  trimIfNeeded(paths.logFile, LOG_ROTATE_LINES);
}

export function readSignals(sessionId?: string, ctx?: StorageContext): Signal[] {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.logFile)) return [];
  // Guard against reading a runaway log file that could exhaust process memory.
  const stat = fs.statSync(paths.logFile);
  if (stat.size > MAX_LOG_READ_BYTES) {
    // Log the oversized-file event and return empty rather than crash.
    logError(`readSignals: log.jsonl exceeds ${MAX_LOG_READ_BYTES} bytes; skipping read`, ctx);
    return [];
  }
  const buf = fs.readFileSync(paths.logFile);
  const signals: Signal[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { // '\n'
      const line = buf.toString('utf-8', start, i).trim();
      start = i + 1;
      if (!line) continue;
      try {
        const sig = JSON.parse(line) as Signal;
        if (!sessionId || sig.session_id === sessionId) signals.push(sig);
      } catch {
        // skip malformed line
      }
    }
  }
  if (start < buf.length) {
    const line = buf.toString('utf-8', start, buf.length).trim();
    if (line) {
      try {
        const sig = JSON.parse(line) as Signal;
        if (!sessionId || sig.session_id === sessionId) signals.push(sig);
      } catch {
        // skip malformed line
      }
    }
  }
  return signals;
}

/**
 * Count signals for a session without parsing each line into an object.
 *
 * readSignals() JSON.parses every line (up to LOG_ROTATE_LINES = 5,000) and
 * builds an array; callers that only need the count (e.g. the session-start
 * banner) pay that whole cost to read a single number. This scans the file once
 * for the serialized session field as a substring instead: allocation-free and
 * O(file length). Each signal line carries exactly one `"session_id":` field, so
 * the occurrence count equals readSignals(sessionId).length for well-formed logs.
 * The only divergence is a pathological diff that embedded the exact field text
 * of another session, which is cosmetic-only for the count's use sites.
 */
export function countSignals(sessionId?: string, ctx?: StorageContext): number {
  const paths = getPaths(ctx);
  // No existsSync precheck: an absent file throws ENOENT, which the catch turns
  // into 0. This also closes the existsSync -> stat -> read TOCTOU gap where the
  // file could vanish or change between the calls. Read raw bytes and scan the
  // Buffer directly: the file is UTF-8, so matching the UTF-8-encoded needle
  // against the bytes avoids decoding the whole 2 MB log into a UTF-16 string
  // just to count a substring.
  let buf: Buffer;
  let fd: number | null = null;
  try {
    // Same runaway-file guard as readSignals: skip rather than risk memory blowup.
    const oNoFollow: number = (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
    fd = fs.openSync(paths.logFile, fs.constants.O_RDONLY | oNoFollow);
    const st = fs.fstatSync(fd);
    if (st.size > MAX_LOG_READ_BYTES) {
      logError(`countSignals: log.jsonl exceeds ${MAX_LOG_READ_BYTES} bytes; skipping read`, ctx);
      fs.closeSync(fd);
      return 0;
    }
    buf = fs.readFileSync(fd);
    fs.closeSync(fd);
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    return 0; // absent, vanished mid-read, or unreadable
  }
  // With a session id, match its exact serialized field; without one, match the
  // field key present on every signal line (counts all sessions).
  const needleStr = sessionId ? `"session_id":${JSON.stringify(sessionId)}` : '"session_id":';
  const needle = Buffer.from(needleStr, 'utf-8');
  let count = 0;
  let pos = buf.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = buf.indexOf(needle, pos + needle.length);
  }
  return count;
}

export function readHabitsMd(ctx?: StorageContext): string {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.habitsFile)) return HABITS_HEADER;
  return fs.readFileSync(paths.habitsFile, 'utf-8');
}

export function writeHabitsMd(content: string, ctx?: StorageContext): void {
  ensureDirs(ctx);
  safeWrite(getPaths(ctx).habitsFile, content);
}

export function readMemoriesMd(ctx?: StorageContext): string {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.memoriesFile)) return MEMORIES_HEADER;
  return fs.readFileSync(paths.memoriesFile, 'utf-8');
}

export function writeMemoriesMd(content: string, ctx?: StorageContext): void {
  ensureDirs(ctx);
  safeWrite(getPaths(ctx).memoriesFile, content);
}

// Tombstones (A2) ──────────────────────────────────────────────────────────
function normalizeRule(s: string): string {
  return s.trim().replace(/\.$/, '').toLowerCase();
}

// Fuzzy tombstone matching ──────────────────────────────────────────────────
// Exact normalized matching alone lets a reworded-but-equivalent rule slip past
// the "never re-learned" guarantee. We add a deterministic token-overlap layer
// that catches near-duplicate phrasings (e.g. swapping one word, reordering).
// Deep synonym rewordings ("type hints on signatures" vs "explicit type
// annotations for parameters and return types") share too little vocabulary to
// catch lexically without false positives, those are handled upstream by
// feeding tombstones into the extraction prompt.
const TOMBSTONE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'use',
  'using', 'do', 'not', 'always', 'never', 'prefer', 'should', 'must', 'when',
  'that', 'this', 'your', 'all', 'any', 'as', 'is', 'are', 'be', 'it', 'its',
  'into', 'from', 'at', 'by', 'avoid', 'instead',
]);

// Significant content tokens: lowercase, alnum-only, stopwords removed, light
// plural stemming so "types"/"type" and "hints"/"hint" collapse together.
function significantTokens(s: string): Set<string> {
  return new Set(
    normalizeRule(s)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map(t => t.replace(/s$/, ''))
      .filter(t => t.length > 2 && !TOMBSTONE_STOPWORDS.has(t)),
  );
}

// Jaccard similarity of two rules' significant-token sets.
function ruleSimilarity(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

// A near-duplicate shares most of its vocabulary. Require both a high Jaccard
// score and at least two shared content tokens so short rules (1–2 tokens) only
// ever match exactly and cannot trigger spurious fuzzy blocks.
const TOMBSTONE_SIMILARITY_THRESHOLD = 0.5;
const TOMBSTONE_MIN_SHARED_TOKENS = 2;

function isFuzzyMatch(candidate: string, tombstoned: string): boolean {
  const ca = significantTokens(candidate);
  const cb = significantTokens(tombstoned);
  let shared = 0;
  for (const t of ca) if (cb.has(t)) shared++;
  if (shared < TOMBSTONE_MIN_SHARED_TOKENS) return false;
  return ruleSimilarity(candidate, tombstoned) >= TOMBSTONE_SIMILARITY_THRESHOLD;
}

export function readTombstones(ctx?: StorageContext): string[] {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.tombstonesFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(paths.tombstonesFile, 'utf-8')) as unknown;
    if (Array.isArray(data)) return data.filter((x): x is string => typeof x === 'string');
  } catch {
    // malformed, treat as empty
  }
  return [];
}

export function writeTombstones(rules: string[], ctx?: StorageContext): void {
  ensureDirs(ctx);
  const unique = Array.from(new Set(rules.map(normalizeRule))).filter(Boolean);
  safeWrite(getPaths(ctx).tombstonesFile, JSON.stringify(unique, null, 2) + '\n');
}

export function addTombstone(rule: string, ctx?: StorageContext): void {
  const current = readTombstones(ctx);
  current.push(normalizeRule(rule));
  writeTombstones(current, ctx);
}

// Match one rule against an already-loaded tombstone list. Fast path: exact
// normalized match. Fallback: fuzzy near-duplicate match so a lightly reworded
// variant of a deleted rule is still blocked. Exported so hot paths (per-prompt
// injection) can read the tombstone file once and match many rules against it.
export function matchesTombstone(rule: string, tombstones: string[]): boolean {
  const target = normalizeRule(rule);
  return tombstones.some(t => t === target || isFuzzyMatch(rule, t));
}

export function isTombstoned(rule: string, ctx?: StorageContext): boolean {
  return matchesTombstone(rule, readTombstones(ctx));
}

// Memory tombstones ────────────────────────────────────────────────────────
export function readMemoryTombstones(ctx?: StorageContext): string[] {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.memoryTombstonesFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(paths.memoryTombstonesFile, 'utf-8')) as unknown;
    if (Array.isArray(data)) return data.filter((x): x is string => typeof x === 'string');
  } catch {
    // malformed, treat as empty
  }
  return [];
}

function writeMemoryTombstones(texts: string[], ctx?: StorageContext): void {
  ensureDirs(ctx);
  const unique = Array.from(new Set(texts.map(normalizeRule))).filter(Boolean);
  safeWrite(getPaths(ctx).memoryTombstonesFile, JSON.stringify(unique, null, 2) + '\n');
}

export function addMemoryTombstone(text: string, ctx?: StorageContext): void {
  const current = readMemoryTombstones(ctx);
  current.push(normalizeRule(text));
  writeMemoryTombstones(current, ctx);
}

export function isMemoryTombstoned(text: string, ctx?: StorageContext): boolean {
  return matchesTombstone(text, readMemoryTombstones(ctx));
}

// Machine id (profile export provenance) ────────────────────────────────────
// A random UUID persisted alongside the store, stamped into exported profile
// bundles as `origin:`. On import, a matching origin means "this machine's own
// export", so its habit history (sessions_seen) can be trusted verbatim.
// Fail-open: any read/write error returns '' which importers treat as
// "cannot verify origin", never as a crash.
export function getMachineId(): string {
  try {
    const existing = fs.readFileSync(storagePaths.machineIdFile, 'utf-8').trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    // missing or unreadable, fall through to (re)create
  }
  try {
    const id = crypto.randomUUID();
    fs.mkdirSync(storagePaths.habitsDir, { recursive: true });
    fs.writeFileSync(storagePaths.machineIdFile, id + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    return id;
  } catch {
    return '';
  }
}

// Snapshot (auto-detect manual deletes) ────────────────────────────────────
export function readSnapshot(ctx?: StorageContext): HabitsMap | null {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.snapshotFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.snapshotFile, 'utf-8')) as HabitsMap;
  } catch {
    return null;
  }
}

export function writeSnapshot(cats: HabitsMap, ctx?: StorageContext): void {
  ensureDirs(ctx);
  safeWrite(getPaths(ctx).snapshotFile, JSON.stringify(cats, null, 2));
}

// Compare snapshot to current parsed habits.md. Any rule present in snapshot
// but absent from current was manually deleted by the user, tombstone it.
export function detectManualDeletes(current: HabitsMap, ctx?: StorageContext): string[] {
  const snapshot = readSnapshot(ctx);
  if (snapshot === null) return [];
  const currentRules = new Set<string>();
  for (const habits of Object.values(current)) {
    for (const h of habits) currentRules.add(normalizeRule(h.rule));
  }
  const deleted: string[] = [];
  for (const habits of Object.values(snapshot)) {
    for (const h of habits) {
      const norm = normalizeRule(h.rule);
      if (!currentRules.has(norm)) deleted.push(norm);
    }
  }
  return deleted;
}

// History (B1: diff) ───────────────────────────────────────────────────────
export interface HistoryEntry {
  ts: string;
  session_id?: string;
  habits_md: string;
}

export function appendHistory(entry: HistoryEntry, ctx?: StorageContext): void {
  ensureDirs(ctx);
  const paths = getPaths(ctx);
  safeAppend(paths.historyFile, JSON.stringify(entry) + '\n');
  trimIfNeeded(paths.historyFile, HISTORY_ROTATE_LINES);
}

export function readHistory(ctx?: StorageContext): HistoryEntry[] {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.historyFile)) return [];
  const stat = fs.statSync(paths.historyFile);
  if (stat.size > MAX_LOG_READ_BYTES) {
    logError(`readHistory: .history.jsonl exceeds ${MAX_LOG_READ_BYTES} bytes; skipping read`, ctx);
    return [];
  }
  const buf = fs.readFileSync(paths.historyFile);
  const out: HistoryEntry[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { // '\n'
      const line = buf.toString('utf-8', start, i).trim();
      start = i + 1;
      if (!line) continue;
      try { out.push(JSON.parse(line) as HistoryEntry); } catch { /* skip */ }
    }
  }
  if (start < buf.length) {
    const line = buf.toString('utf-8', start, buf.length).trim();
    if (line) {
      try { out.push(JSON.parse(line) as HistoryEntry); } catch { /* skip */ }
    }
  }
  return out;
}

// Provenance (B2: explain) ─────────────────────────────────────────────────
export interface ProvenanceRef {
  ts: string;
  session_id: string;
  file: string;
  snippet: string;
  decision: string;
}

export type ProvenanceMap = Record<string, ProvenanceRef[]>;

export function readProvenance(ctx?: StorageContext): ProvenanceMap {
  const paths = getPaths(ctx);
  if (!fs.existsSync(paths.provenanceFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(paths.provenanceFile, 'utf-8')) as ProvenanceMap;
  } catch {
    return {};
  }
}

export function writeProvenance(m: ProvenanceMap, ctx?: StorageContext): void {
  ensureDirs(ctx);
  safeWrite(getPaths(ctx).provenanceFile, JSON.stringify(m, null, 2));
}

export function appendProvenance(ruleKey: string, refs: ProvenanceRef[], ctx?: StorageContext): void {
  const map = readProvenance(ctx);
  const key = ruleKey.trim().replace(/\.$/, '').toLowerCase();
  const existing = map[key] ?? [];
  // Cap per-rule provenance at 10 most-recent entries to bound disk usage.
  const merged = [...existing, ...refs].slice(-10);
  map[key] = merged;
  writeProvenance(map, ctx);
}

export function lookupProvenance(rule: string, ctx?: StorageContext): ProvenanceRef[] {
  const key = rule.trim().replace(/\.$/, '').toLowerCase();
  const map = readProvenance(ctx);
  if (map[key]) return map[key];
  // Fuzzy: substring match.
  for (const k of Object.keys(map)) {
    if (k.includes(key) || key.includes(k)) return map[k];
  }
  return [];
}

// Habits parsing / serialising ─────────────────────────────────────────────
export function parseHabits(md: string): HabitsMap {
  const cats: HabitsMap = {};
  let currentCat: string | null = null;
  let currentHabit: Habit | null = null;
  let inLearning = false;

  const flush = (): void => {
    if (currentHabit !== null && currentCat !== null) {
      if (!cats[currentCat]) cats[currentCat] = [];
      cats[currentCat].push(currentHabit);
      currentHabit = null;
    }
  };

  for (const line of md.split('\n')) {
    if (line.startsWith('## Learning')) {
      flush();
      inLearning = true;
      currentCat = null;
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      currentCat = line.slice(3).trim();
      inLearning = false;
      if (!cats[currentCat]) cats[currentCat] = [];
    } else if (line.startsWith('- ')) {
      // In the learning section, lines are prefixed with [Category]
      let bodyLine = line;
      let learnCat: string | null = null;
      if (inLearning) {
        const m = line.match(/^- \[([^\]]+)\]\s+(.+)$/);
        if (!m) continue;
        learnCat = m[1].trim();
        bodyLine = `- ${m[2]}`;
      }
      const m = bodyLine.match(/^- (.+?)\.\s+Confidence:\s+([\d.]+)/);
      if (m) {
        flush();
        const cat: string | null = inLearning ? learnCat : currentCat;
        if (cat === null) continue;
        if (!cats[cat]) cats[cat] = [];
        currentHabit = {
          rule: m[1].trim(),
          confidence: parseFloat(m[2]),
          reinforcing: 0,
          contradicting: 0,
          sessions_seen: 1,
        };
        // Adopt this category for flushing
        currentCat = cat;
      }
    } else if (line.trim().startsWith('- Signal:') && currentHabit !== null) {
      const m = line.match(/- Signal:\s*(\d+)\s+reinforcing,\s*(\d+)\s+contradicting/);
      if (m) {
        currentHabit.reinforcing = parseInt(m[1], 10);
        currentHabit.contradicting = parseInt(m[2], 10);
      }
    } else if (line.trim().startsWith('- Sessions seen:') && currentHabit !== null) {
      const m = line.match(/- Sessions seen:\s*(\d+)/);
      if (m) currentHabit.sessions_seen = parseInt(m[1], 10);
    } else if (line.trim().startsWith('- Languages:') && currentHabit !== null) {
      const m = line.match(/- Languages:\s*(.+)/);
      if (m) currentHabit.languages = m[1].split(',').map(s => s.trim()).filter(Boolean);
    } else if (line.trim().startsWith('- First learned:') && currentHabit !== null) {
      currentHabit.first_learned = line.split(':').slice(1).join(':').trim();
    } else if (line.trim().startsWith('- Last updated:') && currentHabit !== null) {
      currentHabit.last_updated = line.split(':').slice(1).join(':').trim();
    }
  }

  flush();
  return cats;
}

function renderHabit(h: Habit, lines: string[], categoryPrefix?: string): void {
  const rule = h.rule.trim().replace(/\.$/, '');
  const prefix = categoryPrefix ? `[${categoryPrefix}] ` : '';
  lines.push(`- ${prefix}${rule}. Confidence: ${h.confidence.toFixed(2)}`);
  lines.push(`  - Signal: ${h.reinforcing} reinforcing, ${h.contradicting} contradicting`);
  lines.push(`  - Sessions seen: ${h.sessions_seen}`);
  if (h.languages && h.languages.length > 0) {
    lines.push(`  - Languages: ${h.languages.join(', ')}`);
  }
  if (h.first_learned) lines.push(`  - First learned: ${h.first_learned}`);
  if (h.last_updated) lines.push(`  - Last updated: ${h.last_updated}`);
  lines.push('');
}

export function serialiseHabits(cats: HabitsMap): string {
  const lines: string[] = [
    `<!-- cc-habits format ${FORMAT_VERSION} -->`,
    '# Coding habits',
    '',
    'Auto-generated by cc-habits. You may edit this file; rules you delete will not be recreated.',
  ];

  const active: HabitsMap = {};
  const learning: Array<[string, Habit]> = [];

  for (const category of Object.keys(cats)) {
    for (const h of cats[category] ?? []) {
      if ((h.sessions_seen ?? 1) >= 2) {
        if (!active[category]) active[category] = [];
        active[category].push(h);
      } else {
        learning.push([category, h]);
      }
    }
  }

  for (const category of Object.keys(active).sort()) {
    const habits = active[category];
    if (!habits || habits.length === 0) continue;
    lines.push('', `## ${category}`, '');
    for (const h of habits) renderHabit(h, lines);
  }

  if (learning.length > 0) {
    lines.push(LEARNING_SECTION_HEADER);
    for (const [category, h] of learning) renderHabit(h, lines, category);
  }

  return lines.join('\n');
}

// Memories parsing / serialising ──────────────────────────────────────────
function splitList(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function stripFinalPeriod(s: string): string {
  return s.trim().replace(/\.$/, '');
}

export function parseMemories(md: string): MemoriesMap {
  const sections: MemoriesMap = {};
  let currentSection: string | null = null;
  let currentMemory: Memory | null = null;
  let inCandidates = false;

  const flush = (): void => {
    if (currentMemory !== null && currentSection !== null) {
      if (!sections[currentSection]) sections[currentSection] = [];
      sections[currentSection].push(currentMemory);
      currentMemory = null;
    }
  };

  for (const line of md.split('\n')) {
    if (line.startsWith('## Candidates')) {
      flush();
      inCandidates = true;
      currentSection = null;
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      currentSection = line.slice(3).trim();
      inCandidates = false;
      if (!sections[currentSection]) sections[currentSection] = [];
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      let body = line.slice(2).trim();
      let targetSection = currentSection;
      if (inCandidates) {
        const m = body.match(/^\[([^\]]+)\]\s+(.+)$/);
        if (!m) continue;
        targetSection = m[1].trim();
        body = m[2].trim();
      }
      if (targetSection === null) continue;
      if (!sections[targetSection]) sections[targetSection] = [];
      currentSection = targetSection;
      currentMemory = {
        text: stripFinalPeriod(body),
        trigger: [],
        confidence: inCandidates ? 0.50 : 0.70,
        seen: 1,
        sessions_seen: inCandidates ? 1 : 2,
      };
      continue;
    }
    if (currentMemory === null) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('- Trigger:')) {
      currentMemory.trigger = splitList(trimmed.split(':').slice(1).join(':'));
    } else if (trimmed.startsWith('- Correction:')) {
      currentMemory.correction = trimmed.split(':').slice(1).join(':').trim();
    } else if (trimmed.startsWith('- Confidence:')) {
      const n = parseFloat(trimmed.split(':').slice(1).join(':').trim());
      if (!Number.isNaN(n)) currentMemory.confidence = n;
    } else if (trimmed.startsWith('- Seen:')) {
      const n = parseInt(trimmed.split(':').slice(1).join(':').trim(), 10);
      if (!Number.isNaN(n)) currentMemory.seen = n;
    } else if (trimmed.startsWith('- Sessions seen:')) {
      const n = parseInt(trimmed.split(':').slice(1).join(':').trim(), 10);
      if (!Number.isNaN(n)) currentMemory.sessions_seen = n;
    } else if (trimmed.startsWith('- Languages:')) {
      currentMemory.languages = splitList(trimmed.split(':').slice(1).join(':'));
    } else if (trimmed.startsWith('- First seen:')) {
      currentMemory.first_seen = trimmed.split(':').slice(1).join(':').trim();
    } else if (trimmed.startsWith('- Last seen:')) {
      currentMemory.last_seen = trimmed.split(':').slice(1).join(':').trim();
    }
  }

  flush();
  return sections;
}

function renderMemory(memory: Memory, lines: string[], sectionPrefix?: string): void {
  const prefix = sectionPrefix ? `[${sectionPrefix}] ` : '';
  lines.push(`- ${prefix}${stripFinalPeriod(memory.text)}.`);
  if (memory.trigger.length > 0) {
    lines.push(`  - Trigger: ${memory.trigger.join(', ')}`);
  }
  if (memory.correction) lines.push(`  - Correction: ${memory.correction}`);
  lines.push(`  - Confidence: ${memory.confidence.toFixed(2)}`);
  lines.push(`  - Seen: ${memory.seen}`);
  lines.push(`  - Sessions seen: ${memory.sessions_seen}`);
  if (memory.languages && memory.languages.length > 0) {
    lines.push(`  - Languages: ${memory.languages.join(', ')}`);
  }
  if (memory.first_seen) lines.push(`  - First seen: ${memory.first_seen}`);
  if (memory.last_seen) lines.push(`  - Last seen: ${memory.last_seen}`);
  lines.push('');
}

export function serialiseMemories(sections: MemoriesMap): string {
  const lines: string[] = [
    `<!-- cc-habits memories format ${MEMORIES_FORMAT_VERSION} -->`,
    '# Coding memories',
    '',
    'Auto-generated by cc-habits. You may edit this file; memories you delete will not be recreated.',
  ];

  const active: MemoriesMap = {};
  const candidates: Array<[string, Memory]> = [];

  for (const section of Object.keys(sections)) {
    for (const memory of sections[section] ?? []) {
      if ((memory.sessions_seen ?? 1) >= 2) {
        if (!active[section]) active[section] = [];
        active[section].push(memory);
      } else {
        candidates.push([section, memory]);
      }
    }
  }

  for (const section of Object.keys(active).sort()) {
    const memories = active[section];
    if (!memories || memories.length === 0) continue;
    lines.push('', `## ${section}`, '');
    for (const memory of memories) renderMemory(memory, lines);
  }

  if (candidates.length > 0) {
    lines.push(CANDIDATE_MEMORIES_SECTION_HEADER);
    for (const [section, memory] of candidates) renderMemory(memory, lines, section);
  }

  return lines.join('\n');
}

// Memory update application ───────────────────────────────────────────────
function normalizeMemoryText(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

export interface MemoryCandidate {
  section: string;
  text: string;
  trigger: string[];
  correction: string;
}

export function applyMemoryUpdates(
  candidates: MemoryCandidate[],
  ctx?: StorageContext,
  addedMemories?: string[],
  updatedMemories?: string[],
): number {
  if (candidates.length === 0) return 0;
  initMemoriesMd(ctx);
  const md = readMemoriesMd(ctx);
  const sections = parseMemories(md);
  const today = new Date().toISOString().slice(0, 10);
  let newCount = 0;

  for (const candidate of candidates) {
    if (isMemoryTombstoned(candidate.text, ctx)) continue;
    const section = candidate.section || 'Repeated mistakes';
    if (!sections[section]) sections[section] = [];
    const normalised = normalizeMemoryText(candidate.text);
    const existing = sections[section].find(m => normalizeMemoryText(m.text) === normalised);
    if (existing) {
      existing.seen = (existing.seen ?? 1) + 1;
      existing.sessions_seen = Math.min((existing.sessions_seen ?? 1) + 1, 99);
      existing.confidence = Math.min(+(existing.confidence + 0.10).toFixed(2), 0.95);
      existing.last_seen = today;
      updatedMemories?.push(existing.text);
    } else {
      // Strip terminal control characters (incl. the 8-bit C1 CSI/OSC range) from
      // every stored memory field. Unlike habits, memory candidates are not run
      // through the full injection sanitizer at write time, so without this an
      // attacker-authored correction could plant ANSI escapes that fire when the
      // file is rendered by `cch memories`. The injection-time sanitizeRule in
      // hook.ts is the second layer; this keeps the stored file and terminal clean.
      const scrub = (s: string): string => s.replace(STORAGE_CONTROL_CHARS, '');
      const cleanedText = scrub(candidate.text).replace(/\.$/, '');
      sections[section].push({
        text: cleanedText,
        trigger: candidate.trigger.map(scrub),
        correction: scrub(candidate.correction),
        confidence: 0.50,
        seen: 1,
        sessions_seen: 1,
        first_seen: today,
        last_seen: today,
      });
      newCount++;
      addedMemories?.push(cleanedText);
    }
  }

  writeMemoriesMd(serialiseMemories(sections), ctx);
  return newCount;
}

export function logError(msg: string, ctx?: StorageContext): void {
  try {
    ensureDirs(ctx);
    const entry = `[${new Date().toISOString()}] ${msg}\n`;
    safeAppend(getPaths(ctx).errorLog, entry);
    trimIfNeeded(getPaths(ctx).errorLog, 1_000);
  } catch {
    // never crash
  }
}

/**
 * Tighten any private store file an older cc-habits version may have created with
 * group/other-readable permissions. Newer writes use FILE_MODE (0600), but O_CREAT
 * does not change an existing file's mode, so e.g. a log.jsonl created before the
 * 0600 enforcement keeps its old 0644. Runs once per CLI invocation; best-effort and
 * silent so it can never block a command. Symlinks are skipped, never chmod'd through.
 */
export function tightenLegacyModes(ctx?: StorageContext): void {
  const dir = getPaths(ctx).habitsDir;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // store dir absent: nothing to tighten
  }
  for (const name of entries) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) !== 0) {
        fs.chmodSync(f, FILE_MODE);
      }
    } catch {
      // absent, unstattable, or chmod denied: skip this entry
    }
  }
}

// Path sanitization (S4) ───────────────────────────────────────────────────
export function sanitizeFilePath(p: string): string {
  // Strip any traversal segments; collapse to a safe representation.
  // We keep the path for human-readability but drop dangerous fragments.
  if (!p) return '';
  // Reject literal control characters that could break log line parsing or, once
  // displayed in `cch status`, inject terminal escape sequences. Covers C0, DEL,
  // and C1 (the 8-bit CSI/OSC range), not just C0.
  const cleaned = p.replace(STORAGE_CONTROL_CHARS, '');
  // Block path traversal: replace `..` segments with `_` so the displayed
  // path is unambiguous and cannot be re-interpreted by other tools.
  return cleaned.split('/').map(seg => seg === '..' ? '_' : seg).join('/');
}

export function getRuleHash(text: string): string {
  const clean = text.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'cch' + crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8);
}
