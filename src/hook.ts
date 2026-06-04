import fs from 'fs';
import path from 'path';
import {
  storagePaths, appendSignal, readSignals, readHabitsMd, parseHabits, writeHabitsMd,
  serialiseHabits, logError, sanitizeFilePath, detectManualDeletes, writeSnapshot,
  addTombstone, writePending, readPending, clearPending,
  appendHistory, appendProvenance, readMemoriesMd, applyMemoryUpdates, parseMemories,
  isMemoryTombstoned,
  type Memory,
} from './storage';
import { normalizeInput, ALLOWED_ADAPTERS, type NormalizedHookInput } from './adapters';
import { applyUpdates, applyDecay, toPending, pendingToUpdates, sanitizeRule, sanitizeCategory } from './confidence';
import type { AppliedChange } from './confidence';
import { extractRules, extractMemoryCandidates } from './extractor';
import { ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError } from './providers';
import { memoriesEnabled, isGloballyDisabled } from './config';
import { readSyncTargets, syncTargets } from './sync';
import { validatePayload, logSchemaWarning, logUnknownEvent, KNOWN_UNSUPPORTED_EVENTS } from './hook-schema';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const MIN_SIGNALS = 3;
const MIN_DIFF_LEN = 20;
const MAX_DIFF_BYTES = 4096;
// Cap signals sent to the extractor to avoid provider 413 / context-limit errors.
// 50 signals is plenty of signal for a single session; anything beyond is noise.
const MAX_SIGNALS_PER_EXTRACTION = 50;
// Bound stdin reads: a legitimate Claude Code hook payload is always small.
// 4 MB is generous even for a large Write payload; anything bigger is anomalous.
const MAX_STDIN_BYTES = 4 * 1024 * 1024; // 4 MB

// PII redaction is in src/redact.ts. Imported for internal use and re-exported
// so existing callers (capture.ts, bootstrap.ts, tests) work without changes.
import { redact } from './redact';
export { redact };

// Noise gating ─────────────────────────────────────────────────────────────
export function isNoise(diff: string): boolean {
  if (diff.trim().length < MIN_DIFF_LEN) return true;
  if (!diff.replace(/[\s+\-]/g, '')) return true;
  const changed = diff
    .split('\n')
    .filter(ln => ln.startsWith('+') || ln.startsWith('-'))
    .map(ln => ln.slice(1).trim());
  if (changed.length === 0) return true;
  const commentPrefixes = ['#', '//', '*', '/*'];
  if (changed.every(ln => !ln || commentPrefixes.some(p => ln.startsWith(p)))) return true;
  return false;
}

// Language detection (B6) ──────────────────────────────────────────────────
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.rb': 'rb',
  '.java': 'java',
  '.kt': 'kt',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'cs',
  '.swift': 'swift',
  '.php': 'php',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
  '.md': 'md',
  '.json': 'json',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.html': 'html',
  '.css': 'css', '.scss': 'css',
  '.sql': 'sql',
};

export function detectLanguage(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext];
}

// Diff builder ─────────────────────────────────────────────────────────────
export function buildDiff(toolName: string, filePath: string, toolInput: Record<string, unknown>): string {
  let diff = '';
  if (toolName === 'Write') {
    const content = String(toolInput['content'] ?? '');
    diff = `+++ ${filePath}\n` + content.split('\n').map(ln => `+${ln}`).join('\n');
  } else if (toolName === 'Edit') {
    const old = String(toolInput['old_string'] ?? '');
    const nw = String(toolInput['new_string'] ?? '');
    if (old === nw) return ''; // D7: zero-info edit
    diff =
      `--- ${filePath}\n` +
      old.split('\n').map(ln => `-${ln}`).join('\n') +
      '\n' +
      nw.split('\n').map(ln => `+${ln}`).join('\n');
  } else if (toolName === 'MultiEdit') {
    const edits = (toolInput['edits'] ?? []) as Array<Record<string, unknown>>;
    if (edits.length === 0) return ''; // D6: empty edits
    const parts = edits.map(e => {
      const old = String(e['old_string'] ?? '');
      const nw = String(e['new_string'] ?? '');
      return old.split('\n').map(ln => `-${ln}`).join('\n') + '\n' + nw.split('\n').map(ln => `+${ln}`).join('\n');
    });
    diff = `--- ${filePath}\n` + parts.join('\n---\n');
  }
  if (diff.length > MAX_DIFF_BYTES) diff = diff.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)';
  return diff;
}

export function buildDiffFromNormalized(input: NormalizedHookInput): string {
  if (input.diff) {
    let diff = input.diff;
    if (diff.length > MAX_DIFF_BYTES) diff = diff.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)';
    return diff;
  }
  const toolName = input.toolName;
  const filePath = input.filePath;
  let diff = '';
  if (toolName === 'Write') {
    const content = input.newContent ?? '';
    diff = `+++ ${filePath}\n` + content.split('\n').map(ln => `+${ln}`).join('\n');
  } else if (toolName === 'MultiEdit') {
    const edits = input.edits ?? [];
    if (edits.length === 0) return '';
    const parts = edits.map(e => {
      const old = e.old_string ?? '';
      const nw = e.new_string ?? '';
      return old.split('\n').map(ln => `-${ln}`).join('\n') + '\n' + nw.split('\n').map(ln => `+${ln}`).join('\n');
    });
    diff = `--- ${filePath}\n` + parts.join('\n---\n');
  } else {
    // Edit/default
    const old = input.oldContent ?? '';
    const nw = input.newContent ?? '';
    if (old === nw) return '';
    diff =
      `--- ${filePath}\n` +
      old.split('\n').map(ln => `-${ln}`).join('\n') +
      '\n' +
      nw.split('\n').map(ln => `+${ln}`).join('\n');
  }
  if (diff.length > MAX_DIFF_BYTES) diff = diff.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)';
  return diff;
}

// Per-repo opt-out (Responsible AI) ─────────────────────────────────────────
// A developer working on code they can't send to a third-party API (employer
// code, regulated data) needs a way to stop capture for that tree. Two switches:
//   • a `.cc-habits-ignore` file in the working directory, or
//   • the CC_HABITS_DISABLE env var (truthy).
// When either is set, the PostToolUse and Stop hooks become no-ops: nothing is
// captured, nothing is sent, no marker is printed.
export function captureDisabled(): boolean {
  if (isGloballyDisabled()) return true;
  const v = (process.env['CC_HABITS_DISABLE'] ?? '').toLowerCase();
  if (v && v !== '0' && v !== 'false' && v !== 'off') return true;
  try {
    if (fs.existsSync(path.join(process.cwd(), '.cc-habits-ignore'))) return true;
  } catch { /* cwd may be unreadable in odd environments, treat as not-disabled */ }
  return false;
}

// Session-start banner (transparency) ──────────────────────────────────────
// On the *first substantive edit* of a session, emit a single truthful line:
// "cc-habits: N habits active, ..." This fires exactly once (edit #1) and
// makes a claim we can fully back: habits ARE in context guiding this session.
//
// Why not a per-edit "applied" marker? Keyword overlap fires on almost every
// TypeScript edit regardless of which habit influenced it, training users to
// ignore it within a day (cry-wolf). The session-level signal is honest and
// carries real information density.
export function buildSessionBanner(md: string, editCount: number): string | null {
  if (editCount !== 1) return null;
  const habits = selectInjectionHabits(md);
  if (habits.length === 0) return null;
  const n = habits.length;
  return `cc-habits: ${n} habit${n === 1 ? '' : 's'} active this session, \`cch view\` to see them`;
}

// Set CC_HABITS_MARKER=0 (or false/off) to silence the session banner.
function markerEnabled(): boolean {
  const v = (process.env['CC_HABITS_MARKER'] ?? '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

// Set CC_HABITS_AUTO=1 to skip the pending-review queue and auto-apply new
// habits immediately (reverts to the original silent-learning behaviour).
export function autoApplyEnabled(): boolean {
  const v = (process.env['CC_HABITS_AUTO'] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// F3: auto-apply removes the human-in-the-loop review that defends against a
// hostile repo planting a semantically dangerous "habit". Warn whenever it
// applies new rules so the bypass is never silent. Returns the warning line, or
// null when no warning is warranted.
export function autoApplyWarning(count: number): string | null {
  if (!autoApplyEnabled() || count <= 0) return null;
  const noun = count === 1 ? 'habit' : 'habits';
  return `cc-habits: CC_HABITS_AUTO is on, ${count} new ${noun} applied without review. ` +
    `Do not enable auto-apply while working in untrusted repositories.`;
}

// Memory extraction is opt-in via CC_HABITS_MEMORIES=1 (per shell) or a
// persisted `memories_enabled` flag in config.yml. See memoriesEnabled() in config.ts.

// Pure logic ───────────────────────────────────────────────────────────────
export function processPostToolUse(input: Record<string, unknown> | NormalizedHookInput): void {
  if (captureDisabled()) return;

  const data = (('filePath' in input) ? input : normalizeInput(input, 'claude-code')) as NormalizedHookInput;

  const toolName = data.toolName || 'Edit';
  const sessionId = data.sessionId;
  const filePath = sanitizeFilePath(data.filePath);

  let diff = buildDiffFromNormalized(data);
  if (!diff || isNoise(diff)) return; // D7: short-circuit zero-info edits before logging
  diff = redact(diff);
  const safeFilePath = redact(filePath);
  const language = detectLanguage(filePath);

  appendSignal({
    ts: new Date().toISOString(),
    session_id: sessionId,
    type: 'edit',
    file: safeFilePath,
    diff,
    ...(language ? { language } : {}),
    source: data.source || 'claude-code',
  });

  // Session-start banner: on the first edit of this session, tell the user how
  // many habits are active. One truthful line beats a per-edit cry-wolf signal.
  if (markerEnabled() && (data.source === 'claude-code' || !data.source)) {
    try {
      const count = readSignals(sessionId).length;
      const banner = buildSessionBanner(readHabitsMd(), count);
      if (banner) process.stderr.write(banner + '\n');
    } catch { /* banner is cosmetic; swallow */ }
  }
}

export interface StopResult {
  newCount: number;
  updatedCount: number;
  decayed: number;
  tombstoned: number;
  changes: AppliedChange[];
  // New habits written to the Learning section AND queued for review. Zero when
  // CC_HABITS_AUTO=1 (auto-applied immediately). Optional for backwards compat
  // with callers that construct StopResult directly (e.g. test helpers).
  pendingCount?: number;
  // New memory candidates added this session (CC_HABITS_MEMORIES=1 only).
  memoryCandidatesCount?: number;
}

export async function processStop(sessionId: string): Promise<StopResult | null> {
  if (captureDisabled()) return null;

  const signals = readSignals(sessionId);
  if (signals.length < MIN_SIGNALS) return null;

  const gated = signals.filter(s => !isNoise(s.diff ?? ''));
  if (gated.length < MIN_SIGNALS) return null;

  const habitsMd = readHabitsMd();
  const cats = parseHabits(habitsMd);

  // A2: detect manual deletes since last write and tombstone them.
  const deleted = detectManualDeletes(cats);
  for (const d of deleted) addTombstone(d);

  // B4: decay stale habits before applying new updates.
  const decayed = applyDecay(cats);

  // Cap to MAX_SIGNALS_PER_EXTRACTION signals AND a byte budget so large diffs
  // (e.g. whole-file git commits) don't cause a provider 413 on top of the count cap.
  const MAX_HOOK_BATCH_BYTES = 180_000; // ~180 KB, well under Groq's 200 KB request limit
  const countCapped = gated.slice(-MAX_SIGNALS_PER_EXTRACTION);
  let byteTotal = 0;
  let byteIdx = countCapped.length;
  for (let i = countCapped.length - 1; i >= 0; i--) {
    byteTotal += (countCapped[i]!.diff ?? '').length;
    if (byteTotal <= MAX_HOOK_BATCH_BYTES) { byteIdx = i; break; }
    if (i === 0) { byteIdx = countCapped.length; break; }
  }
  const capped = countCapped.slice(byteIdx);
  if (capped.length < gated.length) {
    process.stderr.write(
      `cc-habits: ${gated.length} signals this session, using the most recent ${capped.length}\n`,
    );
  }

  const updates = await extractRules(capped, habitsMd);
  const changes: AppliedChange[] = [];
  const [newCount, updatedCount] = applyUpdates(cats, updates, { sessionId, changes });

  // Queue new-habit creates for user review (pending notification path).
  // The habits ARE written to habits.md in the Learning quarantine section by
  // applyUpdates above, the pending queue is an additional notification surface
  // so users can tombstone proposed habits before they graduate. Skip queueing
  // when CC_HABITS_AUTO=1 (fully-silent auto-apply mode).
  // Clear stale pending from any previous session first, then write this session's
  // new items, this ensures `cch pending` always reflects the latest session only.
  const creates = updates.filter(u => (u.decision ?? '').toLowerCase() === 'create');
  const pendingCount = creates.length;
  if (!autoApplyEnabled() && creates.length > 0) {
    try {
      clearPending();
      const toAdd = toPending(creates);
      const deduped = toAdd.filter(p => p.rule);
      if (deduped.length > 0) writePending(deduped);
    } catch { /* pending write is best-effort; never block the session */ }
  } else {
    const warning = autoApplyWarning(creates.length);
    if (warning) process.stderr.write(warning + '\n');
  }

  // B2: record provenance, which signals contributed to each create/reinforce.
  recordProvenance(updates, gated, sessionId);

  // B6: attach language tag to any habit touched this session.
  const sessionLanguages = Array.from(
    new Set(gated.map(s => s.language).filter((l): l is string => !!l)),
  );
  if (sessionLanguages.length > 0) {
    for (const habits of Object.values(cats)) {
      for (const h of habits) {
        if (h.last_session_id !== sessionId) continue;
        const existing = new Set(h.languages ?? []);
        sessionLanguages.forEach(l => existing.add(l));
        h.languages = Array.from(existing).sort();
      }
    }
  }

  const serialised = serialiseHabits(cats);
  writeHabitsMd(serialised);
  writeSnapshot(cats);
  // B1: snapshot the habits.md state for `cc-habits diff`.
  appendHistory({ ts: new Date().toISOString(), session_id: sessionId, habits_md: serialised });

  // Memory extraction: opt-in via CC_HABITS_MEMORIES=1. Runs after habit
  // extraction so it never blocks or delays the habits path on failure.
  let memoryCandidatesCount = 0;
  if (memoriesEnabled()) {
    try {
      const memoriesMd = readMemoriesMd();
      const candidates = await extractMemoryCandidates(capped, memoriesMd);
      memoryCandidatesCount = applyMemoryUpdates(candidates);
    } catch (e) {
      logError(`stop: memory extraction failed: ${String(e)}`);
    }
  }

  // Auto-sync targets if configured in config.yml
  try {
    const targets = readSyncTargets();
    if (targets.length > 0) {
      syncTargets(targets);
    }
  } catch (e) {
    logError(`stop: auto-sync failed: ${String(e)}`);
  }

  return { newCount, updatedCount, decayed, tombstoned: deleted.length, changes, pendingCount, memoryCandidatesCount };
}

// Session summary (transparency surface) ───────────────────────────────────//
// Printed to stderr when a Claude Code session ends. The goal is trust through
// transparency: show the user exactly which habits were learned, reinforced, or
// contradicted this session, not just opaque counts. Plain text only (no ANSI):
// the hook's stderr is piped, not a TTY, so colour codes would render as noise.

export function formatStopSummary(result: StopResult): string {
  const { changes, decayed, tombstoned } = result;

  const created = changes.filter(c => c.decision === 'create');
  const reinforced = changes.filter(c => c.decision === 'reinforce');
  const contradicted = changes.filter(c => c.decision === 'contradict');

  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const lines: string[] = ['cc-habits: session summary'];

  const pendingCount = result.pendingCount ?? 0;

  // New habits go to the Learning quarantine AND the pending review queue.
  // We show the creates from changes (written to Learning) and separately call
  // out the pending count so users know to run `cch pending` to review them.
  if (created.length > 0) {
    lines.push(`  + ${created.length} new habit${created.length === 1 ? '' : 's'} proposed (Learning quarantine)`);
    for (const c of created) lines.push(`      [${c.category}] ${c.rule}`);
  }
  if (pendingCount > 0) {
    lines.push(`    → run \`cch pending\` to review · \`cch pending --discard\` to reject`);
  }
  if (reinforced.length > 0) {
    lines.push(`  ^ reinforced ${reinforced.length}`);
    for (const c of reinforced) lines.push(`      [${c.category}] ${c.rule} -> ${pct(c.confidence)}`);
  }
  if (contradicted.length > 0) {
    lines.push(`  v contradicted ${contradicted.length}`);
    for (const c of contradicted) lines.push(`      [${c.category}] ${c.rule} -> ${pct(c.confidence)}`);
  }

  const tail: string[] = [];
  if (decayed > 0) tail.push(`${decayed} decayed from inactivity`);
  if (tombstoned > 0) tail.push(`${tombstoned} tombstoned (you deleted them)`);
  if (tail.length > 0) lines.push(`  ~ ${tail.join(', ')}`);

  if (created.length === 0 && reinforced.length === 0 && contradicted.length === 0 && tail.length === 0) {
    lines.push('  no habit changes this session');
  }

  if ((result.memoryCandidatesCount ?? 0) > 0) {
    const n = result.memoryCandidatesCount!;
    lines.push(`  + ${n} new memory candidate${n === 1 ? '' : 's'} added, run \`cch memories\` to review`);
  }

  lines.push('  habits.md updated · run `cc-habits view` for the full picture');
  return lines.join('\n');
}

// Helper for B2 provenance recording. Lives outside processStop for clarity.
import type { RuleUpdate } from './confidence';
import type { Signal } from './storage';

function recordProvenance(updates: RuleUpdate[], signals: Signal[], sessionId: string): void {
  // For each rule touched in this batch, snapshot up to 3 representative signals.
  const ts = new Date().toISOString();
  const sampleSignals = signals.slice(0, 3);
  for (const u of updates) {
    const decision = (u.decision ?? '').toLowerCase();
    if (decision === 'skip' || !u.rule) continue;
    const refs = sampleSignals.map(s => ({
      ts: s.ts ?? ts,
      session_id: s.session_id ?? sessionId,
      file: s.file ?? '',
      snippet: (s.diff ?? '').slice(0, 200),
      decision,
    }));
    appendProvenance(u.rule, refs);
  }
}

// Active-habit injection (Patch 2: UserPromptSubmit) ───────────────────────//
// Static @import of habits.md decays: context compaction summarises or drops it
// (claude-code #19471, #9796). The UserPromptSubmit hook re-injects the top active
// habits on every prompt so they survive compaction, "laws, not requests."

const INJECT_TOP_N = 12;
const INJECT_MIN_CONFIDENCE = 0.3;

interface InjectionHabit { category: string; rule: string; confidence: number; }

// Pick the strongest active habits (graduated + confident), highest confidence first.
export function selectInjectionHabits(
  md: string,
  topN: number = INJECT_TOP_N,
  minConfidence: number = INJECT_MIN_CONFIDENCE,
): InjectionHabit[] {
  const cats = parseHabits(md);
  const out: InjectionHabit[] = [];
  for (const [category, habits] of Object.entries(cats)) {
    for (const h of habits) {
      if ((h.sessions_seen ?? 1) >= 2 && h.confidence >= minConfidence) {
        out.push({ category, rule: h.rule, confidence: h.confidence });
      }
    }
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, topN);
}

// Returns the context block to inject, or null when there is nothing active to add.
export function buildInjectionContext(md: string): string | null {
  const habits = selectInjectionHabits(md);
  if (habits.length === 0) return null;

  // Group by category, preserving the confidence ordering within each.
  // Re-sanitize each rule here as defence-in-depth: habits.md may be hand-edited
  // after initial write, bypassing the sanitization applied by applyUpdates. Without
  // this second pass, a manually-planted injection pattern in habits.md would be
  // amplified into every prompt via the UserPromptSubmit hook.
  const byCat = new Map<string, string[]>();
  for (const h of habits) {
    const rule = sanitizeRule(h.rule.trim().replace(/\.$/, ''));
    if (!rule) continue; // sanitizer may reduce the rule to empty
    // Sanitize the category too: habits.md may be hand-edited to plant a category
    // that escapes the injection wrapper or injects markdown structure.
    const category = sanitizeCategory(h.category);
    if (!byCat.has(category)) byCat.set(category, []);
    byCat.get(category)!.push(`- ${rule}.`);
  }

  const lines: string[] = [
    '<coding-habits>',
    "Apply the developer's learned coding habits below when writing or editing code.",
    'These are durable preferences; honor them unless the user says otherwise.',
  ];
  for (const [category, rules] of byCat) {
    lines.push('', `${category}:`, ...rules);
  }
  lines.push('</coding-habits>');
  return lines.join('\n');
}

// Set CC_HABITS_INJECT=0 (or false/off) to disable prompt-time injection.
function injectionEnabled(): boolean {
  if (isGloballyDisabled()) return false;
  const v = (process.env['CC_HABITS_INJECT'] ?? '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

// Memory relevance scoring ─────────────────────────────────────────────────
// Simple keyword overlap: score a memory against the current prompt text.
// No LLM call, fast enough for UserPromptSubmit where latency matters.
const MEMORY_INJECT_TOP_N = 3;
const MEMORY_MIN_CONFIDENCE = 0.50;

export function scoreMemoryRelevance(memory: Memory, promptText: string): number {
  if (memory.trigger.length === 0) return 0;
  const haystack = promptText.toLowerCase();
  let score = 0;
  const genericVerbs = new Set(['get', 'use', 'set', 'add', 'run', 'fit', 'fix', 'log', 'env', 'app']);
  for (const term of memory.trigger) {
    const cleanTerm = term.trim().toLowerCase();
    if (cleanTerm.length < 3) continue;

    // Ignore generic short verbs
    if (cleanTerm.length < 4 && genericVerbs.has(cleanTerm)) {
      continue;
    }

    // Escape regex characters
    const escaped = cleanTerm.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Enforce word boundaries for alphanumeric triggers, allowing optional plural 's'
    const startBoundary = /^[a-zA-Z0-9_]/.test(cleanTerm) ? '\\b' : '';
    const endBoundary = /[a-zA-Z0-9_]$/.test(cleanTerm) ? 's?\\b' : '';
    
    const regex = new RegExp(startBoundary + escaped + endBoundary, 'i');
    if (regex.test(haystack)) {
      score++;
    }
  }
  return score;
}

export function selectInjectionMemories(memoriesMd: string, promptText: string): Memory[] {
  const sections = parseMemories(memoriesMd);
  const candidates: Array<{ memory: Memory; score: number }> = [];
  for (const memories of Object.values(sections)) {
    for (const m of memories) {
      if ((m.sessions_seen ?? 1) < 2) continue;
      if (m.confidence < MEMORY_MIN_CONFIDENCE) continue;
      if (isMemoryTombstoned(m.text)) continue;
      const score = scoreMemoryRelevance(m, promptText);
      if (score > 0) candidates.push({ memory: m, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.memory.confidence - a.memory.confidence);
  return candidates.slice(0, MEMORY_INJECT_TOP_N).map(c => c.memory);
}

export function buildMemoryInjectionContext(memories: Memory[]): string | null {
  if (memories.length === 0) return null;
  const lines = [
    '<coding-memories>',
    'Relevant past mistakes to avoid for this task:',
  ];
  for (const m of memories) {
    const correction = m.correction ? ` Correction: ${sanitizeRule(m.correction)}` : '';
    lines.push(`- ${sanitizeRule(m.text)}.${correction}`);
  }
  lines.push('</coding-memories>');
  return lines.join('\n');
}

export function processUserPromptSubmit(data: Record<string, unknown>): string | null {
  if (!injectionEnabled()) return null;
  const promptText = typeof data['prompt'] === 'string' ? data['prompt'] : '';
  const habitsContext = buildInjectionContext(readHabitsMd());

  let memoriesContext: string | null = null;
  if (memoriesEnabled()) {
    try {
      const memoriesMd = readMemoriesMd();
      const relevant = selectInjectionMemories(memoriesMd, promptText);
      memoriesContext = buildMemoryInjectionContext(relevant);
    } catch {
      // injection failures must never block a prompt
    }
  }

  if (habitsContext && memoriesContext) return habitsContext + '\n' + memoriesContext;
  return habitsContext ?? memoriesContext;
}

// Cap the SessionStart reminder so we never blow past a tool's context limit
// (Claude Code caps additionalContext at 10k chars; we stay well under).
const MAX_SESSION_START_CONTEXT = 4000;

// Builds the SessionStart reminder. Habits/memories are already injected via the
// CLAUDE.md/GEMINI.md @import and the UserPromptSubmit hook, so re-injecting them
// here would duplicate context. The distinct value of SessionStart is reminding
// the developer about pending suggestions they would otherwise forget to review.
// Returns null when there is nothing actionable so the session stays quiet.
export function processSessionStart(): string | null {
  if (isGloballyDisabled()) return null;
  let pending: ReturnType<typeof readPending>;
  try {
    pending = readPending();
  } catch {
    return null;
  }
  if (!pending.length) return null;

  const count = pending.length;
  const noun = count === 1 ? 'habit suggestion' : 'habit suggestions';
  const lines = pending
    .slice(0, 5)
    .map(p => `  - [${p.category}] ${p.rule}`);
  const more = count > 5 ? `  ...and ${count - 5} more\n` : '';
  const msg =
    `cc-habits: ${count} pending ${noun} awaiting review:\n` +
    `${lines.join('\n')}\n${more}` +
    `Run \`cch pending\` to review, \`cch pending --approve\` to accept, or \`cch pending --discard\` to reject.`;

  return msg.length > MAX_SESSION_START_CONTEXT
    ? msg.slice(0, MAX_SESSION_START_CONTEXT)
    : msg;
}

// stdin/stdout wrappers ────────────────────────────────────────────────────
export function handleSessionStart(adapter = 'claude-code'): void {
  // SessionStart hooks may receive a small JSON payload on stdin, but we only
  // need local state, so drain and ignore it. Always exit 0 so a session never
  // fails to start because of cc-habits.
  let raw = '';
  let oversized = false;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN_BYTES && !oversized) {
      oversized = true;
      process.stdin.destroy();
    }
  });
  const finish = (): void => {
    try {
      const context = processSessionStart();
      if (context) {
        // Claude Code injects SessionStart context via a structured field; plain
        // stdout is silently dropped as of recent versions. Other tools read
        // plain stdout, so branch on the adapter.
        if (adapter === 'claude-code') {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: context,
            },
          }) + '\n');
        } else {
          process.stdout.write(context + '\n');
        }
      }
    } catch (e) {
      logError(`session-start: ${String(e)}`);
    }
    process.exit(0);
  };
  process.stdin.on('end', finish);
  process.stdin.on('error', () => process.exit(0));
}

export function handlePostToolUse(adapter = 'claude-code'): void {
  let raw = '';
  let oversized = false;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN_BYTES && !oversized) {
      oversized = true;
      logError(`post-tool-use: stdin payload exceeded ${MAX_STDIN_BYTES} bytes; discarding`);
      process.stdin.destroy();
    }
  });
  process.stdin.on('end', () => {
    if (!oversized) {
      try {
        const rawJson = JSON.parse(raw);
        // T1: non-blocking drift check. PostToolUse is the highest-frequency
        // hook, a renamed tool_name/tool_input would silently kill all capture,
        // so log the drift but still proceed (processPostToolUse no-ops safely).
        const check = validatePayload('post-tool-use', rawJson as Record<string, unknown>, adapter);
        if (!check.ok) logSchemaWarning('post-tool-use', check.missing);
        const normalized = normalizeInput(rawJson, adapter);
        processPostToolUse(normalized);
      } catch (e) {
        logError(`post-tool-use (${adapter}): malformed stdin or normalization failed: ${String(e)}`);
      }
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

export async function handleStop(): Promise<void> {
  const raw = await new Promise<string>(resolve => {
    let buf = '';
    let oversized = false;
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => {
      buf += chunk;
      if (buf.length > MAX_STDIN_BYTES && !oversized) {
        oversized = true;
        logError(`stop: stdin payload exceeded ${MAX_STDIN_BYTES} bytes; discarding`);
        process.stdin.destroy();
        resolve('');
      }
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    // T1: contract check. A missing session_id would make readSignals fall back
    // to ALL sessions, so skip extraction and log the drift rather than guess.
    const check = validatePayload('stop', data);
    if (!check.ok) {
      logSchemaWarning('stop', check.missing);
      process.exit(0);
      return;
    }
    const sessionId = String(data['session_id'] ?? data['sessionId'] ?? data['session'] ?? '');
    const result = await processStop(sessionId);
    if (result !== null) {
      process.stderr.write(formatStopSummary(result) + '\n');
    }
  } catch (e) {
    if (e instanceof ProviderRateLimitError || e instanceof ProviderTimeoutError || e instanceof ProviderPayloadError) {
      process.stderr.write(`cc-habits: ${e.message}\n`);
    } else {
      const msg = String(e);
      if (msg.includes('not set') && msg.includes('config')) {
        process.stderr.write('cc-habits: no provider configured. Run `cc-habits init` to set one up.\n');
      }
      logError(`stop: ${msg}`);
    }
  }
  process.exit(0);
}

export function handleUserPromptSubmit(): void {
  let raw = '';
  let oversized = false;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN_BYTES && !oversized) {
      oversized = true;
      logError(`user-prompt-submit: stdin payload exceeded ${MAX_STDIN_BYTES} bytes; discarding`);
      process.stdin.destroy();
    }
  });
  process.stdin.on('end', () => {
    if (!oversized) {
      try {
        const data = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const context = processUserPromptSubmit(data);
        // Plain stdout is added to Claude's context for UserPromptSubmit. Exit 0
        // always, injection must never block or fail a prompt.
        if (context) process.stdout.write(context + '\n');
      } catch (e) {
        logError(`user-prompt-submit: ${String(e)}`);
      }
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

export function hookMain(): void {
  const event = process.argv[2];
  if (!event) { process.exit(0); return; }

  let adapter = 'claude-code';
  const adapterIdx = process.argv.indexOf('--adapter');
  if (adapterIdx !== -1 && process.argv[adapterIdx + 1]) {
    const candidate = process.argv[adapterIdx + 1]!;
    if (ALLOWED_ADAPTERS.has(candidate)) {
      adapter = candidate;
    } else {
      process.stderr.write(`cc-habits: invalid adapter: ${candidate}. Supported adapters: ${[...ALLOWED_ADAPTERS].join(', ')}. Falling back to claude-code.\n`);
      adapter = 'claude-code';
    }
  }

  const wrap = async (): Promise<void> => {
    try {
      if (event === 'post-tool-use') handlePostToolUse(adapter);
      else if (event === 'stop') await handleStop();
      else if (event === 'user-prompt-submit') handleUserPromptSubmit();
      else if (event === 'session-start') handleSessionStart(adapter);
      else if (KNOWN_UNSUPPORTED_EVENTS.has(event)) {
        // Deliberate no-op (e.g. subagent-stop). See hook-schema.ts for why:
        // Claude Code does not fire PostToolUse for subagent tool calls, so there
        // is nothing to extract here and the parent Stop already covers the
        // shared session. Subagent edits are captured via git-capture instead.
        process.exit(0);
      } else {
        // An event we neither handle nor know about. Log it as an early warning
        // that Claude Code may have introduced or renamed a hook event.
        logUnknownEvent(event);
        process.exit(0);
      }
    } catch (e) {
      logError(`hook ${event}: ${String(e)}`);
      process.exit(0);
    }
  };

  wrap().catch(() => process.exit(0));
}

// Re-export for callers that want to stage pending updates without applying.
export { writePending, readPending, clearPending, toPending, pendingToUpdates };
