import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, readHabitsMd, parseHabits, writeHabitsMd, serialiseHabits,
  writeSnapshot, appendHistory, ensureDirs, getPaths, type StorageContext
} from './storage';
import { buildDiff, redact, isNoise, detectLanguage, buildDiffFromNormalized } from './hook';
import { sanitizeFilePath } from './storage';
import { applyUpdates } from './confidence';
import { extractRules } from './extractor';
import type { Signal } from './storage';
import { fromCodex } from './adapters/codex';
import { fromGemini } from './adapters/gemini';

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

export interface SessionFile {
  sessionId: string;
  filePath: string;
  tool: 'claude-code' | 'codex' | 'gemini' | 'kimi';
}

// Claude Code stores project sessions at ~/.claude/projects/<encoded-path>/
// where <encoded-path> is the absolute project directory with / replaced by -.
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

function bootstrappedPath(ctx?: StorageContext): string {
  return path.join(getPaths(ctx).habitsDir, BOOTSTRAPPED_FILE);
}

function readBootstrapped(ctx?: StorageContext): Set<string> {
  const p = bootstrappedPath(ctx);
  if (!fs.existsSync(p)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    if (Array.isArray(data)) return new Set(data.filter((x): x is string => typeof x === 'string'));
  } catch { /* ignore */ }
  return new Set();
}

function writeBootstrapped(ids: string[], ctx?: StorageContext): void {
  const existing = readBootstrapped(ctx);
  ids.forEach(id => existing.add(id));
  ensureDirs(ctx);
  fs.writeFileSync(bootstrappedPath(ctx), JSON.stringify([...existing], null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

function readFirstLine(filePath: string): string {
  const chunkSize = 65536; // 64KB
  const buffer = Buffer.alloc(chunkSize);
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, 0);
    const content = buffer.toString('utf-8', 0, bytesRead);
    const index = content.indexOf('\n');
    if (index !== -1) {
      return content.substring(0, index);
    }
    return content;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results.push(...findJsonlFiles(filePath));
      } else if (file.endsWith('.jsonl')) {
        results.push(filePath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function findWireJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results.push(...findWireJsonlFiles(filePath));
      } else if (file === 'wire.jsonl') {
        results.push(filePath);
      }
    }
  } catch {
    // ignore
  }
  return results;
}

function isProjectSubpath(targetCwd: string, projectDir: string): boolean {
  try {
    const resolvedCwd = path.resolve(targetCwd);
    const resolvedProj = path.resolve(projectDir);
    return resolvedCwd === resolvedProj || resolvedCwd.startsWith(resolvedProj + path.sep);
  } catch {
    return false;
  }
}

export function discoverSessions(projectDir?: string): SessionFile[] {
  const cwd = projectDir ?? process.cwd();
  const resolvedProj = path.resolve(cwd);
  const sessions: SessionFile[] = [];

  // 1. Claude Code
  const encoded = encodeProjectPath(resolvedProj);
  const claudeDir = path.join(CLAUDE_PROJECTS_DIR, encoded);
  if (fs.existsSync(claudeDir) && fs.statSync(claudeDir).isDirectory()) {
    try {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        sessions.push({
          sessionId: f.replace('.jsonl', ''),
          filePath: path.join(claudeDir, f),
          tool: 'claude-code',
        });
      }
    } catch { /* ignore */ }
  }

  // 2. Gemini CLI
  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  if (fs.existsSync(geminiTmpDir) && fs.statSync(geminiTmpDir).isDirectory()) {
    try {
      const subdirs = fs.readdirSync(geminiTmpDir);
      for (const dir of subdirs) {
        const subpath = path.join(geminiTmpDir, dir);
        if (!fs.statSync(subpath).isDirectory()) continue;
        const projectRootFile = path.join(subpath, '.project_root');
        if (!fs.existsSync(projectRootFile)) continue;
        const content = fs.readFileSync(projectRootFile, 'utf-8').trim();
        if (content && isProjectSubpath(content, resolvedProj)) {
          const chatsDir = path.join(subpath, 'chats');
          if (fs.existsSync(chatsDir) && fs.statSync(chatsDir).isDirectory()) {
            const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
            for (const f of files) {
              sessions.push({
                sessionId: f.replace('.jsonl', ''),
                filePath: path.join(chatsDir, f),
                tool: 'gemini',
              });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Codex CLI
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (fs.existsSync(codexSessionsDir) && fs.statSync(codexSessionsDir).isDirectory()) {
    try {
      const jsonlFiles = findJsonlFiles(codexSessionsDir);
      for (const filePath of jsonlFiles) {
        const firstLine = readFirstLine(filePath);
        if (!firstLine) continue;
        try {
          const obj = JSON.parse(firstLine);
          if (obj.type === 'session_meta' && obj.payload) {
            const sessionCwd = obj.payload.cwd;
            if (sessionCwd && isProjectSubpath(sessionCwd, resolvedProj)) {
              const baseName = path.basename(filePath);
              sessions.push({
                sessionId: baseName.replace('.jsonl', ''),
                filePath,
                tool: 'codex',
              });
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // 4. Kimi Code CLI
  const kimiDirs = [
    process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi'),
    process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code'),
  ];
  for (const kimiDir of [...new Set(kimiDirs)]) {
    const indexFile = path.join(kimiDir, 'session_index.jsonl');
    if (fs.existsSync(indexFile)) {
      try {
        const content = fs.readFileSync(indexFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            const workDir = obj.workDir ?? obj.work_dir ?? obj.cwd;
            const sessionId = obj.sessionId ?? obj.session_id;
            if (workDir && sessionId && isProjectSubpath(workDir, resolvedProj)) {
              let sessionDir = obj.sessionDir ?? obj.session_dir;
              if (sessionDir) {
                const resolvedSessionDir = path.isAbsolute(sessionDir) ? sessionDir : path.resolve(kimiDir, sessionDir);
                const wirePath = path.join(resolvedSessionDir, 'agents', 'main', 'wire.jsonl');
                if (fs.existsSync(wirePath)) {
                  sessions.push({
                    sessionId,
                    filePath: wirePath,
                    tool: 'kimi',
                  });
                }
              }
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    // Fallback: scan sessions/ directories directly if index is missing or doesn't have all entries
    const sessionsDir = path.join(kimiDir, 'sessions');
    if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
      try {
        const wireFiles = findWireJsonlFiles(sessionsDir);
        for (const wirePath of wireFiles) {
          const sessionDir = path.dirname(path.dirname(path.dirname(wirePath)));
          const statePath = path.join(sessionDir, 'state.json');
          if (fs.existsSync(statePath)) {
            try {
              const stateObj = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
              const workDir = stateObj.workDir ?? stateObj.work_dir ?? stateObj.cwd;
              if (workDir && isProjectSubpath(workDir, resolvedProj)) {
                const sessionId = path.basename(sessionDir);
                if (!sessions.some(s => s.sessionId === sessionId)) {
                  sessions.push({
                    sessionId,
                    filePath: wirePath,
                    tool: 'kimi',
                  });
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return sessions;
}

export function extractSignalsFromTranscript(
  transcriptPath: string,
  sessionId: string,
  tool: 'claude-code' | 'codex' | 'gemini' | 'kimi' = 'claude-code'
): Signal[] {
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

    if (tool === 'claude-code' || tool === 'kimi') {
      if (obj['type'] !== 'assistant') continue;

      const msg = obj['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;
      const blocks = msg['content'] as unknown[];
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;

        let toolName = String(b['name'] ?? '');
        if (toolName === 'WriteFile' || toolName === 'write_file') {
          toolName = 'Write';
        } else if (toolName === 'StrReplaceFile' || toolName === 'str_replace' || toolName === 'replace') {
          toolName = 'Edit';
        }

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
    } else if (tool === 'gemini') {
      if (obj['type'] === 'gemini' && Array.isArray(obj['toolCalls'])) {
        for (const call of obj['toolCalls']) {
          const toolName = String(call['name'] ?? '');
          if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'replace_file_content' && toolName !== 'modify_file') continue;

          const rawInput = {
            tool_name: toolName,
            tool_input: call['args'] ?? {},
            session_id: sessionId,
          };

          const norm = fromGemini(rawInput);
          const safePath = sanitizeFilePath(norm.filePath);
          if (!safePath) continue;

          let diff = buildDiffFromNormalized(norm);
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
    } else if (tool === 'codex') {
      const payload = obj['payload'] as Record<string, unknown> | undefined;
      const isFunctionCall = obj['type'] === 'function_call' || (obj['type'] === 'response_item' && payload?.['type'] === 'function_call');
      if (isFunctionCall) {
        const call = (obj['type'] === 'function_call' ? obj : payload) as Record<string, unknown>;
        const toolName = String(call['name'] ?? call['tool'] ?? '');
        if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_file_content' || toolName === 'modify_file' || toolName === 'create_file') {
          let args: Record<string, unknown> = {};
          try {
            const argsStr = String(call['arguments'] ?? '{}');
            args = JSON.parse(argsStr) as Record<string, unknown>;
          } catch {
            // ignore
          }

          const rawInput = {
            tool: toolName,
            tool_name: toolName,
            file_path: args['file_path'] ?? args['path'] ?? args['file'],
            content: args['content'],
            old_string: args['old_string'],
            new_string: args['new_string'],
            diff: args['diff'],
            session_id: sessionId
          };

          const norm = fromCodex(rawInput);
          const safePath = sanitizeFilePath(norm.filePath);
          if (!safePath) continue;

          let diff = buildDiffFromNormalized(norm);
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
    }
  }

  return signals;
}

export async function bootstrap(opts?: {
  projectDir?: string;
  maxSignals?: number;
  ctx?: StorageContext;
}): Promise<BootstrapResult> {
  const ctx = opts?.ctx;
  const sessions = discoverSessions(opts?.projectDir);
  const alreadyDone = readBootstrapped(ctx);
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
    const sigs = extractSignalsFromTranscript(session.filePath, session.sessionId, session.tool);
    if (sigs.length > 0) sessionsWithEdits++;
    allSignals.push(...sigs);
    processedIds.push(session.sessionId);
  }

  const cap = opts?.maxSignals ?? MAX_BOOTSTRAP_SIGNALS;
  const capped = allSignals.length > cap ? allSignals.slice(-cap) : allSignals;

  if (capped.length < 3) {
    writeBootstrapped(processedIds, ctx);
    return { ...empty, sessionsFound: sessions.length, sessionsWithEdits, signalsExtracted: capped.length };
  }

  const habitsMd = readHabitsMd(ctx);
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
  writeHabitsMd(serialised, ctx);
  writeSnapshot(cats, ctx);
  appendHistory({ ts: new Date().toISOString(), session_id: 'bootstrap', habits_md: serialised }, ctx);
  writeBootstrapped(processedIds, ctx);

  return {
    sessionsFound: sessions.length,
    sessionsWithEdits,
    signalsExtracted: capped.length,
    habitsLearned: newCount,
    habitsReinforced: updatedCount,
    categories: [...new Set(Object.keys(cats))],
  };
}
