import fs from 'fs';
import https from 'https';
import {
  readHabitsMd, parseHabits, serialiseHabits, writeHabitsMd, writeSnapshot,
  readMemoriesMd, parseMemories, serialiseMemories, writeMemoriesMd,
  HabitsMap, Habit, MemoryCandidate, applyMemoryUpdates,
} from './storage';
import { sanitizeRule } from './confidence';

// ── Profile bundle format ─────────────────────────────────────────────────────
//
// A portable profile is a single markdown file with an HTML-comment metadata
// header followed by marked sections. This lets it be shared as a GitHub Gist,
// a URL, or a raw file while remaining human-readable.
//
// Single-artifact (habits only):
//   <!-- cc-habits profile
//   version: <x.y.z>
//   exported: <ISO timestamp>
//   contains: habits
//   -->
//   <!-- BEGIN habits -->
//   ...habits.md content...
//   <!-- END habits -->
//
// Full bundle (habits + memories):
//   contains: habits,memories
//   ... plus a <!-- BEGIN memories --> section

const PROFILE_OPEN  = '<!-- cc-habits profile';
const PROFILE_CLOSE = '-->';

function sectionContent(text: string, name: string): string | null {
  const open  = `<!-- BEGIN ${name} -->`;
  const close = `<!-- END ${name} -->`;
  const start = text.indexOf(open);
  const end   = text.indexOf(close);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start + open.length, end).trim();
}

function isProfileBundle(text: string): boolean {
  return text.trimStart().startsWith(PROFILE_OPEN);
}

// ── Export ───────────────────────────────────────────────────────────────────

export interface ExportOpts {
  includeMemories?: boolean
  version: string
  outputPath?: string
}

export function buildProfile(opts: ExportOpts): string {
  const ts       = new Date().toISOString();
  const contains = opts.includeMemories ? 'habits,memories' : 'habits';

  const habitsMd  = readHabitsMd();
  const memoriesMd = opts.includeMemories ? readMemoriesMd() : null;

  const lines: string[] = [
    `${PROFILE_OPEN}`,
    `version: ${opts.version}`,
    `exported: ${ts}`,
    `contains: ${contains}`,
    PROFILE_CLOSE,
    '',
    '<!-- BEGIN habits -->',
    habitsMd.trim(),
    '<!-- END habits -->',
  ];

  if (memoriesMd !== null) {
    lines.push(
      '',
      '<!-- BEGIN memories -->',
      memoriesMd.trim(),
      '<!-- END memories -->',
    );
  }

  return lines.join('\n') + '\n';
}

export function exportProfile(opts: ExportOpts): string {
  const content = buildProfile(opts);
  if (opts.outputPath) {
    fs.writeFileSync(opts.outputPath, content, { encoding: 'utf-8', mode: 0o600 });
  }
  return content;
}

// Legacy single-artifact export kept for backward compat with tests and callers
// that import exportHabits directly. Internally delegates to exportProfile.
export function exportHabits(outputPath?: string, version = 'unknown'): string {
  return exportProfile({ version, outputPath });
}

// ── Import ───────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().replace(/\.$/, '').toLowerCase();
}

interface ImportResult {
  added: number
  merged: number
  skipped: number
  memoriesImported?: number
}

function mergeHabitsFromMd(incomingMd: string): Omit<ImportResult, 'memoriesImported'> {
  const incoming = parseHabits(incomingMd);
  const localMd  = readHabitsMd();
  const local    = parseHabits(localMd);

  const localByRule = new Map<string, { category: string; habit: Habit }>();
  for (const [cat, habits] of Object.entries(local)) {
    for (const h of habits) localByRule.set(normalize(h.rule), { category: cat, habit: h });
  }

  let added  = 0;
  let merged = 0;

  for (const [cat, habits] of Object.entries(incoming)) {
    for (const inc of habits) {
      // SEC: sanitize imported rule text before writing. An imported file could
      // carry prompt-injection tokens that would be amplified by the
      // UserPromptSubmit hook into every future Claude session.
      const safeRule = sanitizeRule(inc.rule ?? '');
      if (!safeRule) continue;
      const incSafe = { ...inc, rule: safeRule };
      const key     = normalize(safeRule);
      const existing = localByRule.get(key);
      if (!existing) {
        if (!local[cat]) local[cat] = [];
        local[cat].push(incSafe);
        added++;
      } else {
        existing.habit.confidence    = Math.max(existing.habit.confidence, incSafe.confidence);
        existing.habit.reinforcing   = (existing.habit.reinforcing ?? 0) + (incSafe.reinforcing ?? 0);
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
  return { added, merged, skipped: 0 };
}

export function importHabits(incomingContent: string): ImportResult {
  if (isProfileBundle(incomingContent)) {
    const habitsMd   = sectionContent(incomingContent, 'habits');
    const memoriesMd = sectionContent(incomingContent, 'memories');

    const habitResult = habitsMd ? mergeHabitsFromMd(habitsMd) : { added: 0, merged: 0, skipped: 0 };

    let memoriesImported = 0;
    if (memoriesMd) {
      const incomingSections = parseMemories(memoriesMd);
      const localMd          = readMemoriesMd();
      const localSections    = parseMemories(localMd);
      // Build candidates for memories not already present (matched by normalised text).
      const candidates: MemoryCandidate[] = [];
      for (const [section, memories] of Object.entries(incomingSections)) {
        const localTexts = new Set((localSections[section] ?? []).map(m => normalize(m.text ?? '')));
        for (const m of memories) {
          if (!localTexts.has(normalize(m.text ?? ''))) {
            candidates.push({ section, text: m.text ?? '', trigger: m.trigger ?? [], correction: m.correction ?? '' });
          }
        }
      }
      memoriesImported = applyMemoryUpdates(candidates);
    }

    return { ...habitResult, memoriesImported };
  }

  // No profile header — treat the entire content as a plain habits.md (backward compat).
  return mergeHabitsFromMd(incomingContent);
}

// Fetch a profile from an https:// URL. Only https is accepted. Returns the
// raw text content for piping through importHabits.
export function fetchProfile(url: string): Promise<string> {
  if (!url.startsWith('https://')) {
    return Promise.reject(new Error('only https:// URLs are supported for import'));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cc-habits' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect.
        fetchProfile(res.headers.location).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`fetch failed: HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('import request timed out')); });
  });
}

export type { HabitsMap };
