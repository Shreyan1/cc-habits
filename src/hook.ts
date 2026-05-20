import path from 'path';
import {
  storagePaths, appendSignal, readSignals, readHabitsMd, parseHabits, writeHabitsMd,
  serialiseHabits, logError, sanitizeFilePath, detectManualDeletes, writeSnapshot,
  addTombstone, writePending, readPending, clearPending,
  appendHistory, appendProvenance,
} from './storage';
import { applyUpdates, applyDecay, toPending, pendingToUpdates, sanitizeRule } from './confidence';
import type { AppliedChange } from './confidence';
import { extractRules } from './extractor';
import { ProviderRateLimitError, ProviderTimeoutError } from './providers';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const MIN_SIGNALS = 3;
const MIN_DIFF_LEN = 20;
const MAX_DIFF_BYTES = 4096;
// Bound stdin reads: a legitimate Claude Code hook payload is always small.
// 4 MB is generous even for a large Write payload; anything bigger is anomalous.
const MAX_STDIN_BYTES = 4 * 1024 * 1024; // 4 MB

// ── PHI redaction ─────────────────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;
const CARD_CANDIDATE_RE = /\b(?:\d[\s\-]?){12,19}\b/g;

function luhnCheck(s: string): boolean {
  const digits = s.replace(/[\s\-]/g, '');
  if (!/^\d+$/.test(digits) || digits.length < 12) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = parseInt(digits[digits.length - 1 - i], 10);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

export function redact(text: string): string {
  text = text.replace(EMAIL_RE, '<REDACTED:email>');
  text = text.replace(PAN_RE, '<REDACTED:pan>');
  text = text.replace(CARD_CANDIDATE_RE, m => (luhnCheck(m) ? '<REDACTED:card>' : m));
  return text;
}

// ── Noise gating ──────────────────────────────────────────────────────────────

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

// ── Language detection (B6) ───────────────────────────────────────────────────

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

// ── Diff builder ──────────────────────────────────────────────────────────────

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

// ── Pure logic ────────────────────────────────────────────────────────────────

export function processPostToolUse(data: Record<string, unknown>): void {
  const toolName = String(data['tool_name'] ?? '');
  if (!WRITE_TOOLS.has(toolName)) return;

  const toolInput = (data['tool_input'] ?? {}) as Record<string, unknown>;
  const sessionId = String(data['session_id'] ?? '');
  const rawFilePath = String(toolInput['file_path'] ?? toolInput['path'] ?? '');
  // S4: sanitize file path against traversal/control chars.
  const filePath = sanitizeFilePath(rawFilePath);

  let diff = buildDiff(toolName, filePath, toolInput);
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
  });
}

export interface StopResult {
  newCount: number;
  updatedCount: number;
  decayed: number;
  tombstoned: number;
  changes: AppliedChange[];
}

export async function processStop(sessionId: string): Promise<StopResult | null> {
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

  const updates = await extractRules(gated, habitsMd);
  const changes: AppliedChange[] = [];
  const [newCount, updatedCount] = applyUpdates(cats, updates, { sessionId, changes });

  // B2: record provenance — which signals contributed to each create/reinforce.
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
  clearPending();

  return { newCount, updatedCount, decayed, tombstoned: deleted.length, changes };
}

// ── Session summary (transparency surface) ────────────────────────────────────
//
// Printed to stderr when a Claude Code session ends. The goal is trust through
// transparency: show the user exactly which habits were learned, reinforced, or
// contradicted this session — not just opaque counts. Plain text only (no ANSI):
// the hook's stderr is piped, not a TTY, so colour codes would render as noise.

export function formatStopSummary(result: StopResult): string {
  const { changes, decayed, tombstoned } = result;

  const created = changes.filter(c => c.decision === 'create');
  const reinforced = changes.filter(c => c.decision === 'reinforce');
  const contradicted = changes.filter(c => c.decision === 'contradict');

  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const lines: string[] = ['cc-habits: session summary'];

  if (created.length > 0) {
    lines.push(`  + learned ${created.length} new`);
    for (const c of created) lines.push(`      [${c.category}] ${c.rule}`);
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

  // Nothing changed but the Stop pipeline still ran (e.g. only skips this batch).
  if (created.length === 0 && reinforced.length === 0 && contradicted.length === 0 && tail.length === 0) {
    lines.push('  no habit changes this session');
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

// ── Active-habit injection (Patch 2: UserPromptSubmit) ────────────────────────
//
// Static @import of habits.md decays: context compaction summarises or drops it
// (claude-code #19471, #9796). The UserPromptSubmit hook re-injects the top active
// habits on every prompt so they survive compaction — "laws, not requests."

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
    if (!byCat.has(h.category)) byCat.set(h.category, []);
    byCat.get(h.category)!.push(`- ${rule}.`);
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
  const v = (process.env['CC_HABITS_INJECT'] ?? '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function processUserPromptSubmit(_data: Record<string, unknown>): string | null {
  if (!injectionEnabled()) return null;
  return buildInjectionContext(readHabitsMd());
}

// ── stdin/stdout wrappers ─────────────────────────────────────────────────────

export function handlePostToolUse(): void {
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
        const data = JSON.parse(raw) as Record<string, unknown>;
        processPostToolUse(data);
      } catch {
        // malformed stdin — safe to ignore
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
    const sessionId = String(data['session_id'] ?? '');
    const result = await processStop(sessionId);
    if (result !== null) {
      process.stderr.write(formatStopSummary(result) + '\n');
    }
  } catch (e) {
    if (e instanceof ProviderRateLimitError || e instanceof ProviderTimeoutError) {
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
        // always — injection must never block or fail a prompt.
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

  const wrap = async (): Promise<void> => {
    try {
      if (event === 'post-tool-use') handlePostToolUse();
      else if (event === 'stop') await handleStop();
      else if (event === 'user-prompt-submit') handleUserPromptSubmit();
      else process.exit(0);
    } catch (e) {
      logError(`hook ${event}: ${String(e)}`);
      process.exit(0);
    }
  };

  wrap().catch(() => process.exit(0));
}

// Re-export for callers that want to stage pending updates without applying.
export { writePending, readPending, clearPending, toPending, pendingToUpdates };
