import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  defaultRoot,
  readHabitsMd,
  writeHabitsMd,
  parseHabits,
  serialiseHabits,
  readMemoriesMd,
  applyMemoryUpdates,
  logError,
  type StorageContext,
} from './storage';
import { applyUpdates, type AppliedChange } from './confidence';
import { extractHabitsFromRepo, extractMemoriesFromDocs, type RepoFile } from './extractor';
import { redact } from './redact';
import { isGloballyDisabled } from './config';
import { resolveProviderLabel, hasUsableProvider } from './providers';
import { writePreferencesFile } from './sync';
import { withSpinner } from './cli-ui';

// One-time cold scan of a repository: read its source and agent-instruction
// docs, infer habits/memories via the configured LLM, and write them directly
// (auto-apply). Guarded per repo root so it runs once and is cheap to re-call.

const SCANNED_FILE = '.repo-scanned.json';

// Source extensions worth sampling for style inference. Keep this tight: data,
// lockfiles, and generated assets add cost without signal.
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.scala',
  '.vue', '.svelte',
]);

// Path fragments that mark generated, vendored, or minified content to skip.
const SKIP_FRAGMENTS = [
  'node_modules/', 'dist/', 'build/', 'vendor/', '.min.', 'coverage/',
  '.next/', 'out/', '__snapshots__/', '.lock', 'package-lock', 'yarn.lock',
];

// Agent-instruction and contributor docs that carry project directives.
const DOC_CANDIDATES = [
  'CLAUDE.md', 'AGENTS.md', 'SKILLS.md', 'GEMINI.md', '.cursorrules', '.clinerules',
  'CONTRIBUTING.md', path.join('.github', 'copilot-instructions.md'),
];

const MAX_FILES = 40;
const MAX_BYTES_PER_FILE = 2000;
const MAX_TOTAL_BYTES = 60000;
const MAX_DOC_BYTES = 8000;
// Reject files larger than this outright: we only sample the first MAX_BYTES_PER_FILE
// bytes, but readFileSync would otherwise load the whole file into memory first,
// so a giant tracked file could exhaust memory. 1 MB is far above any real source file.
const MAX_FILE_BYTES = 1_000_000;

// Read at most `cap` bytes of a regular file. Returns null when the path is a
// symlink (never follow, prevents reading credentials/secrets outside the repo
// via a planted link), a non-regular file, oversized, or unreadable. Uses an
// fd + bounded buffer so an oversized file is never fully loaded into memory.
function readRegularFileBounded(abs: string, cap: number): string | null {
  // O_NOFOLLOW (POSIX) makes open() fail atomically if the final path component
  // is a symlink, closing the lstat->open race where a regular file could be
  // swapped for a link to a sensitive file between the check and the read. We
  // then stat the open fd (not the path) so the type and size checks see exactly
  // the bytes we are about to read.
  const oNoFollow: number = (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | oNoFollow);
    if (!oNoFollow && fs.lstatSync(abs).isSymbolicLink()) {
      fs.closeSync(fd);
      return null;
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;        // skip dirs, sockets, devices, fifos
    if (st.size > MAX_FILE_BYTES) return null;
    const len = Math.min(cap, st.size);
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, read).toString('utf-8');
  } catch {
    return null; // ELOOP (symlink under O_NOFOLLOW), ENOENT, unreadable, etc.
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

export interface RepoScanResult {
  repoRoot: string;
  scanned: boolean;          // false when skipped (already scanned, no provider, no files)
  reason?: string;           // why it was skipped, if scanned is false
  filesAnalyzed: number;
  docsAnalyzed: number;
  habitsLearned: number;
  habitsUpdated: number;
  memoriesLearned: number;
  memoriesUpdated?: number;
  details?: {
    learnedHabits: { category: string; rule: string }[];
    reinforcedHabits: { category: string; rule: string }[];
    learnedMemories: string[];
    reinforcedMemories?: string[];
  };
}

function scannedPath(): string {
  return path.join(defaultRoot(), SCANNED_FILE);
}

function readScanned(): Set<string> {
  try {
    const raw = fs.readFileSync(scannedPath(), 'utf-8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function markScanned(repoRoot: string): void {
  const set = readScanned();
  set.add(repoRoot);
  try {
    fs.mkdirSync(path.dirname(scannedPath()), { recursive: true });
    fs.writeFileSync(scannedPath(), JSON.stringify([...set], null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    logError(`repo-scan: failed to persist scan marker: ${String(e)}`);
  }
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return top;
  } catch {
    // not a git repo, fall back to cwd
  }
  return path.resolve(cwd);
}

function skip(rel: string): boolean {
  const lower = rel.toLowerCase();
  return SKIP_FRAGMENTS.some(frag => lower.includes(frag));
}

// Prefer git-tracked files (respects .gitignore); fall back to a bounded walk.
function listCandidateFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const files = out.split('\n').map(s => s.trim()).filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // not git or git unavailable, walk manually
  }
  return walk(repoRoot, repoRoot, 0);
}

function walk(dir: string, root: string, depth: number): string[] {
  if (depth > 6) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isSymbolicLink()) continue; // never follow symlinks out of the tree
    if (skip(rel + (e.isDirectory() ? '/' : ''))) continue;
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (e.isDirectory()) {
      out.push(...walk(abs, root, depth + 1));
    } else {
      out.push(rel);
    }
    if (out.length > 5000) break;
  }
  return out;
}

// Pick a representative, size-bounded sample spread across directories.
function sampleSourceFiles(repoRoot: string): RepoFile[] {
  const all = listCandidateFiles(repoRoot)
    .filter(rel => SOURCE_EXTS.has(path.extname(rel).toLowerCase()))
    .filter(rel => !skip(rel));
  if (all.length === 0) return [];

  // Even stride so we sample breadth, not just the first directory.
  const stride = Math.max(1, Math.floor(all.length / MAX_FILES));
  const picked: string[] = [];
  for (let i = 0; i < all.length && picked.length < MAX_FILES; i += stride) {
    picked.push(all[i]);
  }

  const files: RepoFile[] = [];
  let total = 0;
  for (const rel of picked) {
    if (total >= MAX_TOTAL_BYTES) break;
    const content = readRegularFileBounded(path.join(repoRoot, rel), MAX_BYTES_PER_FILE);
    if (content === null) continue; // symlink, oversized, or unreadable
    const clipped = redact(content);
    files.push({ path: rel, content: clipped });
    total += clipped.length;
  }
  return files;
}

function readDocFiles(repoRoot: string): RepoFile[] {
  const docs: RepoFile[] = [];
  for (const rel of DOC_CANDIDATES) {
    // lstat-gated, symlink-rejecting, size-bounded read (a planted CLAUDE.md
    // symlink must not exfiltrate an arbitrary file to the LLM).
    const content = readRegularFileBounded(path.join(repoRoot, rel), MAX_DOC_BYTES);
    if (content === null || !content.trim()) continue;
    docs.push({ path: rel, content: redact(content) });
  }
  return docs;
}

export interface ScanOptions {
  cwd?: string;
  force?: boolean;   // re-scan even if this repo was already scanned
  ctx?: StorageContext;
  yes?: boolean;
  // Async confirmation callback for interactive callers. When provided,
  // called instead of the blocking fs.readSync fallback so the prompt plays
  // nicely after raw-mode stdin prompts (which leave the fd non-blocking).
  confirm?: () => Promise<boolean>;
}

export async function scanRepo(opts: ScanOptions = {}): Promise<RepoScanResult> {
  const repoRoot = resolveRepoRoot(opts.cwd);
  const base: RepoScanResult = {
    repoRoot, scanned: false, filesAnalyzed: 0, docsAnalyzed: 0,
    habitsLearned: 0, habitsUpdated: 0, memoriesLearned: 0,
  };

  if (isGloballyDisabled(opts.ctx)) {
    return { ...base, reason: 'globally disabled' };
  }

  if (!opts.force && readScanned().has(repoRoot)) {
    return { ...base, reason: 'already scanned' };
  }

  const files = sampleSourceFiles(repoRoot);
  const docs = readDocFiles(repoRoot);
  if (files.length === 0 && docs.length === 0) {
    return { ...base, reason: 'no source files or docs found' };
  }

  // Verify a provider can actually run the extraction BEFORE printing the warning
  // or "analyzing..." line. Otherwise we would announce work, prompt the user to
  // approve it, then fail, the exact self-contradicting flow we must never show.
  if (!hasUsableProvider()) {
    return { ...base, reason: 'no LLM provider configured' };
  }

  const isInteractive = process.stdin.isTTY && !opts.yes && !(process.env['CC_HABITS_YES'] === '1');
  if (isInteractive) {
    process.stdout.write(
      `\n⚠️  cc-habits repository scan warning:\n` +
      `   This scan will analyze up to ${MAX_FILES} source files and ${docs.length} docs.\n` +
      `   This will send code context to your configured AI provider (${resolveProviderLabel()}) and consume tokens.\n`
    );
    if (opts.confirm) {
      const ok = await opts.confirm();
      if (!ok) return { ...base, reason: 'scan skipped by user' };
    } else {
      // Fallback for callers without a confirm callback. fs.readSync on fd 0
      // only works reliably when no prior async prompt has left stdin non-blocking.
      process.stdout.write(`   Press Enter to continue or Ctrl+C to skip: `);
      try {
        const buffer = Buffer.alloc(1);
        fs.readSync(0, buffer, 0, 1, null);
      } catch {
        return { ...base, reason: 'scan skipped by user prompt interruption' };
      }
      process.stdout.write('\n');
    }
  }

  let habitUpdates: Awaited<ReturnType<typeof extractHabitsFromRepo>> = [];
  let memCandidates: Awaited<ReturnType<typeof extractMemoriesFromDocs>> = [];

  // The LLM calls below can take several seconds, so show that work is underway
  // (and on which provider) rather than leaving a silent gap. On an interactive
  // TTY this animates a spinner; in non-interactive runs it stays silent so
  // piped/scripted output is unchanged.
  const spin = <T>(label: string, task: () => Promise<T>): Promise<T> =>
    isInteractive ? withSpinner(label, task) : task();
  const providerLabel = resolveProviderLabel();

  // Habits come from source; memories come from the agent-instruction docs.
  try {
    if (files.length > 0) {
      habitUpdates = (await spin(
        `analyzing ${files.length} file${files.length === 1 ? '' : 's'} with ${providerLabel}`,
        () => extractHabitsFromRepo(files, readHabitsMd(opts.ctx)),
      )) || [];
    }
    if (docs.length > 0) {
      memCandidates = (await spin(
        `extracting memories from ${docs.length} doc${docs.length === 1 ? '' : 's'} with ${providerLabel}`,
        () => extractMemoriesFromDocs(docs, readMemoriesMd(opts.ctx)),
      )) || [];
    }
  } catch (e) {
    // Provider resolution throws when no provider/key is configured and no local
    // Ollama is reachable; surface as a skip rather than a crash.
    return { ...base, reason: providerReason(e), filesAnalyzed: files.length, docsAnalyzed: docs.length };
  }

  // Auto-apply: write straight to habits.md and memories.md, no pending review.
  let newCount = 0, updatedCount = 0;
  const changes: AppliedChange[] = [];
  if (habitUpdates.length > 0) {
    const cats = parseHabits(readHabitsMd(opts.ctx));
    [newCount, updatedCount] = applyUpdates(cats, habitUpdates, {
      sessionId: `repo-scan-${new Date().toISOString().slice(0, 10)}`,
      changes,
    });
    writeHabitsMd(serialiseHabits(cats), opts.ctx);
    writePreferencesFile(opts.ctx);
  }
  const addedMemories: string[] = [];
  const updatedMemories: string[] = [];
  const memCount = memCandidates.length > 0 ? applyMemoryUpdates(memCandidates, opts.ctx, addedMemories, updatedMemories) : 0;

  markScanned(repoRoot);

  const learnedHabits = changes
    .filter(c => c.decision === 'create')
    .map(c => ({ category: c.category, rule: c.rule }));
  const reinforcedHabits = changes
    .filter(c => c.decision === 'reinforce')
    .map(c => ({ category: c.category, rule: c.rule }));

  return {
    repoRoot,
    scanned: true,
    filesAnalyzed: files.length,
    docsAnalyzed: docs.length,
    habitsLearned: newCount,
    habitsUpdated: updatedCount,
    memoriesLearned: memCount,
    memoriesUpdated: updatedMemories.length,
    details: {
      learnedHabits,
      reinforcedHabits,
      learnedMemories: addedMemories,
      reinforcedMemories: updatedMemories,
    },
  };
}

function providerReason(e: unknown): string {
  const msg = String(e instanceof Error ? e.message : e);
  if (/API_KEY|provider|not set/i.test(msg)) return 'no LLM provider configured';
  return `provider error: ${msg.slice(0, 80)}`;
}
