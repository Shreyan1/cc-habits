import fs from 'fs';
import https from 'https';
import {
  readHabitsMd, parseHabits, serialiseHabits, writeHabitsMd, writeSnapshot,
  readMemoriesMd, parseMemories, serialiseMemories, writeMemoriesMd,
  HabitsMap, Habit, MemoryCandidate, applyMemoryUpdates,
  isTombstoned, getMachineId,
} from './storage';
import { sanitizeRule } from './confidence';
import { redact } from './redact';

// ── Profile bundle format ─────────────────────────────────────────────────────
//
// A portable profile is a single markdown file with an HTML-comment metadata
// header followed by marked sections. This lets it be shared as a GitHub Gist,
// a URL, or a raw file while remaining human-readable.
//
// Full bundle (the default; memories are omitted when empty or --habits-only):
//   <!-- cc-habits profile
//   version: <x.y.z>
//   exported: <ISO timestamp>
//   contains: habits,memories
//   origin: <machine uuid>
//   -->
//   <promo line>
//   <!-- BEGIN habits -->
//   ...habits.md content...
//   <!-- END habits -->
//   <!-- BEGIN memories -->
//   ...memories.md content...
//   <!-- END memories -->

const PROFILE_OPEN  = '<!-- cc-habits profile';
const PROFILE_CLOSE = '-->';

// One visible line under the envelope so anyone opening a shared bundle (a
// gist, a Slack attachment) knows what produced it and where to get their own.
// It sits outside the BEGIN/END sections, so import ignores it entirely.
const PROMO_LINE = '> Coding habits learned automatically by [cc-habits](https://github.com/Shreyan1/cc-habits), the tool-agnostic memory layer for AI coding agents. Import with `cch import <this file>`.';

// Import safety limits for URL fetches: a profile is a small markdown file, so
// anything past these bounds is either a mistake or a hostile endpoint.
const MAX_PROFILE_BYTES = 1024 * 1024; // 1 MB
const MAX_REDIRECTS = 3;

// Parse the `key: value` lines of the profile envelope. Returns an empty map
// for non-bundle content; unknown keys are carried through harmlessly.
function parseProfileHeader(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isProfileBundle(text)) return out;
  const start = text.indexOf(PROFILE_OPEN);
  const end = text.indexOf(PROFILE_CLOSE, start);
  if (end === -1) return out;
  for (const line of text.slice(start + PROFILE_OPEN.length, end).split('\n')) {
    const m = /^\s*([a-z-]+):\s*(.+?)\s*$/.exec(line);
    if (m && m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

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
  // When true, the memories section is left out. The default is the full
  // bundle: one complete shareable file is the least surprising `cch export`.
  habitsOnly?: boolean
  version: string
  outputPath?: string
}

export function buildProfile(opts: ExportOpts): string {
  const ts = new Date().toISOString();

  const habitsMd = redact(readHabitsMd());
  // Memories ride along by default, but only when there is at least one to
  // share; an empty section would just be noise in the bundle.
  const rawMemories = opts.habitsOnly ? null : redact(readMemoriesMd());
  const memoriesMd = rawMemories !== null
    && Object.values(parseMemories(rawMemories)).some(list => list.length > 0)
    ? rawMemories
    : null;
  const contains = memoriesMd !== null ? 'habits,memories' : 'habits';

  // The origin id lets the importing side recognise this machine's own bundle
  // and trust its habit history. It is a random UUID, never derived from PII.
  const origin = getMachineId();

  const lines: string[] = [
    `${PROFILE_OPEN}`,
    `version: ${opts.version}`,
    `exported: ${ts}`,
    `contains: ${contains}`,
    ...(origin ? [`origin: ${origin}`] : []),
    PROFILE_CLOSE,
    '',
    PROMO_LINE,
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
// that import exportHabits directly. Habits only, as the name promises, even
// now that exportProfile bundles memories by default.
export function exportHabits(outputPath?: string, version = 'unknown'): string {
  return exportProfile({ version, outputPath, habitsOnly: true });
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

export interface ImportOpts {
  // When true, the incoming file's habit history (sessions_seen) is trusted
  // verbatim, so already-graduated habits stay graduated. When false, every
  // incoming habit re-earns graduation locally: it lands (or stays) in the
  // Learning section until seen in 2 sessions on this machine. Defaults to
  // auto-detection: trusted only when the bundle's origin id matches this
  // machine's own id (i.e. it is this machine's own export).
  trusted?: boolean
}

function mergeHabitsFromMd(incomingMd: string, trusted: boolean): Omit<ImportResult, 'memoriesImported'> {
  const incoming = parseHabits(incomingMd);
  const localMd  = readHabitsMd();
  const local    = parseHabits(localMd);

  const localByRule = new Map<string, { category: string; habit: Habit }>();
  for (const [cat, habits] of Object.entries(local)) {
    for (const h of habits) localByRule.set(normalize(h.rule), { category: cat, habit: h });
  }

  let added   = 0;
  let merged  = 0;
  let skipped = 0;

  for (const [cat, habits] of Object.entries(incoming)) {
    for (const inc of habits) {
      // SEC: sanitize imported rule text before writing. An imported file could
      // carry prompt-injection tokens that would be amplified by the
      // UserPromptSubmit hook into every future Claude session.
      const safeRule = sanitizeRule(inc.rule ?? '');
      if (!safeRule) continue;
      // SEC: a rule the user explicitly deleted must never come back through an
      // import. This mirrors the isTombstoned gate every other habits.md write
      // path applies (confidence.ts applyUpdates).
      if (isTombstoned(safeRule)) {
        skipped++;
        continue;
      }
      // Untrusted bundles cannot vouch for their own session history: clamp
      // sessions_seen so the habit re-earns graduation on this machine instead
      // of injecting immediately with a claimed count.
      const incSafe = {
        ...inc,
        rule: safeRule,
        sessions_seen: trusted ? (inc.sessions_seen ?? 1) : 1,
      };
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
  return { added, merged, skipped };
}

// True when the bundle carries an origin id that matches this machine's own,
// i.e. the file is this machine's own earlier export. Fail-closed: a missing
// origin, a foreign origin, or an unreadable local id all mean "not own".
export function isOwnBundle(incomingContent: string): boolean {
  const origin = parseProfileHeader(incomingContent)['origin'];
  if (!origin) return false;
  const localId = getMachineId();
  return localId !== '' && origin === localId;
}

export function importHabits(incomingContent: string, opts?: ImportOpts): ImportResult {
  const trusted = opts?.trusted ?? isOwnBundle(incomingContent);

  if (isProfileBundle(incomingContent)) {
    const habitsMd   = sectionContent(incomingContent, 'habits');
    const memoriesMd = sectionContent(incomingContent, 'memories');

    const habitResult = habitsMd ? mergeHabitsFromMd(habitsMd, trusted) : { added: 0, merged: 0, skipped: 0 };

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

  // No profile header, treat the entire content as a plain habits.md (backward compat).
  return mergeHabitsFromMd(incomingContent, trusted);
}

// Fetch a profile from an https:// URL. Only https is accepted; redirects are
// followed up to MAX_REDIRECTS deep and the response body is capped at
// MAX_PROFILE_BYTES, so a hostile or misconfigured endpoint can neither loop
// nor exhaust memory. Returns the raw text content for piping through importHabits.
export function fetchProfile(url: string, redirectDepth = 0): Promise<string> {
  if (!url.startsWith('https://')) {
    return Promise.reject(new Error('only https:// URLs are supported for import'));
  }
  if (redirectDepth > MAX_REDIRECTS) {
    return Promise.reject(new Error(`too many redirects (limit ${MAX_REDIRECTS})`));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cc-habits' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // discard this body before following
        fetchProfile(res.headers.location, redirectDepth + 1).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`fetch failed: HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_PROFILE_BYTES) {
          req.destroy(new Error(`profile too large (limit ${MAX_PROFILE_BYTES} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('import request timed out')); });
  });
}

export type { HabitsMap };
