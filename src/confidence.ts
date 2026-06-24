import type { HabitsMap, Habit } from './storage';
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
  language?: string;
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
// C0 controls, DEL, and the C1 range (\x80-\x9f). C1 carries the 8-bit forms of
// CSI (\x9b) and OSC (\x9d): on terminals that honor 8-bit controls a rule could
// otherwise smuggle a live ANSI escape into `cch view`/`cch status` output or into
// any agent file that renders habits.md. Stripping the full set neutralizes that.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
// Zero-width / invisible characters an attacker inserts mid-keyword to defeat the
// denylist while the text still renders as the keyword to an LLM (e.g. SYS​TEM:).
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]|\uDB40[\uDC00-\uDC7F]/g;
// Unicode bidirectional control characters. These reorder how text DISPLAYS
// without changing its logical content, the basis of Trojan-Source attacks
// (CVE-2021-42574): a rule could render to a human reviewer as something benign
// while carrying different logical bytes into an LLM. Strip them outright.
// Covers LRM/RLM/ALM, the embedding/override set (U+202A-202E), and the
// isolate set (U+2066-2069).
const BIDI_CONTROLS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
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
// comment delimiters, not all tag forms, TAG_TOKEN handles element tags below.
const HTML_COMMENT = /<!--[\s\S]*?-->|<!--|-->/g;
// Any XML/HTML-style tag token. Stops container-escape attacks where a rule embeds
// </coding-habits> (or any tag) to break out of the UserPromptSubmit injection wrapper.
const TAG_TOKEN = /<\/?\s*[a-zA-Z][\w-]*\s*\/?>/g; // codeql[js/bad-tag-filter] - not HTML sanitization for display; strips tag markers from LLM rule text to prevent container-escape injection
// Maximum length for a single rule: bounds context window consumption and limits
// the blast radius of any injection that slips through the pattern filters.
const MAX_RULE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 40;

// Cyrillic/Greek to Latin homoglyph mapping for character normalization
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic small
  'а': 'a', 'в': 'b', 'е': 'e', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 's', 'т': 't', 'у': 'y', 'х': 'x', 'є': 'e',
  // Cyrillic capital
  'А': 'A', 'В': 'B', 'Е': 'E', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'S', 'Т': 'T', 'У': 'Y', 'Х': 'X',
  // Greek small
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'y', 'χ': 'x',
  // Greek capital
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X'
};

// Helper to replace homoglyphs in a string
function foldHomoglyphs(str: string): string {
  let res = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    res += HOMOGLYPH_MAP[char] || char;
  }
  return res;
}

// Defence-in-depth sanitizer for any untrusted text destined for habits.md or the
// Claude injection context. Order matters: bound length and normalize Unicode BEFORE
// running the denylist so homoglyph/zero-width bypasses collapse to canonical ASCII
// and the regexes never run on unbounded input (ReDoS).
// Apply a scrub pass repeatedly until the text stops changing (a fixed point).
// A single replacement can EXPOSE a new match: stripping a tag to a space turns
// "act as<tag>" into "act as " which the persona pattern then matches, and
// removing a delimiter can join tokens into a fresh keyword. Each pass consumes
// at least one strippable structure and replaces it with inert text, so the
// match count decreases monotonically and the sequence converges. The cap is set
// to the input length (the worst-case number of productive passes) so the result
// is a true fixed point, while the pre-loop length bound keeps that cheap. A
// fixed point is what makes re-sanitizing already-stored text a guaranteed no-op.
function scrubToFixedPoint(s: string, pass: (x: string) => string): string {
  const cap = Math.min(Math.max(s.length, 8), 1024);
  for (let i = 0; i < cap; i++) {
    const next = pass(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

// One full normalize+scrub pass for rule text. Because a single replacement can
// EXPOSE a new match (a tag stripped to a space exposing "act as ", or NFKC folding
// a fullwidth homoglyph into a live "SYSTEM:"), the ENTIRE transform - not just the
// denylist - is iterated to a fixed point. Keeping the whole pipeline in the looped
// pass (rather than running normalization once before a denylist-only loop) is what
// guarantees the loop's fixed point equals a fresh call's output, i.e. idempotence.
// codeql[js/incomplete-multi-character-sanitization] - distinct non-overlapping
// pattern classes; HTML_COMMENT before INJECTION_KEYWORDS; fixed-point iteration
// catches any match a substitution exposes, so there is no residual second-pass risk.
function rulePass(x: string): string {
  x = x.replace(ZERO_WIDTH, '').replace(BIDI_CONTROLS, '');
  x = x.normalize('NFKC');
  x = foldHomoglyphs(x);
  x = x.replace(CONTROL_CHARS, '');
  x = x.replace(UNICODE_SEPARATORS, ' ');
  x = x.replace(HTML_COMMENT, '');
  x = x.replace(INJECTION_KEYWORDS, '[redacted]');
  x = x.replace(TAG_TOKEN, '[redacted]');
  x = x.replace(URL_RE, '[url]');
  x = x.replace(SHELL_SUBST, '[cmd]');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

export function sanitizeRule(rule: string): string {
  let s = (rule ?? '').trim();
  // Bound length first, denylist regexes must never see unbounded input.
  if (s.length > MAX_RULE_LENGTH * 2) s = s.slice(0, MAX_RULE_LENGTH * 2);
  s = scrubToFixedPoint(s, rulePass);
  if (s.length > MAX_RULE_LENGTH) {
    // A hard slice can expose a new boundary (cutting "...ignore all previous|XYZ"
    // mid-token leaves a trailing keyword), so re-scrub the truncated text.
    s = scrubToFixedPoint(s.slice(0, MAX_RULE_LENGTH).trimEnd(), rulePass);
  }
  return s;
}

// Categories become markdown section headers (## Category) in habits.md AND labels
// in the injection block. Unsanitized, an LLM- or injection-controlled category could
// embed newlines / markdown / tags to inject structure. Categories are short labels,
// so we strip aggressively. Same full-transform fixed-point design as rulePass:
// the structural char strip can join tokens into a fresh keyword (removing "#"
// merges "act#as" into "actas"), so the whole transform is iterated to idempotence.
// codeql[js/incomplete-multi-character-sanitization] - same ordering and fixed-point
// guarantee as rulePass; substitution values cannot form new dangerous sequences.
function categoryPass(x: string): string {
  x = x.replace(ZERO_WIDTH, '').replace(BIDI_CONTROLS, '');
  x = x.normalize('NFKC');
  x = foldHomoglyphs(x);
  x = x.replace(CONTROL_CHARS, '');
  x = x.replace(UNICODE_SEPARATORS, ' ');
  x = x.replace(HTML_COMMENT, '');
  x = x.replace(INJECTION_KEYWORDS, ' ');
  x = x.replace(TAG_TOKEN, '');
  // Drop markdown-structural and delimiter chars that could inject headers or
  // break the "Category:" label format in the injection block.
  x = x.replace(/[#`*_<>[\]:]/g, '');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

export function sanitizeCategory(category: string): string {
  let s = (category ?? '').trim();
  if (s.length > MAX_CATEGORY_LENGTH * 2) s = s.slice(0, MAX_CATEGORY_LENGTH * 2);
  s = scrubToFixedPoint(s, categoryPass);
  if (!s) return 'Uncategorized';
  if (s.length > MAX_CATEGORY_LENGTH) {
    // Re-scrub after the hard slice: cutting mid-text can expose a trailing keyword.
    s = scrubToFixedPoint(s.slice(0, MAX_CATEGORY_LENGTH).trimEnd(), categoryPass);
    if (!s) return 'Uncategorized';
  }
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

  // Exact / containment pass. We normalise each stored rule once here and stash it
  // into `entries` AFTER the match checks, so a hit returns immediately (no wasted
  // work, identical to the original early-exit) while a full miss leaves every rule
  // normalised exactly once for the fuzzy pass to reuse, instead of normalising the
  // whole set a second time.
  const entries: Array<{ h: Habit; stored: string }> = [];
  for (const habits of Object.values(cats)) {
    for (const h of habits) {
      const stored = normalize(h.rule ?? '');
      if (normId && (stored.includes(normId) || normId.includes(stored))) return h;
      if (normRule && stored === normRule) return h;
      entries.push({ h, stored });
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

  for (const { h, stored } of entries) {
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
  fallbackLanguage?: string;
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

    // Block tombstoned rules at EVERY decision (create, reinforce, contradict), not
    // just create. A rejected rule that still lingers in habits.md must never be
    // silently reinforced or otherwise touched back to life.
    if (isTombstoned(ruleText)) continue;

    const existing = findHabit(cats, update.matched_habit_id ?? '', ruleText);

    // Resolve language to tag:
    let resolvedLanguage: string | undefined = undefined;
    if (update.language) {
      resolvedLanguage = update.language.toLowerCase().trim();
    } else if (options.fallbackLanguage) {
      resolvedLanguage = options.fallbackLanguage.toLowerCase().trim();
    } // else leave undefined (not tagged)

    if (decision === 'create') {
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
          ...(resolvedLanguage ? { languages: [resolvedLanguage] } : {}),
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
        if (resolvedLanguage) {
          const langs = new Set(existing.languages ?? []);
          langs.add(resolvedLanguage);
          existing.languages = Array.from(langs).sort();
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
        if (resolvedLanguage) {
          const langs = new Set(existing.languages ?? []);
          langs.add(resolvedLanguage);
          existing.languages = Array.from(langs).sort();
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
        if (resolvedLanguage) {
          const langs = new Set(existing.languages ?? []);
          langs.add(resolvedLanguage);
          existing.languages = Array.from(langs).sort();
        }
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
