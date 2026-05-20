import { lookupProvenance, parseHabits, readHabitsMd, ProvenanceRef, Habit } from './storage';

export interface Explanation {
  rule: string;
  category: string;
  confidence: number;
  sessions_seen: number;
  reinforcing: number;
  contradicting: number;
  refs: ProvenanceRef[];
}

function fuzzyFindHabit(query: string): { category: string; habit: Habit } | null {
  const q = query.trim().toLowerCase();
  const cats = parseHabits(readHabitsMd());
  let best: { category: string; habit: Habit } | null = null;
  let bestScore = 0;
  for (const [category, habits] of Object.entries(cats)) {
    for (const h of habits) {
      const r = h.rule.toLowerCase();
      let score = 0;
      if (r === q) score = 100;
      else if (r.includes(q)) score = 50 + Math.min(50, q.length);
      else if (q.includes(r)) score = 30 + Math.min(50, r.length);
      if (score > bestScore) {
        bestScore = score;
        best = { category, habit: h };
      }
    }
  }
  return best;
}

export function explainHabit(query: string): Explanation | null {
  const match = fuzzyFindHabit(query);
  if (!match) return null;
  const refs = lookupProvenance(match.habit.rule);
  return {
    rule: match.habit.rule,
    category: match.category,
    confidence: match.habit.confidence,
    sessions_seen: match.habit.sessions_seen ?? 1,
    reinforcing: match.habit.reinforcing ?? 0,
    contradicting: match.habit.contradicting ?? 0,
    refs,
  };
}
