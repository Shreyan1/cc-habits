import fs from 'fs';
import {
  readHabitsMd, parseHabits, serialiseHabits, writeHabitsMd, writeSnapshot,
  HabitsMap, Habit,
} from './storage';
import { sanitizeRule } from './confidence';

// Export the current habits.md to a portable single-file form. The format is
// the same as habits.md; the wrapper exists for future format evolution.
export function exportHabits(outputPath?: string): string {
  const md = readHabitsMd();
  if (outputPath) {
    fs.writeFileSync(outputPath, md, { encoding: 'utf-8', mode: 0o600 });
  }
  return md;
}

function normalize(s: string): string {
  return s.trim().replace(/\.$/, '').toLowerCase();
}

interface ImportResult {
  added: number;
  merged: number;
  skipped: number;
}

// Merge incoming habits into local. Strategy:
//   - new rule  → added
//   - existing  → merged: take MAX confidence, SUM signal counts, MAX sessions_seen,
//                 EARLIEST first_learned, LATEST last_updated.
// The user's local file always wins on tombstones (the next Stop will respect them).
export function importHabits(incomingMd: string): ImportResult {
  const incoming = parseHabits(incomingMd);
  const localMd = readHabitsMd();
  const local = parseHabits(localMd);

  // Build a lookup keyed by normalized rule, regardless of category.
  const localByRule = new Map<string, { category: string; habit: Habit }>();
  for (const [cat, habits] of Object.entries(local)) {
    for (const h of habits) localByRule.set(normalize(h.rule), { category: cat, habit: h });
  }

  let added = 0;
  let merged = 0;
  const skipped = 0;

  for (const [cat, habits] of Object.entries(incoming)) {
    for (const inc of habits) {
      // SEC: sanitize imported rule text before writing to habits.md. An imported
      // file could contain prompt-injection tokens that would be amplified by the
      // UserPromptSubmit hook into every Claude session.
      const safeRule = sanitizeRule(inc.rule ?? '');
      if (!safeRule) continue;
      const incSafe = { ...inc, rule: safeRule };
      const key = normalize(safeRule);
      const existing = localByRule.get(key);
      if (!existing) {
        if (!local[cat]) local[cat] = [];
        local[cat].push(incSafe);
        added++;
      } else {
        // Merge: take stronger signals.
        existing.habit.confidence = Math.max(existing.habit.confidence, incSafe.confidence);
        existing.habit.reinforcing = (existing.habit.reinforcing ?? 0) + (incSafe.reinforcing ?? 0);
        existing.habit.contradicting = (existing.habit.contradicting ?? 0) + (incSafe.contradicting ?? 0);
        existing.habit.sessions_seen = Math.max(
          existing.habit.sessions_seen ?? 1,
          incSafe.sessions_seen ?? 1,
        );
        if (incSafe.first_learned && (!existing.habit.first_learned || incSafe.first_learned < existing.habit.first_learned)) {
          existing.habit.first_learned = incSafe.first_learned;
        }
        if (incSafe.last_updated && (!existing.habit.last_updated || incSafe.last_updated > existing.habit.last_updated)) {
          existing.habit.last_updated = incSafe.last_updated;
        }
        if (incSafe.languages && incSafe.languages.length > 0) {
          const set = new Set([...(existing.habit.languages ?? []), ...incSafe.languages]);
          existing.habit.languages = Array.from(set).sort();
        }
        merged++;
      }
    }
  }

  writeHabitsMd(serialiseHabits(local));
  writeSnapshot(local);

  return { added, merged, skipped };
}

export type { HabitsMap };
