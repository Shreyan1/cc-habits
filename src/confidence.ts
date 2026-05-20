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

// ── Confidence math helpers ────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number): number {
  return Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CAP, round2(n)));
}

// ── Rule normalization & sanitization ──────────────────────────────────────────

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
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// Maximum length for a single rule: bounds context window consumption and limits
// the blast radius of any injection that slips through the pattern filters.
const MAX_RULE_LENGTH = 500;

export function sanitizeRule(rule: string): string {
  let s = rule.trim();
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(INJECTION_KEYWORDS, '[redacted]');
  s = s.replace(URL_RE, '[url]');
  // Collapse repeated whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Hard cap: if after sanitization the rule is still abnormally long, truncate.
  if (s.length > MAX_RULE_LENGTH) s = s.slice(0, MAX_RULE_LENGTH).trimEnd();
  return s;
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
  return null;
}

// ── Confidence decay (B4) ──────────────────────────────────────────────────────

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

// ── Main update entrypoint ─────────────────────────────────────────────────────

export interface ApplyOptions {
  sessionId?: string;
  todayIso?: string;
}

export function applyUpdates(
  cats: HabitsMap,
  updates: RuleUpdate[],
  options: ApplyOptions = {},
): [number, number] {
  const today = options.todayIso ?? new Date().toISOString().slice(0, 10);
  const sessionId = options.sessionId ?? '';
  let newCount = 0;
  let updatedCount = 0;

  // B5: count contradictions in this batch up-front; if burst, double the decay.
  const contradictCount = updates.filter(u => (u.decision ?? '').toLowerCase() === 'contradict').length;
  const contradictMultiplier = contradictCount >= CONTRADICT_BURST_THRESHOLD ? 2 : 1;

  for (const update of updates) {
    const decision = (update.decision ?? 'skip').toLowerCase();
    if (decision === 'skip') continue;

    const category = (update.category ?? 'Uncategorized').trim();
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
      } else {
        existing.confidence = clamp(existing.confidence + REINFORCE_DELTA);
        existing.reinforcing = (existing.reinforcing ?? 0) + 1;
        if (sessionId && existing.last_session_id !== sessionId) {
          existing.sessions_seen = (existing.sessions_seen ?? 1) + 1;
          existing.last_session_id = sessionId;
        }
        existing.last_updated = today;
        updatedCount++;
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
      }
    } else if (decision === 'contradict') {
      if (existing !== null) {
        existing.confidence = clamp(
          existing.confidence - CONTRADICT_DELTA * contradictMultiplier,
        );
        existing.contradicting = (existing.contradicting ?? 0) + 1;
        existing.last_updated = today;
        updatedCount++;
      }
    }

    cats[category] = (cats[category] ?? []).filter(h => h.confidence >= PRUNE_THRESHOLD);
    if (cats[category].length === 0) delete cats[category];
  }

  return [newCount, updatedCount];
}

// ── Pending updates (A4) ───────────────────────────────────────────────────────

export function toPending(updates: RuleUpdate[]): PendingUpdate[] {
  const ts = new Date().toISOString();
  return updates
    .filter(u => (u.decision ?? '').toLowerCase() !== 'skip')
    .map(u => ({
      category: (u.category ?? 'Uncategorized').trim(),
      rule: sanitizeRule((u.rule ?? '').trim().replace(/\.$/, '')),
      decision: (u.decision ?? '').toLowerCase(),
      matched_habit_id: u.matched_habit_id,
      reasoning: u.reasoning,
      ts,
    }))
    .filter(u => u.rule);
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
