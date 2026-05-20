import { readHistory, parseHabits, Habit } from './storage';

export interface HabitDiff {
  added: Array<{ category: string; habit: Habit }>;
  removed: Array<{ category: string; habit: Habit }>;
  changed: Array<{ category: string; rule: string; from: number; to: number }>;
  fromTs: string;
  toTs: string;
}

function normalize(s: string): string {
  return s.trim().replace(/\.$/, '').toLowerCase();
}

function indexByRule(md: string): Map<string, { category: string; habit: Habit }> {
  const cats = parseHabits(md);
  const out = new Map<string, { category: string; habit: Habit }>();
  for (const [category, habits] of Object.entries(cats)) {
    for (const h of habits) out.set(normalize(h.rule), { category, habit: h });
  }
  return out;
}

// Diff between two history snapshots. If `since` is undefined, compares the
// latest snapshot to the one immediately before it.
export function computeDiff(since?: number): HabitDiff | null {
  const history = readHistory();
  if (history.length < 2) return null;

  let oldIdx: number;
  let newIdx = history.length - 1;
  if (since && since > 0 && since < history.length) {
    oldIdx = history.length - 1 - since;
  } else {
    oldIdx = history.length - 2;
  }
  if (oldIdx < 0) oldIdx = 0;
  if (oldIdx === newIdx) return null;

  const oldIdx2: Map<string, { category: string; habit: Habit }> = indexByRule(history[oldIdx].habits_md);
  const newIdx2: Map<string, { category: string; habit: Habit }> = indexByRule(history[newIdx].habits_md);

  const added: HabitDiff['added'] = [];
  const removed: HabitDiff['removed'] = [];
  const changed: HabitDiff['changed'] = [];

  for (const [key, entry] of newIdx2) {
    if (!oldIdx2.has(key)) {
      added.push(entry);
    } else {
      const prev = oldIdx2.get(key)!;
      if (Math.abs(prev.habit.confidence - entry.habit.confidence) > 0.005) {
        changed.push({
          category: entry.category,
          rule: entry.habit.rule,
          from: prev.habit.confidence,
          to: entry.habit.confidence,
        });
      }
    }
  }
  for (const [key, entry] of oldIdx2) {
    if (!newIdx2.has(key)) removed.push(entry);
  }

  return {
    added, removed, changed,
    fromTs: history[oldIdx].ts,
    toTs: history[newIdx].ts,
  };
}
