import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, readHabitsMd, parseHabits, writeHabitsMd, serialiseHabits,
  writeSnapshot, appendHistory, ensureDirs,
} from './storage';
import { buildDiff, redact, isNoise, detectLanguage } from './hook';
import { sanitizeFilePath } from './storage';
import { applyUpdates } from './confidence';
import { extractRules } from './extractor';
import type { Signal } from './storage';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_BOOTSTRAP_SIGNALS = 40;
const BOOTSTRAPPED_FILE = '.bootstrapped.json';

export interface BootstrapResult {
  sessionsFound: number;
  sessionsWithEdits: number;
  signalsExtracted: number;
  habitsLearned: number;
  habitsReinforced: number;
  categories: string[];
}

interface SessionFile {
  sessionId: string;
  filePath: string;
}

// Claude Code stores project sessions at ~/.claude/projects/<encoded-path>/
// where <encoded-path> is the absolute project directory with / replaced by -.
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

function bootstrappedPath(): string {
  return path.join(storagePaths.habitsDir, BOOTSTRAPPED_FILE);
}

function readBootstrapped(): Set<string> {
  const p = bootstrappedPath();
  if (!fs.existsSync(p)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    if (Array.isArray(data)) return new Set(data.filter((x): x is string => typeof x === 'string'));
  } catch { /* ignore */ }
  return new Set();
}

function writeBootstrapped(ids: string[]): void {
  const existing = readBootstrapped();
  ids.forEach(id => existing.add(id));
  ensureDirs();
  fs.writeFileSync(bootstrappedPath(), JSON.stringify([...existing], null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function discoverSessions(projectDir?: string): SessionFile[] {
  const cwd = projectDir ?? process.cwd();
  const encoded = encodeProjectPath(path.resolve(cwd));
  const sessionsDir = path.join(CLAUDE_PROJECTS_DIR, encoded);

  if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) return [];

  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      sessionId: f.replace('.jsonl', ''),
      filePath: path.join(sessionsDir, f),
    }));
}

export function extractSignalsFromTranscript(transcriptPath: string, sessionId: string): Signal[] {
  const signals: Signal[] = [];
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return [];
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj['type'] !== 'assistant') continue;

    const msg = obj['message'] as Record<string, unknown> | undefined;
    if (!msg) continue;
    const blocks = msg['content'] as unknown[];
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;

      const toolName = String(b['name'] ?? '');
      if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') continue;

      const toolInput = (b['input'] ?? {}) as Record<string, unknown>;
      const rawPath = String(toolInput['file_path'] ?? toolInput['path'] ?? '');
      const safePath = sanitizeFilePath(rawPath);

      let diff = buildDiff(toolName, safePath, toolInput);
      if (!diff || isNoise(diff)) continue;
      diff = redact(diff);

      const language = detectLanguage(safePath);
      const ts = String(obj['timestamp'] ?? new Date().toISOString());

      signals.push({
        ts,
        session_id: sessionId,
        type: 'edit',
        file: redact(safePath),
        diff,
        ...(language ? { language } : {}),
      });
    }
  }

  return signals;
}

export async function bootstrap(opts?: {
  projectDir?: string;
  maxSignals?: number;
}): Promise<BootstrapResult> {
  const sessions = discoverSessions(opts?.projectDir);
  const alreadyDone = readBootstrapped();
  const newSessions = sessions.filter(s => !alreadyDone.has(s.sessionId));

  const empty: BootstrapResult = {
    sessionsFound: sessions.length,
    sessionsWithEdits: 0,
    signalsExtracted: 0,
    habitsLearned: 0,
    habitsReinforced: 0,
    categories: [],
  };

  if (newSessions.length === 0) return empty;

  const allSignals: Signal[] = [];
  let sessionsWithEdits = 0;
  const processedIds: string[] = [];

  for (const session of newSessions) {
    const sigs = extractSignalsFromTranscript(session.filePath, session.sessionId);
    if (sigs.length > 0) sessionsWithEdits++;
    allSignals.push(...sigs);
    processedIds.push(session.sessionId);
  }

  const cap = opts?.maxSignals ?? MAX_BOOTSTRAP_SIGNALS;
  const capped = allSignals.length > cap ? allSignals.slice(-cap) : allSignals;

  if (capped.length < 3) {
    writeBootstrapped(processedIds);
    return { ...empty, sessionsFound: sessions.length, sessionsWithEdits, signalsExtracted: capped.length };
  }

  const habitsMd = readHabitsMd();
  const cats = parseHabits(habitsMd);

  const updates = await extractRules(capped, habitsMd);
  const [newCount, updatedCount] = applyUpdates(cats, updates, {
    sessionId: `bootstrap-${Date.now()}`,
  });

  // Graduate bootstrapped habits immediately if signals spanned 2+ sessions.
  // This is defensible: the patterns genuinely appeared across distinct sessions.
  const distinctSessions = new Set(capped.map(s => s.session_id)).size;
  if (distinctSessions >= 2) {
    for (const habits of Object.values(cats)) {
      for (const h of habits) {
        if (h.sessions_seen === 1 && h.last_session_id?.startsWith('bootstrap-')) {
          h.sessions_seen = Math.min(distinctSessions, 4);
        }
      }
    }
  }

  const serialised = serialiseHabits(cats);
  writeHabitsMd(serialised);
  writeSnapshot(cats);
  appendHistory({ ts: new Date().toISOString(), session_id: 'bootstrap', habits_md: serialised });
  writeBootstrapped(processedIds);

  return {
    sessionsFound: sessions.length,
    sessionsWithEdits,
    signalsExtracted: capped.length,
    habitsLearned: newCount,
    habitsReinforced: updatedCount,
    categories: [...new Set(Object.keys(cats))],
  };
}
