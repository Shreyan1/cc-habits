import type { HabitsMap, Habit, PendingUpdate } from './storage';
import { isTombstoned } from './storage';

export const INITIAL = 0.50;
export const REINFORCE_DELTA = 0.05;
export const CONTRADICT_DELTA = 0.10;
export const CONFIDENCE_CAP = 0.95;
export const CONFIDENCE_FLOOR = 0.0;
export const PRUNE_THRESHOLD = 0.30;
export const DECAY_PER_WEEK = 0.05;
export const STALE_AFTER_DAYS = 7;
export const CONTRADICT_BURST_THRESHOLD = 3;

export interface RuleUpdate {
  category: string;
  rule: string;
  decision: string;
  matched_habit_id: string;
  reasoning: string;
}

// Confidence math helpers ───────────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number): number {
  return Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CAP, round2(n)));
}

// Rule normalization & sanitization ─────────────────────────────────────────
function normalize(text: string): string {
  return text.trim().replace(/\.$/, '').toLowerCase();
}

// S8: strip prompt-injection patterns + control chars + URLs from rule text.
// An attacker who plants a habit could embed instructions intended for Claude
// when habits.md is auto-imported or injected via UserPromptSubmit. We sanitize
// at write time AND at injection time (defence-in-depth).
//
// Coverage spans common LLM meta-formats:
//   • OpenAI system/user/assistant XML tags
//   • ChatML  (<|im_start|> / <|im_end|> and variants)
//   • Llama2  ([INST] / [/INST])
//   • Classic jailbreaks ("ignore all previous instructions", "act as")
//   • Explicit role override prefixes ("SYSTEM:", "USER:", "HUMAN:")
const INJECTION_KEYWORDS = new RegExp(
  [
    // Classic jailbreak phrases
    '\\bIGNORE\\s+(ALL\\s+)?\\s*(PREVIOUS|PRIOR)\\b[A-Z\\s]*',
    // Role-prefix injection (SYSTEM:, USER:, ASSISTANT:, HUMAN:, INSTRUCTION:)
    '\\b(SYSTEM|USER|ASSISTANT|HUMAN|INSTRUCTION)\\s*:',
    // XML-style role tags: <system>, </user>, <assistant> etc.
    '<\\/?\\s*(system|user|assistant|instruction)\\s*>',
    // ChatML tokens
    '<\\|im_start\\|>',
    '<\\|im_end\\|>',
    '<\\|user\\|>',
    '<\\|assistant\\|>',
    '<\\|system\\|>',
    // Llama2 instruction tokens
    '\\[INST\\]',
    '\\[\\/INST\\]',
    // "Act as" persona override
    '\\bACT\\s+AS\\s+',
  ].join('|'),
  'gi',
);
const URL_RE = /\bhttps?:\/\/\S+/gi;
// Shell command-substitution patterns: backtick execution (`cmd`) and $() expansion.
// Habits are never executed as shell commands, but stripping these is defence-in-depth,
// it prevents a poisoned habit from carrying a payload that later confuses an LLM
// or human reviewer into thinking the command should be run.
const SHELL_SUBST = /`[^`]*`|\$\([^)]*\)/g;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// Zero-width / invisible characters an attacker inserts mid-keyword to defeat the
// denylist while the text still renders as the keyword to an LLM (e.g. SYS​TEM:).
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
// Unicode whitespace and line/paragraph separators that are not caught by \x00-\x1f
// but can still inject structure or break the injection wrapper (U+2028, U+2029, …).
const UNICODE_SEPARATORS = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
// HTML/markdown comments are a hidden-instruction channel: a human skims past
// <!-- ... --> but an LLM reads the body. Strip the whole comment (including any
// unclosed <!-- or stray -->) so hidden instructions never reach extraction or
// injection. Lazy quantifier on already-length-bounded input, so no ReDoS.
// codeql[js/bad-tag-filter] - this regex is not used to sanitize HTML for display;
// it strips comment syntax from untrusted LLM rule text before storing or injecting
// it. The goal is to remove the hidden-instruction channel (humans skim HTML
// comments; LLMs read them). The regex intentionally targets only the `<!-- -->`
// comment delimiters, not all tag forms — TAG_TOKEN handles element tags below.
const HTML_COMMENT = /<!--[\s\S]*?-->|<!--|-->/g;
// Any XML/HTML-style tag token. Stops container-escape attacks where a rule embeds
// </coding-habits> (or any tag) to break out of the UserPromptSubmit injection wrapper.
const TAG_TOKEN = /<\/?\s*[a-zA-Z][\w-]*\s*\/?>/g; // codeql[js/bad-tag-filter] - not HTML sanitization for display; strips tag markers from LLM rule text to prevent container-escape injection
// Maximum length for a single rule: bounds context window consumption and limits
// the blast radius of any injection that slips through the pattern filters.
const MAX_RULE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 40;

// Defence-in-depth sanitizer for any untrusted text destined for habits.md or the
// Claude injection context. Order matters: bound length and normalize Unicode BEFORE
// running the denylist so homoglyph/zero-width bypasses collapse to canonical ASCII
// and the regexes never run on unbounded input (ReDoS).
export function sanitizeRule(rule: string): string {
  let s = (rule ?? '').trim();
  // Bound length first, denylist regexes must never see unbounded input.
  if (s.length > MAX_RULE_LENGTH * 2) s = s.slice(0, MAX_RULE_LENGTH * 2);
  s = s.replace(ZERO_WIDTH, '');
  // NFKC folds fullwidth/compatibility homoglyphs (ＳＹＳＴＥＭ → SYSTEM) to ASCII.
  s = s.normalize('NFKC');
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(UNICODE_SEPARATORS, ' ');
  // codeql[js/incomplete-multi-character-sanitization] - each replacement targets a
  // distinct and non-overlapping pattern class. HTML_COMMENT removes comment syntax
  // before INJECTION_KEYWORDS runs, which is the correct order: a sequence like
  // "SYS<!---->TEM:" collapses to "SYSTEM:" after comment removal and is then caught
  // by INJECTION_KEYWORDS. No replacement can produce a new HTML comment or tag
  // from its substitution value ("" or "[redacted]"), so there is no second-pass risk.
  s = s.replace(HTML_COMMENT, ''); // codeql[js/incomplete-multi-character-sanitization] - HTML_COMMENT runs before INJECTION_KEYWORDS; "SYS<!---->TEM:" becomes "SYSTEM:" then "[redacted]". No replacement produces a new dangerous sequence.
  s = s.replace(INJECTION_KEYWORDS, '[redacted]');
  s = s.replace(TAG_TOKEN, '[redacted]'); // codeql[js/incomplete-multi-character-sanitization] - TAG_TOKEN removes whole well-formed tags; remaining chars are caught by the structural char strips above
  s = s.replace(URL_RE, '[url]');
  s = s.replace(SHELL_SUBST, '[cmd]');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_RULE_LENGTH) s = s.slice(0, MAX_RULE_LENGTH).trimEnd();
  return s;
}

// Categories become markdown section headers (## Category) in habits.md AND labels
// in the injection block. Unsanitized, an LLM- or injection-controlled category could
// embed newlines / markdown / tags to inject structure. Categories are short labels,
// so we strip aggressively.
export function sanitizeCategory(category: string): string {
  let s = (category ?? '').trim();
  if (s.length > MAX_CATEGORY_LENGTH * 2) s = s.slice(0, MAX_CATEGORY_LENGTH * 2);
  s = s.replace(ZERO_WIDTH, '').normalize('NFKC');
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(UNICODE_SEPARATORS, ' ');
  // codeql[js/incomplete-multi-character-sanitization] - same reasoning as sanitizeRule:
  // HTML_COMMENT runs before TAG_TOKEN; the substitution values ('' and removed chars)
  // cannot form new HTML/comment sequences.
  s = s.replace(HTML_COMMENT, ''); // codeql[js/incomplete-multi-character-sanitization] - same ordering guarantee as sanitizeRule
  s = s.replace(TAG_TOKEN, ''); // codeql[js/incomplete-multi-character-sanitization] - tags stripped; remaining structural chars removed by the regex below
  // Drop markdown-structural and delimiter chars that could inject headers or
  // break the "Category:" label format in the injection block.
  s = s.replace(/[#`*_<>[\]:]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return 'Uncategorized';
  if (s.length > MAX_CATEGORY_LENGTH) s = s.slice(0, MAX_CATEGORY_LENGTH).trimEnd();
  return s;
}

export function levenshtein(s1: string, s2: string): number {
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  let prevRow = Array(s1.length + 1);
  let currRow = Array(s1.length + 1);

  for (let i = 0; i <= s1.length; i++) {
    prevRow[i] = i;
  }

  for (let j = 1; j <= s2.length; j++) {
    currRow[0] = j;
    for (let i = 1; i <= s1.length; i++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        currRow[i - 1] + 1,      // insertion
        prevRow[i] + 1,          // deletion
        prevRow[i - 1] + cost    // substitution
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[s1.length];
}

function findHabit(cats: HabitsMap, matchedId: string, ruleText: string): Habit | null {
  const normId = normalize(matchedId);
  const normRule = normalize(ruleText);
  for (const habits of Object.values(cats)) {
    for (const h of habits) {
      const stored = normalize(h.rule ?? '');
      if (normId && (stored.includes(normId) || normId.includes(stored))) return h;
      if (normRule && stored === normRule) return h;
    }
  }

  // NOTE: This fuzzy matching step performs Levenshtein distance calculations.
  // Complexity: O(N) comparisons where N is the total number of habits.
  // Across a batch of M updates, the total complexity is O(N * M * L^2) where L is the average rule length.
  // Given current scale (N ~ tens, M < 10, L ~ 50-100 characters), this is highly efficient (< 1ms).
  // If the habit file size scales to thousands of rules, consider:
  // 1. Filtering candidates by length differences or simple word overlap first.
  // 2. Indexing rules (e.g., using a prefix tree or trigram index).
  let bestMatch: Habit | null = null;
  let bestSimilarity = 0;

  for (const habits of Object.values(cats)) {
    for (const h of habits) {
      const stored = normalize(h.rule ?? '');
      if (!stored) continue;

      if (normId) {
        const dist = levenshtein(normId, stored);
        const maxLen = Math.max(normId.length, stored.length);
        const sim = maxLen > 0 ? 1 - dist / maxLen : 0;
        if (sim >= 0.70 && sim > bestSimilarity) {
          bestSimilarity = sim;
          bestMatch = h;
        }
      }
      if (normRule) {
        const dist = levenshtein(normRule, stored);
        const maxLen = Math.max(normRule.length, stored.length);
        const sim = maxLen > 0 ? 1 - dist / maxLen : 0;
        if (sim >= 0.70 && sim > bestSimilarity) {
          bestSimilarity = sim;
          bestMatch = h;
        }
      }
    }
  }

  return bestMatch;
}

// Confidence decay (B4) ─────────────────────────────────────────────────────
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.floor((tb - ta) / (24 * 60 * 60 * 1000));
}

export function applyDecay(cats: HabitsMap, todayIso?: string): number {
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  let decayed = 0;
  for (const category of Object.keys(cats)) {
    const habits = cats[category] ?? [];
    for (const h of habits) {
      if (!h.last_updated) continue;
      const stale = daysBetween(h.last_updated, today);
      if (stale <= STALE_AFTER_DAYS) continue;
      const weeksStale = Math.floor((stale - STALE_AFTER_DAYS) / 7) + 1;
      const before = h.confidence;
      h.confidence = clamp(h.confidence - DECAY_PER_WEEK * weeksStale);
      if (h.confidence !== before) decayed++;
    }
    cats[category] = habits.filter(h => h.confidence >= PRUNE_THRESHOLD);
    if (cats[category].length === 0) delete cats[category];
  }
  return decayed;
}

// Main update entrypoint ────────────────────────────────────────────────────
// A single habit change applied during one Stop pass. Collected for the
// session summary so the user can see exactly what cc-habits did and why.
export interface AppliedChange {
  category: string;
  rule: string;
  decision: 'create' | 'reinforce' | 'contradict';
  confidence: number;
}

export interface ApplyOptions {
  sessionId?: string;
  todayIso?: string;
  // Optional collector: if provided, every applied change is pushed here.
  // Non-breaking, callers that don't need detail simply omit it.
  changes?: AppliedChange[];
}

export function applyUpdates(
  cats: HabitsMap,
  updates: RuleUpdate[],
  options: ApplyOptions = {},
): [number, number] {
  const today = options.todayIso ?? new Date().toISOString().slice(0, 10);
  const sessionId = options.sessionId ?? '';
  const changes = options.changes;
  let newCount = 0;
  let updatedCount = 0;

  // B5: count contradictions in this batch up-front; if burst, double the decay.
  const contradictCount = updates.filter(u => (u.decision ?? '').toLowerCase() === 'contradict').length;
  const contradictMultiplier = contradictCount >= CONTRADICT_BURST_THRESHOLD ? 2 : 1;

  for (const update of updates) {
    const decision = (update.decision ?? 'skip').toLowerCase();
    if (decision === 'skip') continue;

    const category = sanitizeCategory(update.category ?? 'Uncategorized');
    const rawRule = (update.rule ?? '').trim().replace(/\.$/, '');
    const ruleText = sanitizeRule(rawRule);
    if (!ruleText) continue;

    const existing = findHabit(cats, update.matched_habit_id ?? '', ruleText);

    if (decision === 'create') {
      // A2: never re-create a tombstoned rule.
      if (isTombstoned(ruleText)) continue;
      if (!cats[category]) cats[category] = [];
      if (existing === null) {
        cats[category].push({
          rule: ruleText,
          confidence: INITIAL,
          reinforcing: 1,
          contradicting: 0,
          sessions_seen: 1,
          last_session_id: sessionId || undefined,
          first_learned: today,
          last_updated: today,
        });
        newCount++;
        changes?.push({ category, rule: ruleText, decision: 'create', confidence: INITIAL });
      } else {
        existing.confidence = clamp(existing.confidence + REINFORCE_DELTA);
        existing.reinforcing = (existing.reinforcing ?? 0) + 1;
        if (sessionId && existing.last_session_id !== sessionId) {
          existing.sessions_seen = (existing.sessions_seen ?? 1) + 1;
          existing.last_session_id = sessionId;
        }
        existing.last_updated = today;
        updatedCount++;
        changes?.push({ category, rule: ruleText, decision: 'reinforce', confidence: existing.confidence });
      }
    } else if (decision === 'reinforce') {
      if (existing !== null) {
        existing.confidence = clamp(existing.confidence + REINFORCE_DELTA);
        existing.reinforcing = (existing.reinforcing ?? 0) + 1;
        if (sessionId && existing.last_session_id !== sessionId) {
          existing.sessions_seen = (existing.sessions_seen ?? 1) + 1;
          existing.last_session_id = sessionId;
        }
        existing.last_updated = today;
        updatedCount++;
        changes?.push({ category, rule: ruleText, decision: 'reinforce', confidence: existing.confidence });
      }
    } else if (decision === 'contradict') {
      if (existing !== null) {
        existing.confidence = clamp(
          existing.confidence - CONTRADICT_DELTA * contradictMultiplier,
        );
        existing.contradicting = (existing.contradicting ?? 0) + 1;
        existing.last_updated = today;
        updatedCount++;
        changes?.push({ category, rule: ruleText, decision: 'contradict', confidence: existing.confidence });
      }
    }

    cats[category] = (cats[category] ?? []).filter(h => h.confidence >= PRUNE_THRESHOLD);
    if (cats[category].length === 0) delete cats[category];
  }

  return [newCount, updatedCount];
}

// Pending updates (A4) ──────────────────────────────────────────────────────
export function toPending(updates: RuleUpdate[]): PendingUpdate[] {
  const ts = new Date().toISOString();
  return updates
    .filter(u => (u.decision ?? '').toLowerCase() !== 'skip')
    .map(u => ({
      category: sanitizeCategory(u.category ?? 'Uncategorized'),
      rule: sanitizeRule((u.rule ?? '').trim().replace(/\.$/, '')),
      decision: (u.decision ?? '').toLowerCase(),
      matched_habit_id: u.matched_habit_id,
      reasoning: u.reasoning,
      ts,
    }))
    .filter(u => u.rule)
    // Never surface a tombstoned (or reworded-equivalent) rule for review, the
    // user already rejected it, so it must not reappear in the pending queue.
    .filter(u => !isTombstoned(u.rule));
}

export function pendingToUpdates(pending: PendingUpdate[]): RuleUpdate[] {
  return pending.map(p => ({
    category: p.category,
    rule: p.rule,
    decision: p.decision,
    matched_habit_id: p.matched_habit_id ?? '',
    reasoning: p.reasoning ?? '',
  }));
}
